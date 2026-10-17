import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SapWebAuthenticator } from '@marianfoo/sap-mcp-auth';
import { SapNotesApiClient } from '../dist/sap-notes-api.js';
import { loginForDocumentAttachments, saveDocumentCookies } from '../dist/document-attachment-auth.js';

const url = 'https://documents.support.sap.com/customerkba/file';
const cookie = (name, domain, value = 'synthetic') => ({ name, value, domain, path: '/',
  expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' });
const notesCookie = cookie('notes-session', 'me.sap.com');
const documentsCookie = cookie('documents-session', 'documents.support.sap.com', 'fresh');
const initial = { cookies: [notesCookie], origins: [{ origin: 'https://me.sap.com', localStorage: [{ name: 'keep', value: 'synthetic' }] }] };

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'documents-test-'));
  const sso = join(dir, 'sso.json');
  await writeFile(sso, JSON.stringify(initial));
  const config = { sapUsername: 'synthetic-user', sapPassword: 'synthetic-password', authMethod: 'password',
    ssoStorageStateFile: sso, tokenCacheFile: join(dir, 'notes-token-cache.json'), pfxPath: '', pfxPassphrase: '',
    headful: false, mfaTimeout: 100, maxJwtAgeH: 1 };
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req); handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.mock.method(https, 'request', (target, options, callback) => {
    assert.equal(target.hostname, 'documents.support.sap.com');
    assert.notEqual(options.rejectUnauthorized, false);
    return http.request(`http://127.0.0.1:${server.address().port}${target.pathname}`, options, callback);
  });
  let logins = 0, destroys = 0;
  const temporary = [];
  t.mock.method(SapWebAuthenticator.prototype, 'ensureSession', async function () {
    logins++; temporary.push(dirname(this.config.tokenCacheFile));
    assert.equal(this.profile.appUrl, 'https://documents.support.sap.com/customerkba/');
    assert.equal(this.config.sapLoginUrl, undefined);
    assert.notEqual(this.config.ssoStorageStateFile, sso);
    assert.deepEqual(JSON.parse(await readFile(this.config.ssoStorageStateFile, 'utf8')), { cookies: [], origins: [] });
    if (process.platform !== 'win32') assert.equal((await stat(this.config.ssoStorageStateFile)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(sso, 'utf8')), initial, 'real Notes session remains untouched during login');
    return { cookies: [documentsCookie, cookie('must-not-copy', 'accounts.sap.com')] };
  });
  t.mock.method(SapWebAuthenticator.prototype, 'destroy', async () => { destroys++; });
  const client = new SapNotesApiClient(config);
  t.after(async () => {
    await client.cleanup(); await new Promise(r => { server.close(r); server.closeAllConnections(); });
    for (const path of temporary) await assert.rejects(access(path));
    await rm(dir, { recursive: true, force: true });
  });
  return { config, client, requests, temporary, logins: () => logins, destroys: () => destroys };
}
function loginOrFile(req, res) {
  if (req.headers.cookie?.includes('documents-session=fresh')) { res.setHeader('Content-Type', 'application/pdf'); res.end('%PDF synthetic'); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<html><script>document.cookie="fragmentAfterLogin=x";</script></html>'); }
}

test('authenticates the document host once, preserves Notes, and reuses saved cookies after restart', async t => {
  const f = await fixture(t, loginOrFile);
  const result = await f.client.fetchAttachment(url, 'unused');
  assert.equal(result.body.toString(), '%PDF synthetic'); assert.equal(f.logins(), 1); assert.equal(f.destroys(), 1);
  const state = JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8'));
  assert.deepEqual(state.origins, initial.origins); assert.deepEqual(state.cookies, [notesCookie, documentsCookie]);
  if (process.platform !== 'win32') assert.equal((await stat(f.config.ssoStorageStateFile)).mode & 0o777, 0o600);
  await f.client.fetchAttachment(url, 'unused');
  const restarted = new SapNotesApiClient(f.config);
  await restarted.fetchAttachment(url, 'unused'); await restarted.cleanup();
  assert.equal(f.logins(), 1); assert.equal(f.requests.length, 4);
});

test('concurrent expired downloads share one document login', async t => {
  const f = await fixture(t, loginOrFile);
  await Promise.all([f.client.fetchAttachment(url, 'unused'), f.client.fetchAttachment(url, 'unused')]);
  assert.equal(f.logins(), 1); assert.equal(f.requests.length, 4);
});

test('a rejected Documents session is refreshed without discarding Notes cookies', async t => {
  const f = await fixture(t, loginOrFile);
  await writeFile(f.config.ssoStorageStateFile, JSON.stringify({ ...initial, cookies: [notesCookie, { ...documentsCookie, value: 'expired' }] }));
  // Real Notes state now includes the expired host cookie; keep the login stub focused on the result.
  t.mock.method(SapWebAuthenticator.prototype, 'ensureSession', async () => ({ cookies: [documentsCookie] }));
  assert.equal((await f.client.fetchAttachment(url, 'unused')).bytes, 14);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')).cookies, [notesCookie, documentsCookie]);
});

for (const status of [403, 429, 503]) {
  test(`HTTP ${status} fails without starting a browser login`, async t => {
    const f = await fixture(t, (_req, res) => { res.writeHead(status); res.end(); });
    await assert.rejects(f.client.fetchAttachment(url, 'unused'), new RegExp(String(status)));
    assert.equal(f.logins(), 0); assert.equal(f.requests.length, 1);
  });
}

test('an unsuccessful login ends after one attempt and does not save unverified cookies', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><script>document.cookie="fragmentAfterLogin=x";</script></html>'); });
  await assert.rejects(f.client.fetchAttachment(url, 'unused'), /still requires document sign-in after one login attempt/);
  assert.equal(f.logins(), 1); assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')), initial);
  await assert.rejects(f.client.fetchAttachment(url, 'unused'), /restart the server/);
  assert.equal(f.logins(), 1, 'a rejected sign-in must not submit the password again');
});

