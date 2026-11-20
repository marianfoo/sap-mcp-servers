import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SapWebAuthenticator } from '../dist/authenticator.js';

const logger = { warn() {}, error() {}, info() {}, debug() {} };
const cookie = { name: 'session', value: 'synthetic', domain: 'me.sap.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };

// Exercise Playwright's storage-state validation with Chromium. All browser requests are intercepted.
for (const [label, state] of Object.entries({ empty: '', malformed: '{', wrongShape: '{"cookies":{}}', badCookie: '{"cookies":[{}],"origins":[]}', rejectedLogin: JSON.stringify({ cookies: [cookie], origins: [] }) })) {
  const accepted = label !== 'rejectedLogin';
  test(accepted ? `recovers from ${label} shared state and saves only a validated login` : 'a rejected fresh login preserves the existing shared file', { timeout: 15000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'sap-auth-state-'));
    const stateFile = join(dir, 'state.json');
    writeFileSync(stateFile, state);
    const auth = new SapWebAuthenticator({
      authMethod: 'interactive', headful: true, mfaTimeout: 100, maxSessionAgeH: 1,
      sapLoginUrl: 'https://me.sap.com/home', ssoStorageStateFile: stateFile,
      tokenCacheFile: join(dir, 'token.json'), logger
    }, { serviceName: 'synthetic Notes', cookieScope: { type: 'all' }, validateSession: async token => accepted && token === 'session=synthetic' });
    t.after(async () => { await auth.destroy(); rmSync(dir, { recursive: true, force: true }); });
    auth.launchBrowser = async () => {
      const browser = await chromium.launch();
      const createContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await createContext({ ...options, offline: true });
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<title>Application</title>Signed in' }));
        await context.addCookies([cookie]);
        return context;
      };
      return browser;
    };
    if (!accepted) {
      await assert.rejects(auth.ensureSession(), /service still rejected the session/);
      assert.equal(readFileSync(stateFile, 'utf8'), state);
      assert.equal(existsSync(join(dir, 'token.json')), false);
      return;
    }
    const session = await auth.ensureSession();
    assert.equal(session.cookieHeader, 'session=synthetic');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).cookies[0].value, 'synthetic');
  });
}

for (const sharedLogin of [true, false]) {
  test(sharedLogin ? 'Roadmap visits its app after interactive SSO' : 'API Hub can sign in interactively in a clean context', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'sap-app-login-'));
    const appUrl = sharedLogin ? 'https://roadmaps.sap.com/board' : 'https://api.sap.com/api/salesorder/overview';
    const start = 'https://me.sap.com/home';
    const visited = [];
    const auth = new SapWebAuthenticator({
      authMethod: 'auto', headful: true, mfaTimeout: 5000, maxSessionAgeH: 1,
      sapLoginUrl: sharedLogin ? start : undefined,
      ssoStorageStateFile: sharedLogin ? join(dir, 'state.json') : undefined,
      tokenCacheFile: join(dir, 'token.json'), logger
    }, { serviceName: 'test service', appUrl, cookieScope: { type: 'url', url: appUrl },
      validateSession: async cookies => cookies === 'app=ready' });
    t.after(async () => { await auth.destroy(); rmSync(dir, { recursive: true, force: true }); });
    auth.launchBrowser = async () => {
      const browser = await chromium.launch();
      const create = browser.newContext.bind(browser);
      browser.newContext = async options => {
        if (!sharedLogin) assert.equal(options?.storageState, undefined);
        const context = await create(options);
        await context.route('**/*', async route => {
          if (route.request().isNavigationRequest()) visited.push(route.request().url());
          if (!sharedLogin) return route.fulfill({ contentType: 'text/html', body: '<title>Overview</title><script>setTimeout(() => { document.cookie = "app=ready; Path=/" }, 300)</script>' });
          if (route.request().url() === start) {
            return route.fulfill({ contentType: 'text/html', body: '<title>Log On</title><script>setTimeout(() => { document.title = "Welcome"; document.cookie = "idp=ready; Path=/" }, 200)</script>' });
          }
          assert.ok((await context.cookies(start)).some(cookie => cookie.name === 'idp'));
          return route.fulfill({ contentType: 'text/html', body: '<title>Signed in</title>',
            headers: { 'set-cookie': route.request().url() === appUrl ? 'app=ready; Path=/' : 'idp=ready; Path=/' } });
        });
        return context;
      };
      return browser;
    };
    assert.equal((await auth.ensureSession()).cookieHeader, 'app=ready');
    assert.equal(existsSync(join(dir, 'state.json')), sharedLogin);
    assert.deepEqual(visited, sharedLogin ? [start, appUrl] : [appUrl]);
  });
}
