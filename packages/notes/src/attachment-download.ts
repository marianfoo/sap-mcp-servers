import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Cookie, CookieJar } from 'tough-cookie';
import type { Cookie as BrowserCookie } from 'playwright';
import { isAuthUrl } from '@marianfoo/sap-mcp-auth';
import { isAuthenticationBootstrapResponse } from './sap-notes-backend.js';

const ATTACHMENT_HOSTS = new Set([
  'documents.support.sap.com', 'userapps.support.sap.com',
  'launchpad.support.sap.com', 'support.sap.com', 'me.sap.com'
]);
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** An explicit login challenge, distinct from download failures. */
export class AttachmentLoginRequiredError extends Error {
  constructor(readonly url: string) {
    super(`Attachment sign-in required for ${new URL(url).hostname}`);
    this.name = 'AttachmentLoginRequiredError';
  }
}

export function validateAttachmentUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new Error('Attachment URL must use HTTPS on port 443, without embedded credentials');
  }
  if (!ATTACHMENT_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing attachment host "${url.hostname}"`);
  }
  return url;
}

/** SAP uses Content-Disposition when the URL is a generic attachment.htm endpoint. */
function filenameFromDisposition(disposition?: string): string | undefined {
  if (!disposition) return undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (extended?.[1]) {
    try { return decodeURIComponent(extended[1].trim()) || undefined; }
    catch { /* Try the plain filename below. */ }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1]?.trim() || undefined;
}

interface AttachmentAuth {
  cookies?: BrowserCookie[];
  pfx?: Buffer;
  passphrase?: string;
}

/**
 * One bounded download. Node HTTPS streams bytes and verifies TLS; the cookie jar
 * preserves browser domain/path/expiry rules across individually checked redirects.
 * No persistent request context or browser is kept after the call.
 */
export async function downloadAttachment(
  value: string,
  auth: AttachmentAuth,
  { maxBytes = MAX_ATTACHMENT_BYTES, timeoutMs = 60000 } = {}
): Promise<{ body: Buffer; contentType: string; bytes: number; suggestedFilename?: string }> {
  let url = validateAttachmentUrl(value);
  const jar = new CookieJar();
  for (const cookie of auth.cookies ?? []) {
    const domain = cookie.domain.replace(/^\./, '');
    const restored = new Cookie({ key: cookie.name, value: cookie.value,
      domain, hostOnly: !cookie.domain.startsWith('.'), path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      ...(cookie.expires >= 0 ? { expires: new Date(cookie.expires * 1000) } : {}) });
    await jar.setCookie(restored, `https://${domain}${cookie.path}`, { ignoreError: true });
  }
  const signal = AbortSignal.timeout(timeoutMs);

  for (let redirects = 0; ; redirects++) {
    const cookieHeader = await jar.getCookieString(url.toString());
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = https.request(url, {
        method: 'GET', signal, agent: false,
        pfx: auth.pfx, passphrase: auth.passphrase,
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity', ...(cookieHeader ? { Cookie: cookieHeader } : {}) }
      }, resolve);
      req.once('error', reject);
      req.end();
    });
    try {
      for (const cookie of response.headers['set-cookie'] ?? []) {
        await jar.setCookie(cookie, url.toString(), { ignoreError: true });
      }
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= MAX_REDIRECTS) throw new Error('Attachment exceeded the redirect limit');
        const location = response.headers.location;
        if (!location) throw new Error('Attachment redirect has no Location header');
        const next = new URL(location, url);
        if (isAuthUrl(next.toString())) throw new AttachmentLoginRequiredError(url.toString());
        url = validateAttachmentUrl(next.toString());
        continue;
      }
      if (status === 401) throw new AttachmentLoginRequiredError(url.toString());
      if (status === 403) {
        // Preserve the existing Notes refresh behavior on the other hosts.
        if (url.hostname !== 'documents.support.sap.com') throw new Error('SESSION_EXPIRED: Attachment request failed (HTTP 403)');
        throw new Error('Attachment access denied (HTTP 403). Check access to this document with your SAP user.');
      }
      if (status !== 200) throw new Error(`Attachment request failed (HTTP ${status})`);
      if (Number(response.headers['content-length']) > maxBytes) {
        throw new Error(`Attachment exceeds the ${maxBytes}-byte limit`);
      }

      const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      if (encoding && encoding !== 'identity') throw new Error(`Unsupported attachment encoding: ${encoding}; requested identity`);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte limit`);
        chunks.push(chunk);
      }
      if (!bytes) throw new Error('SAP returned an empty attachment');
      const body = Buffer.concat(chunks, bytes);
      const contentType = response.headers['content-type'] ?? 'application/octet-stream';
      const preview = body.subarray(0, 5000).toString('utf8');
      if (response.headers['com.sap.cloud.security.login'] === 'login-request' ||
        isAuthenticationBootstrapResponse(status, contentType, preview)) {
        throw new AttachmentLoginRequiredError(url.toString());
      }
      if (contentType.toLowerCase().includes('text/html')) throw new Error('SAP returned HTML instead of an attachment');
      return { body, contentType, bytes, suggestedFilename: filenameFromDisposition(response.headers['content-disposition']) };
    } finally {
      response.destroy();
    }
  }
}
