import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { performInteractiveLogin, performPasswordLogin } from '../dist/ias-login.js';

// Every request is fulfilled locally. Only synthetic credentials reach these forms.
const username = 'dummy.user@example.invalid';
const password = 'DUMMY_PASSWORD';
const logger = { warn() {}, error() {}, info() {}, debug() {} };
const profile = { serviceName: 'browser regression', cookieScope: { type: 'all' } };
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('interactive login accepts an existing signed-in tenant profile', { timeout: 10000 }, async t => {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  await context.route('**/*', route => route.fulfill({
    contentType: 'text/html', body: '<title>User Profile</title>Signed in'
  }));
  const page = await context.newPage();
  await performInteractiveLogin(page, {
    sapLoginUrl: 'https://tenant.accounts.ondemand.com/ui/protected/profilemanagement',
    headful: true, mfaTimeout: 100
  }, profile, logger);
  assert.equal(await page.title(), 'User Profile');
});

function form(fields, action) {
  return `<title>Sign In</title><form method="post" action="${action}">
    ${fields.map(field => `<input id="j_${field}" name="${field}" type="${field === 'password' ? 'password' : 'text'}">`).join('')}
    <button id="logOnFormSubmit">Continue</button></form>
    <script>document.querySelectorAll('input').forEach(input => input.addEventListener('input',
      () => window.captureCredential(input.name, input.value)));</script>`;
}

async function login(t, { start, configured = start, passwordUrl, bootstrap = false, delayPassword = false }) {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  const filled = [];
  const posted = [];
  await context.exposeBinding('captureCredential', ({ frame }, field, value) => {
    filled.push({ field, value, origin: new URL(frame.url()).origin });
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') posted.push({ origin: url.origin, body: request.postData() });
    let body;
    if (url.hostname === 'service.example') {
      body = '<title>Application</title>Signed in';
    } else if (bootstrap && url.pathname === '/admin') {
      body = '<title>Administration Console for Cloud Identity Services</title>' +
        '<script>setTimeout(() => location.href = "/saml2/idp/sso", 100)</script>';
    } else if (passwordUrl && request.url() === passwordUrl) {
      body = form(['password'], 'https://service.example/done');
      if (delayPassword) body += '<script>const p=document.querySelector("input"); p.hidden=true; setTimeout(()=>p.hidden=false,100)</script>';
    } else {
      body = passwordUrl ? form(['username'], passwordUrl) : form(['username', 'password'], 'https://service.example/done');
    }
    await route.fulfill({ contentType: 'text/html', body });
  });
  const page = await context.newPage();
  const config = {
    authMethod: 'password', sapUsername: username, sapPassword: password,
    sapLoginUrl: configured, mfaTimeout: 1000, maxSessionAgeH: 1,
    headful: false, tokenCacheFile: '/not-used', logger
  };
  // The configured start URL can redirect to a different initial login origin.
  if (configured !== start) {
    // Use a browser navigation: Playwright routes only the first request in an
    // HTTP redirect chain, which would let a mocked 302 contact the real site.
    await context.route(configured, route => route.fulfill({ contentType: 'text/html',
      body: `<title>Sign In</title><script>location.replace(${JSON.stringify(start)})</script>` }));
  }
  return { filled, posted, run: () => performPasswordLogin(page, config, profile, logger) };
}

for (const origin of [
  'https://accounts.sap.com',
  'https://tenant.accounts.ondemand.com',
  'https://tenant.accounts.cloud.sap',
  'https://tenant.accounts.sapcloud.cn'
]) {
  test(`permits credentials on the configured identity origin ${origin}`, { timeout: 30000 }, async t => {
    const result = await login(t, { start: `${origin}/saml2/idp/sso` });
    await result.run();
    assert.deepEqual(result.filled, [{ field: 'username', value: username, origin }, { field: 'password', value: password, origin }]);
    assert.equal(result.posted.length, 1);
  });
}

test('supports a real two-step public login with a delayed password field', { timeout: 30000 }, async t => {
  const result = await login(t, { start: 'https://accounts.sap.com/login', passwordUrl: 'https://accounts.sap.com/password', delayPassword: true });
  await result.run();
  assert.equal(result.filled.filter(entry => entry.field === 'password').length, 1);
  assert.equal(result.posted.length, 2);
});

test('waits for the customer admin bootstrap to redirect before filling credentials', { timeout: 30000 }, async t => {
  const result = await login(t, { start: 'https://tenant.accounts.ondemand.com/admin', bootstrap: true });
  await result.run();
  assert.equal(result.filled.length, 2);
});

for (const passwordOrigin of ['https://login.corporate.example', 'https://tenant.accounts.ondemand.com']) {
  test(`never fills or posts the password after delegation to ${passwordOrigin}`, { timeout: 30000 }, async t => {
    const result = await login(t, {
      configured: 'https://tenant.accounts.ondemand.com/admin',
      start: 'https://accounts.sap.com/login', passwordUrl: `${passwordOrigin}/password`
    });
    await assert.rejects(result.run, /Refusing to fill SAP password/);
    assert.equal(result.filled.filter(entry => entry.field === 'password').length, 0);
    assert.ok(result.posted.every(entry => !entry.body?.includes(password)));
  });
}

