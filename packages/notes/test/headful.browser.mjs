import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'playwright';
import { SapNoteMcpServer } from '../dist/mcp-server.js';
import { HttpSapNoteMcpServer } from '../dist/http-mcp-server.js';
import { createNotesAuthenticator } from '../dist/auth.js';

// Run with piped stdin, and with Xvfb on Linux. A synthetic IAS page completes
// login locally; no request, credentials, or developer session reaches SAP.
for (const Server of [SapNoteMcpServer, HttpSapNoteMcpServer]) {
  test(`${Server.name} opens visible Chromium for interactive login over a pipe`, { timeout: 60000 }, async t => {
    assert.notEqual(process.stdin.isTTY, true, 'run this test with piped stdin');
    const dir = mkdtempSync(join(tmpdir(), 'sap-notes-headful-'));
    const saved = { ...process.env };
    for (const key of ['DOCKER_ENV', 'CI', 'SAP_USERNAME', 'SAP_PASSWORD', 'PFX_PATH', 'PFX_PASSPHRASE']) delete process.env[key];
    if (process.platform !== 'linux') {
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
    }
    Object.assign(process.env, {
      AUTH_METHOD: 'interactive', HEADFUL: 'true', NODE_ENV: 'production', MFA_TIMEOUT: '5000',
      SAP_NOTES_TOKEN_CACHE_FILE: join(dir, 'token.json'),
      SAP_SSO_STORAGE_STATE: join(dir, 'state.json'),
      SAP_LOGIN_URL: 'https://accounts.sap.com/login'
    });
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    });
    const config = Server.prototype.loadConfig.call({});
    assert.equal(config.headful, true);
    let validationOptions;
    t.mock.method(request, 'newContext', async options => {
      validationOptions = options;
      return {
        get: async () => ({ status: () => 200, ok: () => true,
          headers: () => ({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ d: { results: [] } }) }),
        dispose: async () => {}
      };
    });
    const auth = createNotesAuthenticator(config);
    t.after(() => auth.destroy());
    const launch = auth.launchBrowser.bind(auth);
    let launches = 0;
    auth.launchBrowser = async headless => {
      assert.equal(headless, false);
      launches++;
      const browser = await launch(headless);
      t.after(() => browser.close());
      const cdp = await browser.newBrowserCDPSession();
      const { userAgent } = await cdp.send('Browser.getVersion');
      assert.doesNotMatch(userAgent, /HeadlessChrome/);
      await cdp.detach();
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await newContext(options);
        await context.setOffline(true);
        await context.route('**/*', route => {
          if (new URL(route.request().url()).hostname === 'accounts.sap.com') {
            return route.fulfill({ contentType: 'text/html', body: '<title>Sign In</title><script>setTimeout(() => location.replace("https://me.sap.com/home"), 100)</script>' });
          }
          return route.fulfill({ contentType: 'text/html', headers: {
            'set-cookie': 'fixture-session=authenticated; Path=/; Secure; HttpOnly; SameSite=Lax'
          }, body: '<title>SAP for Me fixture</title>Authenticated fixture' });
        });
        return context;
      };
      return browser;
    };
    const session = await auth.ensureSession();
    assert.equal(session.authMethod, 'interactive');
    assert.match(session.cookieHeader, /fixture-session=authenticated/);
    assert.equal(validationOptions.extraHTTPHeaders.Cookie, undefined);
    assert.ok(validationOptions.storageState.cookies.some(cookie =>
      cookie.name === 'fixture-session' && cookie.value === 'authenticated' && cookie.domain === 'me.sap.com'));
    assert.equal(launches, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).cookies[0].value, 'authenticated');
  });
}
