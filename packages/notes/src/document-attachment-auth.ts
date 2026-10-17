import { mkdtemp, readFile, writeFile, mkdir, rename, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SapWebAuthenticator } from '@marianfoo/sap-mcp-auth';
import type { BrowserContextOptions, Cookie } from 'playwright';
import type { ServerConfig } from './types.js';
import { logger } from './logger.js';

export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;
export const DOCUMENT_HOST = 'documents.support.sap.com';
const LOGIN_URL = `https://${DOCUMENT_HOST}/customerkba/`;

export function isDocumentCookie(cookie: Cookie): boolean {
  return cookie.domain.replace(/^\./, '') === DOCUMENT_HOST;
}

export function withDocumentCookies(cookies: Cookie[], documents: Cookie[]): Cookie[] {
  return [...cookies.filter(cookie => !isDocumentCookie(cookie)), ...documents.filter(isDocumentCookie)];
}

/** Use existing SAP login handling without replacing the working Notes session. */
export async function loginForDocumentAttachments(config: ServerConfig): Promise<Cookie[]> {
  const dir = await mkdtemp(join(tmpdir(), 'sap-document-login-'));
  let auth: SapWebAuthenticator | undefined;
  try {
    const ssoFile = join(dir, 'sso-storage-state.json');
    // The legacy Documents login and SAP for Me use different identity flows.
    // A clean context avoids carrying an unfinished/stale flow between apps.
    await writeFile(ssoFile, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    auth = new SapWebAuthenticator({
      authMethod: config.authMethod, sapUsername: config.sapUsername, sapPassword: config.sapPassword,
      pfxPath: config.pfxPath || undefined, pfxPassphrase: config.pfxPassphrase || undefined,
      headful: config.headful, mfaTimeout: config.mfaTimeout, maxSessionAgeH: config.maxJwtAgeH,
      tokenCacheFile: join(dir, 'token-cache.json'), ssoStorageStateFile: ssoFile, logger
    }, {
      serviceName: 'SAP document attachments', appUrl: LOGIN_URL,
      expectedHost: DOCUMENT_HOST, cookieScope: { type: 'url', url: LOGIN_URL }
    });
    const session = await auth.ensureSession();
    return session.cookies.filter(isDocumentCookie);
  } finally {
    await auth?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Save only verified Documents cookies; preserve the latest Notes/identity state. */
export async function saveDocumentCookies(file: string | undefined, cookies: Cookie[]): Promise<void> {
  if (!file) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let state: StorageState;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      await access(file, constants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { cookies: [], origins: [] };
    }
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Invalid shared SSO state');
    state.cookies = withDocumentCookies(state.cookies, cookies);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch {
    // The download succeeded. Keep the session in memory if saving is unavailable.
    logger.warn('Could not save the document session; it will be reused until this server stops');
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