for (const origin of [
  'https://accounts.sap.com.evil.example',
  'https://other.accounts.ondemand.com',
  'http://accounts.sap.com',
  'https://accounts.sap.com:8443'
]) {
  test(`rejects initial untrusted origin ${origin} before filling credentials`, { timeout: 30000 }, async t => {
    const result = await login(t, { start: `${origin}/login`, configured: 'https://accounts.sap.com/login' });
    await assert.rejects(result.run, /untrusted origin/);
    assert.deepEqual(result.filled, []);
    assert.deepEqual(result.posted, []);
  });
}

test('waits through SAP Neo SAML bootstrap pages before entering the password', { timeout: 20000 }, async t => {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  const filled = [];
  await context.exposeBinding('captureCredential', ({ frame }, field, value) => filled.push({ field, value, origin: new URL(frame.url()).origin }));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'documents.support.sap.com') {
      await route.fulfill({ contentType: 'text/html', headers: { 'com.sap.cloud.security.login': 'login-request' },
        body: '<form action="https://authn.hana.ondemand.com/saml2/sp/mds"></form><script>setTimeout(()=>location.href="https://authn.hana.ondemand.com/saml2/sp/mds",100)</script>' });
    } else if (url.hostname === 'authn.hana.ondemand.com') {
      await route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(()=>location.href="https://accounts.sap.com/saml2/idp/sso",100)</script>' });
    } else if (url.hostname === 'accounts.sap.com') {
      await route.fulfill({ contentType: 'text/html', body: form(['username', 'password'], 'https://service.example/done') });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<title>Signed in</title>' });
    }
  });
  const page = await context.newPage();
  await performPasswordLogin(page, { authMethod: 'password', sapUsername: username, sapPassword: password,
    headful: false, mfaTimeout: 1000 }, { ...profile, appUrl: 'https://documents.support.sap.com/customerkba/' }, logger);
  assert.deepEqual(filled.map(f=>f.field), ['username','password']);
  assert.ok(filled.every(f=>f.origin==='https://accounts.sap.com'));
});

test('missing second-step password has one wait deadline, not one per selector', { timeout: 90000 }, async t => {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  await context.exposeBinding('captureCredential', () => {});
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
    body: form(['username'], 'https://accounts.sap.com/login') }));
  const page = await context.newPage();
  const started = Date.now();
  await assert.rejects(performPasswordLogin(page, {
    sapUsername: username, sapPassword: password, sapLoginUrl: 'https://accounts.sap.com/login',
    headful: false, mfaTimeout: 100
  }, profile, logger), /Could not find password field after username submission/);
  assert.ok(Date.now() - started < 60000);
});

test('a silent SAP Neo SAML sign-in returns to the service without filling credentials', { timeout: 10000 }, async t => {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'documents.support.sap.com' && url.pathname === '/done') {
      return route.fulfill({ contentType: 'text/html', body: '<title>Documents</title>Signed in' });
    }
    if (url.hostname === 'documents.support.sap.com') {
      return route.fulfill({ contentType: 'text/html', headers: { 'com.sap.cloud.security.login': 'login-request' },
        body: '<script>setTimeout(()=>location.href="https://accounts.sap.com/saml2/idp/sso",50)</script>' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<title>Sign In</title><form method="post" action="https://documents.support.sap.com/done"><input type="hidden" name="SAMLResponse" value="synthetic"></form><script>setTimeout(()=>document.forms[0].submit(),100)</script>' });
  });
  const page = await context.newPage();
  await performPasswordLogin(page, { sapUsername: username, sapPassword: password, headful: false, mfaTimeout: 1000 },
    { ...profile, appUrl: 'https://documents.support.sap.com/customerkba/' }, logger);
  assert.equal(page.url(), 'https://documents.support.sap.com/done');
});

test('hidden duplicate fields do not hide the visible login form', { timeout: 15000 }, async t => {
  const context = await browser.newContext({ offline: true });
  t.after(() => context.close());
  const filled = [];
  await context.exposeBinding('captureCredential', (_source, field) => filled.push(field));
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
    body: new URL(route.request().url()).hostname === 'service.example'
      ? '<title>Application</title>Signed in'
      : '<input type="hidden" id="j_username" name="username"><input type="hidden" id="j_password" name="password">' +
        form(['username', 'password'], 'https://service.example/done') }));
  const page = await context.newPage();
  await performPasswordLogin(page, { sapLoginUrl: 'https://accounts.sap.com/login',
    sapUsername: username, sapPassword: password, headful: false, mfaTimeout: 1000 }, profile, logger);
  assert.deepEqual(filled, ['username', 'password']);
});
