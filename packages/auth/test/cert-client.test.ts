import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { CertHttpsClient, CookieJar, metaRedirect, parseApprouterPage, parseAutoPostForm, readAll, type Transport, type TransportRequest } from '../src/cert-client.js';

const SAML_PAGE = (action: string, fields: Record<string, string>) => `<!DOCTYPE html><html><body onload="document.forms[0].submit()">
<form method="post" action="${action}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}"/>`).join('')}
<noscript><input type="submit" value="Continue"/></noscript></form></body></html>`;

describe('parseAutoPostForm', () => {
  it('reads action, method and hidden fields, and decodes entities', () => {
    const form = parseAutoPostForm(SAML_PAGE('https&#x3a;&#x2f;&#x2f;accounts.sap.com&#x2f;saml2&#x2f;idp&#x2f;sso', { SAMLRequest: 'abc&#x3d;', RelayState: 'x&amp;y' }));
    expect(form).toEqual({ action: 'https://accounts.sap.com/saml2/idp/sso', method: 'POST', fields: [['SAMLRequest', 'abc='], ['RelayState', 'x&y']] });
  });

  it('accepts value before name and single quotes', () => {
    const form = parseAutoPostForm(`<form action='/acs'><input value='v1' type='hidden' name='a'></form>`);
    expect(form?.fields).toEqual([['a', 'v1']]);
  });

  it('refuses a page with a visible field, such as a login form', () => {
    expect(parseAutoPostForm('<form action="/login"><input type="hidden" name="x" value="1"><input type="text" name="j_username"><input type="password" name="j_password"></form>')).toBeNull();
    expect(parseAutoPostForm('<form action="/x"><input type="hidden" name="a" value="1"><select name="s"></select></form>')).toBeNull();
  });

  it('returns null without a form, an action or a field', () => {
    expect(parseAutoPostForm('<html>no form</html>')).toBeNull();
    expect(parseAutoPostForm('<form><input type="hidden" name="a" value="1"></form>')).toBeNull();
    expect(parseAutoPostForm('<form action="/x"></form>')).toBeNull();
  });
});

describe('CookieJar', () => {
  it('keeps host-only cookies on their host and domain cookies on subdomains', () => {
    const jar = new CookieJar();
    jar.store(new URL('https://accounts.sap.com/saml2/idp/sso'), ['IDP=1; Path=/; Secure', 'WIDE=2; Domain=.sap.com; Path=/']);
    expect(jar.header(new URL('https://accounts.sap.com/x'))).toBe('IDP=1; WIDE=2');
    expect(jar.header(new URL('https://softwaredownloads.sap.com/file/1'))).toBe('WIDE=2');
    expect(jar.header(new URL('https://authn.hana.ondemand.com/'))).toBe('');
  });

  it('refuses a Domain the host does not belong to, honours Path and expiry', () => {
    const jar = new CookieJar();
    const url = new URL('https://launchpad.support.sap.com/services/odata/svt/swdcuisrv/Set');
    jar.store(url, ['EVIL=1; Domain=example.com', 'P=1; Path=/services', 'OLD=1; Max-Age=0', 'GONE=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(jar.header(url)).toBe('P=1');
    expect(jar.header(new URL('https://launchpad.support.sap.com/other'))).toBe('');
    jar.store(url, ['P=1; Path=/services; Max-Age=0']);
    expect(jar.size).toBe(0);
  });
});

/** A scripted server: each handler answers one request in order. */
function scripted(handlers: Array<(r: TransportRequest) => { status: number; headers?: Record<string, string | string[]>; body?: string }>) {
  const seen: TransportRequest[] = [];
  const transport: Transport = async req => {
    seen.push(req);
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected request ${req.method} ${req.url}`);
    const r = h(req);
    return { status: r.status, headers: r.headers ?? {}, body: Readable.from([Buffer.from(r.body ?? '')]) };
  };
  return { transport, seen };
}

