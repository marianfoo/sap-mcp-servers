import type { Cookie } from 'playwright';

export type AuthMethod = 'auto' | 'password' | 'certificate' | 'interactive';
export type ResolvedAuthMethod = 'password' | 'certificate' | 'interactive';
export type BrowserType = 'chromium' | 'firefox' | 'webkit';

/**
 * Minimal structural logger. Compatible with the custom stderr loggers used by
 * the SAP MCP servers and with pino. Injected so the package never depends on a
 * specific logging library.
 */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Shared, service-agnostic auth configuration. Maps 1:1 onto the env vars the
 * three MCP servers already read; each server adapts its own config object into
 * this shape (or uses loadAuthConfigFromEnv).
 */
export interface AuthConfig {
  authMethod: AuthMethod;
  sapUsername?: string;
  sapPassword?: string;
  pfxPath?: string;
  pfxPassphrase?: string;
  /** SAP login start page navigated before the service app URL. Default https://me.sap.com/home. */
  sapLoginUrl?: string;
  /** Milliseconds to wait for MFA/redirect after submitting credentials. */
  mfaTimeout: number;
  /** Cookie cache lifetime in hours (blind TTL, gated by validateSession when provided). */
  maxSessionAgeH: number;
  headful: boolean;
  /** Absolute path to the per-service cookie cache file. */
  tokenCacheFile: string;
  /** Absolute path to the shared SAP SSO Playwright storage-state file. */
  ssoStorageStateFile?: string;
  browserType?: BrowserType;
  /** Browser launch attempts (resource-exhaustion backoff). Default 3. */
  launchRetries?: number;
  /**
   * When true, reuse the shared SSO storage-state file as a session token
   * WITHOUT launching a browser (Notes behavior). Default false.
   */
  sharedSsoTokenFastPath?: boolean;
  logger?: Logger;
}

/** How to pick the cookies that form the session cookie header. */
export type CookieScope =
  | { type: 'url'; url: string }
  | { type: 'domain'; includes: string; fallbackToAll?: boolean }
  | { type: 'all' };

/** Per-service knobs that differ between Roadmap, API Hub and Notes. */
export interface ServiceProfile {
  /** Human-readable name used in log messages, e.g. "SAP Road Map". */
  serviceName: string;
  /** App page opened after SAP login to mint service-scoped cookies. Omit for me.sap.com-only flows. */
  appUrl?: string;
  cookieScope: CookieScope;
  /** Substring the post-login URL must contain before the MFA/redirect wait resolves. */
  expectedHost?: string;
  /** Validates cached/shared/fresh cookies against the service. Metadata preserves domain/path scope. */
  validateSession?: (cookieHeader: string, cookies?: Cookie[]) => Promise<boolean>;
  /** Optional override of the "left the auth pages" predicate (used during certificate auth). */
  authCompletePredicate?: (url: string) => boolean;
  userAgent?: string;
}

export interface AuthSession {
  /** Serialized "name=value; name2=value2" header for API clients. */
  cookieHeader: string;
  cookies: Cookie[];
  expiresAt: number;
  storageStateFile?: string;
  authMethod: ResolvedAuthMethod;
}

export interface CachedToken {
  access_token: string;
  expiresAt: number;
  cookies?: Cookie[];
  authMethod?: ResolvedAuthMethod;
}
