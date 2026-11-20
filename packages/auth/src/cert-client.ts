import https from 'https';
import { CookieJar as HttpCookieJar } from 'tough-cookie';
import type { IncomingHttpHeaders } from 'http';
import { Readable } from 'stream';
import type { Logger } from './types.js';

/**
 * Browserless HTTPS client for SAP endpoints that accept the SAP Passport (client certificate):
 * every request carries the PFX, one cookie jar spans all hosts, redirects are followed, and the
 * SAML auto-submit pages (HTML with a form of hidden fields) are posted on, hop by hop.
 *
 * Logs hops as method, host, path and status only. Never logs a query string, a cookie, a form
 * value or the passphrase: the query and the form fields carry SAML messages.
 */

export interface TransportRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface TransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

/** Sends one request without following anything. Swappable for tests. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface CertHttpsClientOptions {
  /** Content of the .pfx / .p12 file. */
  pfx: Buffer;
  passphrase?: string;
  logger?: Logger;
  userAgent?: string;
  /** Redirects followed per request. Default 10. */
  maxRedirects?: number;
  /** SAML form pages posted on per call. Default 8. */
  maxFormSteps?: number;
  /** Socket idle timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** Additional trusted HTTPS origins, including the specific BTP app and identity provider. */
  trustedOrigins?: readonly string[];
  transport?: Transport;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Form-encoded or raw body. */
  body?: string | Buffer;
  /** Post on SAML auto-submit pages. Default true. */
  walkForms?: boolean;
}

/** The final response of a call. The body is still a stream. */
export interface CertResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  /** URL of the final response, after redirects and form posts. */
  url: string;
  /** "GET host/path -> 302" per hop, no query string. */
  hops: string[];
}

export interface BufferedCertResponse extends Omit<CertResponse, 'body'> {
  body: Buffer;
}

export interface AutoPostForm {
  action: string;
  method: string;
  fields: Array<[string, string]>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HTML = 2 * 1024 * 1024;

/** Cookies follow RFC domain/path and public-suffix rules. */
export class CookieJar {
  private readonly cookies = new HttpCookieJar();
  store(url: URL, values: string | string[] | undefined): void {
    for (const value of ([] as string[]).concat(values ?? [])) {
      this.cookies.setCookieSync(value, url.href, { ignoreError: true });
    }
  }
  header(url: URL): string { return this.cookies.getCookieStringSync(url.href); }
  clear(): void { this.cookies.removeAllCookiesSync(); }
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|lt|gt|amp));/gi, (match, hex, decimal, name) => {
    if (name) return named[name.toLowerCase()];
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function attributes(tag: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    map.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return map;
}

/**
 * The first form of a SAML auto-submit page: a form whose inputs are all hidden (a submit button
 * or a noscript button may sit beside them). A page with a visible field, such as a login form, is
 * not one: it returns null, so the walk stops there instead of posting a page meant for a human.
 */
export function parseAutoPostForm(html: string): AutoPostForm | null {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const formAttrs = attributes(form[1]);
  const action = formAttrs.get('action');
  if (!action) return null;
  const fields: Array<[string, string]> = [];
  for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
    const a = attributes(input[1]);
    const type = (a.get('type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image') continue;
    if (type !== 'hidden') return null;
    const name = a.get('name');
    if (name) fields.push([name, a.get('value') ?? '']);
  }
  if (/<(textarea|select)\b/i.test(form[2])) return null;
  if (!fields.some(([name]) => name === 'SAMLRequest' || name === 'SAMLResponse')) return null;
  return { action, method: (formAttrs.get('method') ?? 'post').toUpperCase(), fields };
}

/** The location and the literal cookies of a BTP approuter's login redirect page. */
export interface ApprouterPage {
  location: string;
  cookies: Array<[string, string]>;
}

/**
 * Reads the page a BTP approuter sends instead of a resource when the session is missing: a script
 * that sets cookies and assigns `location` to the XSUAA authorize URL. Returns null for any other page.
 */
export function parseApprouterPage(html: string): ApprouterPage | null {
  const loc = /location\s*=\s*"([^"]+)"/.exec(html)?.[1];
  if (!loc || !/document\.cookie/.test(html)) return null;
  const cookies: Array<[string, string]> = [];
  for (const m of html.matchAll(/document\.cookie\s*=\s*"([A-Za-z0-9_]+)=([^";+]*);path=\/;"/g)) cookies.push([m[1], m[2]]);
  return { location: jsUnescape(loc), cookies };
}