describe('CertHttpsClient', () => {
  it('walks redirects and SAML forms to the final response, carrying cookies across hosts', async () => {
    const { transport, seen } = scripted([
      () => ({ status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'SP=1; Path=/' }, body: SAML_PAGE('https://accounts.sap.com/saml2/idp/sso', { SAMLRequest: 'R' }) }),
      () => ({ status: 200, headers: { 'content-type': 'text/html;charset=utf-8', 'set-cookie': 'IDP=2; Path=/' }, body: SAML_PAGE('https://softwaredownloads.sap.com/file/123', { SAMLResponse: 'S' }) }),
      () => ({ status: 302, headers: { location: '/', 'set-cookie': 'SESSION=3; Path=/' } }),
      () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'CAR 2.01...' })
    ]);
    const client = new CertHttpsClient({ pfx: Buffer.alloc(0), transport });
    const res = await client.open('https://softwaredownloads.sap.com/file/123');
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://softwaredownloads.sap.com/');
    expect((await readAll(res.body)).toString()).toBe('CAR 2.01...');
    expect(res.hops).toEqual([
      'GET softwaredownloads.sap.com/file/123 -> 200',
      'POST accounts.sap.com/saml2/idp/sso -> 200',
      'POST softwaredownloads.sap.com/file/123 -> 302',
      'GET softwaredownloads.sap.com/ -> 200'
    ]);
    expect(seen[1].body?.toString()).toBe('SAMLRequest=R');
    expect(seen[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(seen[2].headers.Cookie).toBe('SP=1');
    expect(seen[3].method).toBe('GET');
    expect(seen[3].body).toBeUndefined();
    expect(seen[3].headers.Cookie).toBe('SP=1; SESSION=3');
  });

  it('stops at an HTML page that is not an auto-submit form and returns it', async () => {
    const { transport } = scripted([() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<form action="/l"><input type="password" name="p"></form>' })]);
    const res = await new CertHttpsClient({ pfx: Buffer.alloc(0), transport }).fetch('https://accounts.sap.com/');
    expect(res.body.toString()).toContain('password');
  });

  it('refuses plain HTTP, also after a redirect', async () => {
    const { transport } = scripted([() => ({ status: 302, headers: { location: 'http://evil.example/' } })]);
    await expect(new CertHttpsClient({ pfx: Buffer.alloc(0), transport }).fetch('https://a.sap.com/')).rejects.toThrow(/non-HTTPS/);
  });

  it('limits redirects and form steps', async () => {
    const loop = () => ({ status: 302, headers: { location: '/again' } });
    const { transport } = scripted(Array.from({ length: 20 }, () => loop));
    await expect(new CertHttpsClient({ pfx: Buffer.alloc(0), transport, maxRedirects: 3 }).fetch('https://a.sap.com/')).rejects.toThrow(/Too many redirects/);

    const page = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: SAML_PAGE('/again', { a: '1' }) });
    const forms = scripted(Array.from({ length: 10 }, () => page));
    const res = await new CertHttpsClient({ pfx: Buffer.alloc(0), transport: forms.transport, maxFormSteps: 2 }).fetch('https://a.sap.com/');
    expect(res.hops).toHaveLength(3);
  });

  it('logs hops without query strings or form values', async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const { transport } = scripted([
      () => ({ status: 302, headers: { location: 'https://accounts.sap.com/sso?SAMLRequest=SECRET1' } }),
      () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: SAML_PAGE('https://b.sap.com/acs', { SAMLResponse: 'SECRET2' }) }),
      () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })
    ]);
    await new CertHttpsClient({ pfx: Buffer.alloc(0), transport, logger: { info: log, debug: log, warn: log, error: log } }).fetch('https://a.sap.com/x?token=SECRET0');
    expect(lines.join('\n')).not.toMatch(/SECRET/);
    expect(lines).toContain('SAML form step 1: POST b.sap.com/acs (1 field(s))');
  });

  it('reset() forgets the session cookies', async () => {
    const { transport, seen } = scripted([
      () => ({ status: 200, headers: { 'set-cookie': 'S=1' } }),
      () => ({ status: 200 })
    ]);
    const client = new CertHttpsClient({ pfx: Buffer.alloc(0), transport });
    await client.fetch('https://a.sap.com/');
    client.reset();
    await client.fetch('https://a.sap.com/');
    expect(seen[1].headers.Cookie).toBeUndefined();
  });
});

const APP = 'https://app.cfapps.eu10.hana.ondemand.com';
const RESOURCE = `${APP}/sap/opu/odata/sap/SRV/Set?$format=json`;
const XSUAA = 'https://tenant.authentication.eu10.hana.ondemand.com';
const APPROUTER_PAGE = `<html><head><script nonce="n">document.cookie="fragmentAfterLogin="+encodeURIComponent(location.hash)+";path=/;";document.cookie="locationAfterLogin="+encodeURIComponent(location.href.split('#')[0].split(location.host)[1])+";path=/;";document.cookie="signature=sig%3D;path=/;";location="${XSUAA}/oauth/authorize?response_type=code&client_id=c&state=s"</script></head></html>`;
const xsuaaLogin = (idp: string) => `<!DOCTYPE html><html><head><title>Login</title><meta name="redirect" content="${idp}/oauth2/authorize?client_id=x&amp;state=y"/></head></html>`;

