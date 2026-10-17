import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { SapWebAuthenticator } from '@marianfoo/sap-mcp-auth';
import { loginForDocumentAttachments } from '../dist/document-attachment-auth.js';

const user = 'synthetic-user', password = 'synthetic-password';
const config = { authMethod: 'password', sapUsername: user, sapPassword: password,
  pfxPath: '', pfxPassphrase: '', headful: false, mfaTimeout: 300, maxJwtAgeH: 1 };

async function browserFixture(t, { interactive = false, cancel = false } = {}) {
  let browser, temporary, requestedHeadless;
  const posted = [];
  let cancellationReached = false;
  const original = SapWebAuthenticator.prototype.ensureSession;
  t.mock.method(SapWebAuthenticator.prototype, 'ensureSession', function () {
    temporary = dirname(this.config.tokenCacheFile); return original.call(this);
  });
  t.mock.method(SapWebAuthenticator.prototype, 'launchBrowser', async headless => {
    requestedHeadless = headless;
    browser = await chromium.launch({ headless: true });
    const create = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const state = typeof options.storageState === 'string'
        ? JSON.parse(await readFile(options.storageState, 'utf8')) : options.storageState;
      assert.deepEqual(state, { cookies: [], origins: [] });
      const context = await create({ ...options, offline: true });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname === 'documents.support.sap.com') {
          if (url.pathname === '/done') return route.fulfill({ contentType: 'text/html', headers: { 'Set-Cookie': 'document-session=synthetic; Secure; HttpOnly; Path=/' }, body: '<title>Documents</title>Signed in' });
          return route.fulfill({ contentType: 'text/html', headers: { 'com.sap.cloud.security.login': 'login-request' }, body: '<script>setTimeout(()=>location.href="https://authn.hana.ondemand.com/saml2/sp/mds",50)</script>' });
        }
        if (url.hostname === 'authn.hana.ondemand.com') return route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(()=>location.href="https://accounts.sap.com/login",50)</script>' });
        assert.equal(url.origin, 'https://accounts.sap.com', 'fixtures never contact another origin');
        if (cancel) {
          await route.fulfill({ contentType: 'text/html', body: '<title>Sign In</title>' });
          cancellationReached = true;
          setTimeout(() => browser.close(), 50); return;
        }
        if (interactive) return route.fulfill({ contentType: 'text/html', body: '<title>Sign In</title><script>setTimeout(()=>location.href="https://documents.support.sap.com/done",150)</script>' });
        if (request.method() === 'POST') {
          posted.push(new URLSearchParams(request.postData()));
          return route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://documents.support.sap.com/done"</script>' });
        }
        return route.fulfill({ contentType: 'text/html', body: '<title>Sign In</title><form method="post"><input id="j_username" name="j_username"><input id="j_password" name="j_password" type="password"><button id="logOnFormSubmit">Sign in</button></form>' });
      });
      return context;
    };
    return browser;
  });
  t.after(async () => { assert.equal(browser.isConnected(), false); await assert.rejects(access(temporary)); });
  return { posted, headless: () => requestedHeadless, cancelled: () => cancellationReached };
}

test('document helper completes guarded password login and closes its real browser', { timeout: 15000 }, async t => {
  const f = await browserFixture(t);
  const cookies = await loginForDocumentAttachments(config);
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].get('j_username'), user); assert.equal(f.posted[0].get('j_password'), password);
  assert.deepEqual(cookies.map(c => c.domain), ['documents.support.sap.com']);
});

test('HEADFUL without stored credentials supports manual document sign-in', { timeout: 10000 }, async t => {
  const f = await browserFixture(t, { interactive: true });
  const cookies = await loginForDocumentAttachments({ ...config, authMethod: 'auto', sapUsername: undefined, sapPassword: undefined, headful: true, mfaTimeout: 1000 });
  assert.equal(f.headless(), false); assert.equal(f.posted.length, 0); assert.equal(cookies[0].name, 'document-session');
});

test('closing the document login window cleans the browser and private state', { timeout: 10000 }, async t => {
  const f = await browserFixture(t, { cancel: true });
  await assert.rejects(loginForDocumentAttachments(config));
  assert.equal(f.cancelled(), true, 'the test must reach the intended cancellation');
});
