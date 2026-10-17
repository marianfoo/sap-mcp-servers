import { request } from 'playwright';
import { buildSapNotesSearchParams, isAuthenticationBootstrapResponse, SAP_NOTES_SEARCH_PATH } from './sap-notes-backend.js';

/** Check the same protected search API used by the Notes tool, without reading old state files. */
export async function validateNotesSession(cookieHeader: string): Promise<boolean> {
  const context = await request.newContext({
    extraHTTPHeaders: { Cookie: cookieHeader, Accept: 'application/json' },
    timeout: 15000
  });
  try {
    const url = new URL(SAP_NOTES_SEARCH_PATH, 'https://me.sap.com');
    url.search = buildSapNotesSearchParams('SAP', 1).toString();
    // A redirected login must not receive our explicit Cookie header.
    const response = await context.get(url.toString(), { maxRedirects: 0 });
    const status = response.status();
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) return false;
    if (!response.ok()) {
      // A service outage is not proof of expired credentials. Preserve the cache.
      throw new Error(`SAP Notes session validation failed (HTTP ${status}); retry when the service is available`);
    }
    const contentType = response.headers()['content-type'] ?? '';
    const text = await response.text();
    const loginMarkup = text.trimStart().startsWith('<') && isAuthenticationBootstrapResponse(status, 'text/html', text);
    if (contentType.toLowerCase().includes('text/html') || loginMarkup) return false;
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error('SAP Notes session validation returned an unexpected search response'); }
    if (!Array.isArray(payload?.d?.results)) {
      throw new Error('SAP Notes session validation returned an unexpected search response');
    }
    return true;
  } finally {
    await context.dispose();
  }
}
