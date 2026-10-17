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
