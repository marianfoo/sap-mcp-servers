import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { downloadAttachment } from '../dist/attachment-download.js';

const origin = 'https://documents.support.sap.com';
const cookie = (name, domain, path = '/') => ({ name, value: 'synthetic', domain, path,
  expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' });

// Keep real sockets, streaming, aborts and redirects; only map the HTTPS request
// to a local HTTP fixture. No DNS lookup or request reaches SAP.
async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  t.mock.method(https, 'request', (url, options, callback) => {
    calls.push({ url: url.toString(), options });
    assert.notEqual(options.rejectUnauthorized, false, 'TLS verification must stay enabled');
    return http.request(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, options, callback);
  });
  return calls;
}

test('downloads bytes, restores scoped cookies and reads an encoded filename', async t => {
  const calls = await fixture(t, (req, res) => {
    assert.match(req.headers.cookie, /session=synthetic/);
    assert.doesNotMatch(req.headers.cookie, /wrongHost|wrongPath|expired/);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename=wrong.htm; filename*=UTF-8''test%20note.pdf" });
    res.end('%PDF synthetic');
  });
  const result = await downloadAttachment(`${origin}/file`, { cookies: [
    cookie('session', 'documents.support.sap.com'), cookie('wrongHost', 'me.sap.com'),
    cookie('wrongPath', 'documents.support.sap.com', '/private'),
    { ...cookie('expired', 'documents.support.sap.com'), expires: 1 }
  ], pfx: Buffer.from('synthetic certificate'), passphrase: 'synthetic passphrase' });
  assert.equal(result.body.toString(), '%PDF synthetic');
  assert.equal(result.bytes, result.body.length);
  assert.equal(result.suggestedFilename, 'test note.pdf');
  assert.equal(calls[0].options.pfx.toString(), 'synthetic certificate');
});

test('checks each redirect and scopes cookies on the next SAP host', async t => {
  const calls = await fixture(t, (req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: 'https://userapps.support.sap.com/file',
        'Set-Cookie': 'redirect-session=new; Domain=support.sap.com; Path=/; Secure' });
      return res.end();
    }
    assert.doesNotMatch(req.headers.cookie, /hostOnly/);
    assert.match(req.headers.cookie, /shared=synthetic/);
    assert.match(req.headers.cookie, /redirect-session=new/);
    res.end('file');
  });
  assert.equal((await downloadAttachment(`${origin}/start`, { cookies: [
    cookie('hostOnly', 'documents.support.sap.com'), cookie('shared', '.support.sap.com')
  ] })).body.toString(), 'file');
  assert.equal(calls.length, 2);
});

for (const url of ['http://documents.support.sap.com/file', 'https://example.com/file',
  'https://documents.support.sap.com:8443/file', 'https://user:pass@documents.support.sap.com/file', 'not-a-url']) {
  test(`rejects an unsafe initial URL before making a request: ${url}`, async t => {
    const calls = await fixture(t, (_req, res) => res.end('must not be reached'));
    await assert.rejects(downloadAttachment(url, {}));
    assert.equal(calls.length, 0);
  });
}

for (const location of ['https://example.com/file', 'http://me.sap.com/file',
  'https://me.sap.com:8443/file', 'https://user:pass@me.sap.com/file', 'https://accounts.sap.com/saml2/idp/sso']) {
  test(`does not follow an unsafe or login redirect: ${location}`, async t => {
    const calls = await fixture(t, (_req, res) => { res.writeHead(302, { Location: location }); res.end(); });
    await assert.rejects(downloadAttachment(`${origin}/start`, {}), /Refusing|HTTPS|sign-in required/);
    assert.equal(calls.length, 1);
  });
}

test('limits redirect loops', async t => {
  const calls = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); });
  await assert.rejects(downloadAttachment(`${origin}/start`, {}), /redirect limit/);
  assert.equal(calls.length, 6);
});

for (const status of [401, 403]) {
  test(`reports HTTP ${status} as an expired or unauthorized session`, async t => {
    await fixture(t, (_req, res) => { res.writeHead(status); res.end(); });
    await assert.rejects(downloadAttachment(`${origin}/file`, {}), /sign-in required|access denied/);
  });
}

test('never accepts a successful HTML login response as a file', async t => {
  await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><script>document.cookie="fragmentAfterLogin=x";</script></html>'); });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}), /sign-in required|access denied/);
});

test('rejects a large Content-Length before waiting for the body', { timeout: 2000 }, async t => {
  await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': '1000' }); res.flushHeaders(); });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}, { maxBytes: 32 }), /byte limit/);
});

test('enforces the size limit during chunked transfers', async t => {
  await fixture(t, (_req, res) => { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.write('a'.repeat(16)); res.end('b'.repeat(32)); });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}, { maxBytes: 32 }), /byte limit/);
});

test('requests identity encoding and rejects unexpected HTTP compression', async t => {
  let encoding;
  await fixture(t, (req, res) => {
    encoding = req.headers['accept-encoding'];
    res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end('unexpected compressed data');
  });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}), /Unsupported attachment encoding: gzip/);
  assert.equal(encoding, 'identity');
});

test('rejects empty and truncated downloads', async t => {
  await fixture(t, (req, res) => {
    if (req.url === '/empty') return res.end();
    res.writeHead(200, { 'Content-Length': '1000' }); res.write('short');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(downloadAttachment(`${origin}/empty`, {}), /empty/);
  await assert.rejects(downloadAttachment(`${origin}/truncated`, {}));
});

test('aborts a stalled download within the configured timeout', { timeout: 2000 }, async t => {
  await fixture(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); res.write('partial'); });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}, { timeoutMs: 50 }), /abort/i);
});

test('a later download uses the new credentials rather than a retained request context', async t => {
  const calls = await fixture(t, (_req, res) => res.end('file'));
  await downloadAttachment(`${origin}/file`, { cookies: [cookie('old', 'documents.support.sap.com')] });
  await downloadAttachment(`${origin}/file`, { cookies: [cookie('fresh', 'documents.support.sap.com')] });
  assert.equal(calls[0].options.headers.Cookie, 'old=synthetic');
  assert.equal(calls[1].options.headers.Cookie, 'fresh=synthetic');
});

test('recognizes the documented SAP Neo login header even without familiar HTML markers', async t => {
  await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'com.sap.cloud.security.login': 'login-request' }); res.end('<form>Please sign in</form>'); });
  await assert.rejects(downloadAttachment(`${origin}/file`, {}), /sign-in required/);
});


test('other attachment hosts keep the existing Notes refresh signal for HTTP 403', async t => {
  await fixture(t, (_req, res) => { res.writeHead(403); res.end(); });
  await assert.rejects(downloadAttachment('https://userapps.support.sap.com/file', {}), /SESSION_EXPIRED/);
});