/** The target of `<meta name="redirect" content="...">`, the one identity provider of an XSUAA login page. */
export function metaRedirect(html: string): string | undefined {
  const m = /<meta\s+name=["']redirect["']\s+content=["']([^"']+)["']/i.exec(html);
  return m ? decodeEntities(m[1]) : undefined;
}

function jsUnescape(s: string): string {
  return s
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

const SAP_ORIGINS = ['https://accounts.sap.com', 'https://softwaredownloads.sap.com', 'https://launchpad.support.sap.com'];

export interface ApprouterLoginOptions {
  /** Meta redirects followed after the authorize URL. Default 4. */
  maxMetaSteps?: number;
}

function isHtml(headers: IncomingHttpHeaders): boolean {
  return String(headers['content-type'] ?? '').toLowerCase().includes('text/html');
}

function hop(method: string, url: URL, status: number): string {
  return `${method} ${url.host}${url.pathname} -> ${status}`;
}

export async function readAll(stream: Readable, limit = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > limit) {
      stream.destroy();
      throw new Error(`Response larger than ${limit} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function drain(stream: Readable): Promise<void> {
  return new Promise(resolve => {
    stream.on('end', resolve).on('error', () => resolve()).on('close', resolve);
    stream.resume();
  });
}

function httpsTransport(options: CertHttpsClientOptions): Transport {
  const agent = new https.Agent({ pfx: options.pfx, passphrase: options.passphrase, keepAlive: true, maxSockets: 8 });
  const timeout = options.timeoutMs ?? 120_000;
  return ({ method, url, headers, body }) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers, agent }, res => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
      });
      req.setTimeout(timeout, () => req.destroy(new Error(`No response from ${url.host} within ${timeout} ms`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
}

export class CertHttpsClient {
  readonly jar = new CookieJar();
  private readonly trustedOrigins: Set<string>;
  private transport: Transport;
  private logger?: Logger;
  private userAgent: string;
  private maxRedirects: number;
  private maxFormSteps: number;

  constructor(options: CertHttpsClientOptions) {
    this.trustedOrigins = new Set([...SAP_ORIGINS, ...(options.trustedOrigins ?? [])].map(value => new URL(value).origin));
    this.transport = options.transport ?? httpsTransport(options);
    this.logger = options.logger;
    this.userAgent = options.userAgent ?? 'Mozilla/5.0 (sap-mcp cert-client)';
    this.maxRedirects = options.maxRedirects ?? 10;
    this.maxFormSteps = options.maxFormSteps ?? 8;
  }

  /** Forget every session cookie, so the next call logs in again. */
  reset(): void {
    this.jar.clear();
  }

  /**
   * One call: the request, its redirects and, unless walkForms is false, the SAML auto-submit
   * pages up to the final response. The final body is a stream; read or destroy it.
   */
  async open(url: string, options: RequestOptions = {}): Promise<CertResponse> {
    const hops: string[] = [];
    let res = await this.follow(new URL(url), options, hops);
    if (options.walkForms === false) return res;
    for (let step = 0; isHtml(res.headers) && res.status < 400; step++) {
      const html = await readAll(res.body, MAX_HTML);
      const form = parseAutoPostForm(html.toString('utf8'));
      if (!form) return { ...res, body: Readable.from([html]) };
      if (step >= this.maxFormSteps) throw new Error('Too many SAML form steps');
      if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
        throw new Error('Sign in using a GET request before submitting a request with this method');
      }
      const target = new URL(form.action, res.url);
      this.checkOrigin(target);
      const body = new URLSearchParams(form.fields).toString();
      this.logger?.info(`SAML form step ${step + 1}: ${form.method} ${target.host}${target.pathname} (${form.fields.length} field(s))`);
      res = form.method === 'GET'
        ? await this.follow(new URL(`${target.origin}${target.pathname}?${body}`), {}, hops)
        : await this.follow(target, { method: 'POST', body }, hops);
    }
    return res;
  }

  /**
   * Signs in to a BTP app behind an approuter. `page` is the HTML the app sent for `target` instead of
   * the resource. The client does in code what the page does in a browser: it stores the cookies the
   * script sets (`fragmentAfterLogin`, `locationAfterLogin` and the literal ones such as `signature`)
   * and opens the XSUAA authorize URL. It follows the meta redirect of the XSUAA login page to the
   * identity provider; redirects and SAML forms do the rest, up to the app's callback, which sets the
   * session. Returns false when `page` is not an approuter page. Then the caller decides. Throws when a
   * step leaves the allowed hosts. Call the resource again afterwards.
   */
  async approuterLogin(target: string, page: string, options: ApprouterLoginOptions = {}): Promise<boolean> {
    const app = parseApprouterPage(page);
    if (!app) return false;
    const resource = new URL(target);
    this.checkOrigin(resource);
    const origin = new URL('/', resource);
    this.jar.store(origin, [
      'fragmentAfterLogin=; Path=/',
      `locationAfterLogin=${encodeURIComponent(resource.pathname + resource.search)}; Path=/`,
      ...app.cookies.map(([name, value]) => `${name}=${value}; Path=/`)
    ]);
    let next = new URL(app.location, origin);
    for (let step = 0; step < (options.maxMetaSteps ?? 4); step++) {
      // The last redirect leads back to the resource, which can be large: read only HTML pages.
      const res = await this.open(next.toString(), { headers: { Accept: 'text/html' } });
      this.logger?.info(`Approuter login step ${step + 1}: ${res.hops.join(' | ')}`);
      if (res.status < 200 || res.status >= 300) {
        res.body.destroy();
        return false;
      }
      const returnedToApp = new URL(res.url).origin === resource.origin;
      if (!isHtml(res.headers)) {
        res.body.destroy();
        return returnedToApp;
      }
      const html = (await readAll(res.body, MAX_HTML)).toString('utf8');
      const meta = metaRedirect(html);
      if (!meta) return returnedToApp && !parseApprouterPage(html);
      next = new URL(meta, res.url);
    }
    return false;
  }

  /** open(), with the body read into memory. For pages and JSON, not for downloads. */
  async fetch(url: string, options: RequestOptions = {}, maxBytes = 64 * 1024 * 1024): Promise<BufferedCertResponse> {
    const res = await this.open(url, options);
    return { ...res, body: await readAll(res.body, maxBytes) };
  }

  private checkOrigin(url: URL): void {
    if (url.protocol !== 'https:') throw new Error(`Refusing a non-HTTPS URL: ${url.origin}`);
    if (!this.trustedOrigins.has(url.origin) || url.username || url.password) {
      throw new Error(`Refusing to send the client certificate to ${url.origin}`);
    }
  }

  private async follow(url: URL, options: RequestOptions, hops: string[]): Promise<CertResponse> {
    let requestHeaders: Record<string, string> = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
    );
    let method = (options.method ?? 'GET').toUpperCase();
    let body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
    for (let n = 0; ; n++) {
      this.checkOrigin(url);
      const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: '*/*', ...requestHeaders };
      const cookie = this.jar.header(url);
      if (cookie) headers.cookie = cookie;
      if (body) {
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        headers['content-length'] = String(body.length);
      }
      const res = await this.transport({ method, url, headers, body });
      this.jar.store(url, res.headers['set-cookie']);
      const line = hop(method, url, res.status);
      hops.push(line);
      this.logger?.debug(line);
      const location = res.headers.location;
      if (!REDIRECTS.has(res.status) || !location) return { status: res.status, headers: res.headers, body: res.body, url: url.toString(), hops };
      await drain(res.body);
      if (n >= this.maxRedirects) throw new Error(`Too many redirects, last at ${url.host}${url.pathname}`);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        requestHeaders = body ? { 'content-type': headers['content-type'] } : {};
      }
      url = next;
      if ((res.status === 303 && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        for (const name of ['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location']) {
          delete requestHeaders[name];
        }
        method = 'GET';
        body = undefined;
      }
    }
  }
}