test('browser cancellation/timeout cleans temporary state and preserves Notes', async t => {
  const f = await fixture(t, loginOrFile);
  let path;
  t.mock.method(SapWebAuthenticator.prototype, 'ensureSession', async function () { path = dirname(this.config.tokenCacheFile); throw new Error('synthetic browser closed or timeout'); });
  await assert.rejects(f.client.fetchAttachment(url, 'unused'), /No further login was attempted/);
  await assert.rejects(access(path)); assert.equal(f.destroys(), 1); assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')), initial);
});

test('cookie persistence keeps changes made by another service during sign-in', async t => {
  const f = await fixture(t, loginOrFile);
  const other = cookie('roadmap-session', 'roadmaps.sap.com');
  await writeFile(f.config.ssoStorageStateFile, JSON.stringify({ ...initial, cookies: [notesCookie, other] }));
  await saveDocumentCookies(f.config.ssoStorageStateFile, [documentsCookie]);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')).cookies, [notesCookie, other, documentsCookie]);
});

test('a corrupt SSO file is not overwritten by persistence', async t => {
  const f = await fixture(t, loginOrFile); await writeFile(f.config.ssoStorageStateFile, 'not json');
  await saveDocumentCookies(f.config.ssoStorageStateFile, [documentsCookie]);
  assert.equal(await readFile(f.config.ssoStorageStateFile, 'utf8'), 'not json');
});

test('a document denied after successful sign-in retains its real access error', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.headers.cookie?.includes('documents-session=fresh')) { res.writeHead(403); res.end(); }
    else loginOrFile(req, res);
  });
  await assert.rejects(f.client.fetchAttachment(url, 'unused'), /access denied \(HTTP 403\)/);
  assert.equal(f.logins(), 1); assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')), initial);
});


test('a removed SSO file is recreated with only the verified Documents cookies', async t => {
  const f = await fixture(t, loginOrFile);
  await rm(f.config.ssoStorageStateFile);
  await saveDocumentCookies(f.config.ssoStorageStateFile, [documentsCookie]);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')), { cookies: [documentsCookie], origins: [] });
});

test('a read-only SSO file stays unchanged', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t, loginOrFile);
  await chmod(f.config.ssoStorageStateFile, 0o400);
  t.after(() => chmod(f.config.ssoStorageStateFile, 0o600).catch(() => {}));
  await saveDocumentCookies(f.config.ssoStorageStateFile, [documentsCookie]);
  assert.deepEqual(JSON.parse(await readFile(f.config.ssoStorageStateFile, 'utf8')), initial);
});