describe('approuter login', () => {
  it('parses the approuter page and the XSUAA meta redirect', () => {
    const page = 'document.cookie="signature=a%3D;path=/;";location="https:\\/\\/x.authentication.eu10.hana.ondemand.com\\/oauth\\/authorize?a=1\\u0026b=2"';
    expect(parseApprouterPage(page)).toEqual({ location: 'https://x.authentication.eu10.hana.ondemand.com/oauth/authorize?a=1&b=2', cookies: [['signature', 'a%3D']] });
    expect(parseApprouterPage('<html>no login</html>')).toBeNull();
    expect(metaRedirect(xsuaaLogin('https://i.accounts.ondemand.com'))).toBe('https://i.accounts.ondemand.com/oauth2/authorize?client_id=x&state=y');
    expect(metaRedirect('<html></html>')).toBeUndefined();
  });

  it('sets the page cookies, follows XSUAA and its identity provider to the app callback', async () => {
    const { transport, seen } = scripted([
      () => ({ status: 302, headers: { location: `${XSUAA}/login` } }),
      () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: xsuaaLogin('https://idp.accounts.ondemand.com') }),
      () => ({ status: 302, headers: { location: 'https://accounts.sap.com/saml2/idp/sso' } }),
      () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: SAML_PAGE('https://idp.accounts.ondemand.com/acs', { SAMLResponse: 'S' }) }),
      () => ({ status: 302, headers: { location: `${APP}/login/callback?code=abc` } }),
      () => ({ status: 302, headers: { location: RESOURCE, 'set-cookie': 'JSESSIONID=ok; Path=/' } }),
      () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"d":{}}' })
    ]);
    const client = new CertHttpsClient({ pfx: Buffer.alloc(0), transport });
    expect(await client.approuterLogin(RESOURCE, APPROUTER_PAGE)).toBe(true);
    expect(seen[0].url.toString()).toBe(`${XSUAA}/oauth/authorize?response_type=code&client_id=c&state=s`);
    const callback = seen.find(s => s.url.pathname === '/login/callback')!;
    expect(callback.headers.Cookie).toContain('signature=sig%3D');
    expect(callback.headers.Cookie).toContain(`locationAfterLogin=${encodeURIComponent('/sap/opu/odata/sap/SRV/Set?$format=json')}`);
    expect(client.jar.header(new URL(RESOURCE))).toContain('JSESSIONID=ok');
  });

  it('does not read a large resource that the callback redirects to', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const { transport } = scripted([
      () => ({ status: 302, headers: { location: `${APP}/login/callback?code=abc` } }),
      () => ({ status: 302, headers: { location: RESOURCE, 'set-cookie': 'JSESSIONID=ok; Path=/' } }),
      () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: big })
    ]);
    const client = new CertHttpsClient({ pfx: Buffer.alloc(0), transport });
    expect(await client.approuterLogin(RESOURCE, APPROUTER_PAGE)).toBe(true);
    expect(client.jar.header(new URL(RESOURCE))).toContain('JSESSIONID=ok');
  });

  it('returns false for a page that is not an approuter page, and sends nothing', async () => {
    const { transport, seen } = scripted([]);
    expect(await new CertHttpsClient({ pfx: Buffer.alloc(0), transport }).approuterLogin(RESOURCE, '<html>maintenance</html>')).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('refuses to send the certificate to a host outside the allowed ones', async () => {
    const evil = APPROUTER_PAGE.replace(XSUAA, 'https://evil.example.com');
    const { transport, seen } = scripted([]);
    await expect(new CertHttpsClient({ pfx: Buffer.alloc(0), transport }).approuterLogin(RESOURCE, evil)).rejects.toThrow(/Refusing to send the client certificate to https:\/\/evil\.example\.com/);
    expect(seen).toHaveLength(0);

    const idp = scripted([
      () => ({ status: 302, headers: { location: `${XSUAA}/login` } }),
      () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: xsuaaLogin('https://evil.example.com') })
    ]);
    await expect(new CertHttpsClient({ pfx: Buffer.alloc(0), transport: idp.transport }).approuterLogin(RESOURCE, APPROUTER_PAGE)).rejects.toThrow(/evil\.example\.com/);
    expect(idp.seen).toHaveLength(2);
  });

  it('takes its own host list', async () => {
    const { transport } = scripted([() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })]);
    const client = new CertHttpsClient({ pfx: Buffer.alloc(0), transport });
    await expect(client.approuterLogin(RESOURCE, APPROUTER_PAGE, { allowedHosts: [/^only\.example$/] })).rejects.toThrow(/Refusing/);
  });
});
