import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { BrowserContext, BrowserContextOptions, Cookie } from 'playwright';
import type { CachedToken, Logger } from './types.js';
import { serializeCookies } from './cookie-scope.js';

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

/** Read defensively so browser login and cookie reuse tolerate an unfinished state file. */
export function loadSharedSsoStorageState(file: string | undefined, logger: Logger): StorageState | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    if (!state || !Array.isArray(state.cookies) || (state.origins !== undefined && !Array.isArray(state.origins))) {
      throw new Error('Invalid storage-state structure');
    }
    return { ...state, origins: state.origins ?? [] };
  } catch {
    // Parser errors can include cookie values. Log the path, never the file contents.
    logger.warn(`Ignoring unreadable or malformed shared SAP SSO state: ${file}`);
    return undefined;
  }
}

/**
 * Read the shared SAP SSO Playwright storage-state file and turn its unexpired
 * cookies into a session token, without launching a browser. Used only when
 * AuthConfig.sharedSsoTokenFastPath is enabled.
 */
export function loadSharedSsoToken(
  file: string | undefined,
  maxSessionAgeH: number,
  logger: Logger
): CachedToken | null {
  try {
    const storageState = loadSharedSsoStorageState(file, logger);
    if (!storageState) return null;

    const nowSeconds = Date.now() / 1000;
    const validCookies: Cookie[] = storageState.cookies.filter((cookie: Cookie) =>
      cookie &&
      typeof cookie.name === 'string' &&
      typeof cookie.value === 'string' &&
      cookie.value.length > 0 &&
      (typeof cookie.expires !== 'number' || cookie.expires === -1 || cookie.expires > nowSeconds + 300)
    );

    if (validCookies.length === 0) {
      logger.warn('Shared SAP SSO storage state has no unexpired cookies');
      return null;
    }

    return {
      access_token: serializeCookies(validCookies),
      cookies: validCookies,
      expiresAt: Date.now() + maxSessionAgeH * 60 * 60 * 1000
    };
  } catch (error) {
    logger.warn('Failed to load shared SAP SSO storage state', error);
    return null;
  }
}

export async function saveSharedSsoStorageState(
  context: BrowserContext | null,
  file: string | undefined,
  logger: Logger
): Promise<void> {
  if (!context || !file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    await context.storageState({ path: file });
    logger.warn(`Saved shared SAP SSO browser state to ${file}`);
  } catch (error) {
    logger.warn('Failed to save shared SAP SSO browser state', error);
  }
}
