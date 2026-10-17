import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { request } from 'playwright';
import { validateNotesSession } from '../dist/session-validation.js';
import { createNotesAuthenticator } from '../dist/auth.js';

function mockService(t, { status = 200, type = 'application/json', payload = { d: { results: [] } }, body, networkError } = {}) {
  const calls = { disposed: 0, options: undefined, url: undefined, requestOptions: undefined };
  t.mock.method(request, 'newContext', async options => {
    calls.options = options;
    return {
      get: async (url, options) => {
        calls.url = url;
        calls.requestOptions = options;
        if (networkError) throw new Error(networkError);
        return { status: () => status, ok: () => status >= 200 && status < 300,
          headers: () => ({ 'content-type': type }), text: async () => body ?? JSON.stringify(payload) };
      },
      dispose: async () => { calls.disposed++; }
    };
  });
  return calls;
}

test('validates the protected Notes search API using the supplied cookies', async t => {
  const calls = mockService(t);
  assert.equal(await validateNotesSession('session=fresh'), true);
  assert.equal(calls.options.extraHTTPHeaders.Cookie, 'session=fresh');
  assert.equal(calls.options.storageState, undefined, 'must not reload stale cookies from disk');
  assert.equal(calls.options.timeout, 15000);
  assert.equal(calls.requestOptions.maxRedirects, 0);
  assert.equal(new URL(calls.url).origin, 'https://me.sap.com');
  assert.equal(new URL(calls.url).searchParams.get('$top'), '1');
  assert.equal(calls.disposed, 1);
});

test('validation preserves cookie domain and path scope with the real request client', async t => {
  let sentCookies;
  const server = http.createServer((req, res) => {
    sentCookies = req.headers.cookie;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"d":{"results":[]}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const newContext = request.newContext.bind(request);
  t.mock.method(request, 'newContext', async options => {
    const context = await newContext(options);
    const get = context.get.bind(context);
    context.get = (_url, options) => get(`http://127.0.0.1:${server.address().port}/search`, options);
    return context;
  });
  const base = { name: 'session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' };
  const cookies = [{ ...base, value: 'service' }, { ...base, value: 'identity-provider', domain: 'localhost' },
    { ...base, value: 'other-path', path: '/private' }, { ...base, name: 'expired', value: 'expired', expires: 1 }];
  assert.equal(await validateNotesSession(cookies.map(c => `${c.name}=${c.value}`).join('; '), cookies), true);
  assert.equal(sentCookies, 'session=service');
});

test('malformed cookie metadata is rejected before any network request', async t => {
  const newContext = request.newContext.bind(request);
  t.mock.method(request, 'newContext', async options => Object.assign(await newContext(options), {
    get: () => assert.fail('Malformed cookies must not cause a network request')
  }));
  assert.equal(await validateNotesSession('session=partial', [{ name: 'session', value: 'partial' }]), false);
});

for (const status of [301, 302, 307, 401, 403]) {
  test(`rejects a login redirect or auth failure (${status})`, async t => {
    const calls = mockService(t, { status });
    assert.equal(await validateNotesSession('session=old'), false);
    assert.equal(calls.disposed, 1);
  });
}

test('rejects HTTP 200 login HTML', async t => {
  mockService(t, { type: 'text/html; charset=utf-8' });
  assert.equal(await validateNotesSession('session=old'), false);
});

test('recognizes a login bootstrap even when its content type is misleading', async t => {
  mockService(t, { body: '<html><script>document.cookie="fragmentAfterLogin=x";</script></html>' });
  assert.equal(await validateNotesSession('session=old'), false);
});

for (const status of [429, 500, 503]) {
  test(`surfaces HTTP ${status} as a service failure`, async t => {
    const calls = mockService(t, { status });
    await assert.rejects(validateNotesSession('session=valid'), new RegExp(`HTTP ${status}`));
    assert.equal(calls.disposed, 1);
  });
}

test('rejects unexpected JSON and disposes the context after network failures', async t => {
  const calls = mockService(t, { payload: {} });
  await assert.rejects(validateNotesSession('session=valid'), /unexpected search response/);
  assert.equal(calls.disposed, 1);
  t.mock.restoreAll();
  const failed = mockService(t, { networkError: 'synthetic timeout' });
  await assert.rejects(validateNotesSession('session=valid'), /synthetic timeout/);
  assert.equal(failed.disposed, 1);
});

for (const cacheSource of ['token', 'shared']) {
  test(`Notes rejects partial-login cookies from the ${cacheSource} cache`, async t => {
    mockService(t, { type: 'text/html' });
    const dir = mkdtempSync(join(tmpdir(), 'notes-validation-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = { authMethod: 'auto', headful: false, maxJwtAgeH: 1,
      tokenCacheFile: join(dir, 'token.json'), ssoStorageStateFile: join(dir, 'state.json') };
    if (cacheSource === 'token') {
      writeFileSync(config.tokenCacheFile, JSON.stringify({ access_token: 'fragmentAfterLogin=partial', expiresAt: Date.now() + 3600000 }));
    } else {
      writeFileSync(config.ssoStorageStateFile, JSON.stringify({ cookies: [{ name: 'fragmentAfterLogin', value: 'partial',
        domain: 'me.sap.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }));
    }
    const auth = createNotesAuthenticator(config);
    await assert.rejects(auth.ensureSession(), /No authentication credentials configured/);
    await auth.destroy();
  });
}

test('an outage preserves a cached Notes session for the next attempt', async t => {
  mockService(t, { status: 503 });
  const dir = mkdtempSync(join(tmpdir(), 'notes-outage-'));
  const file = join(dir, 'token.json');
  const original = JSON.stringify({ access_token: 'session=valid', expiresAt: Date.now() + 3600000 });
  writeFileSync(file, original);
  const auth = createNotesAuthenticator({ authMethod: 'auto', maxJwtAgeH: 1, tokenCacheFile: file });
  t.after(async () => { await auth.destroy(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(auth.ensureSession(), /HTTP 503/);
  assert.equal(readFileSync(file, 'utf8'), original);
});
