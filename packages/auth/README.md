# @marianfoo/sap-mcp-auth

> Part of the [**sap-mcp-servers**](../../README.md) monorepo (npm workspaces) — published to npm independently as `@marianfoo/sap-mcp-auth` with [build provenance](https://docs.npmjs.com/generating-provenance-statements).

Shared SAP IAS (`accounts.sap.com`) browser-login and session module for SAP MCP servers.

It drives a [Playwright](https://playwright.dev) browser to complete SAP login — username/password, SAP Passport (PFX) certificate, or interactive/manual — captures and caches the resulting session cookies, and returns a structured `AuthSession`. Service-specific differences (which app URL to open, how to scope cookies, how to validate a session) are supplied through a small `ServiceProfile`, so the login mechanics live in one place.

Used by its sibling servers in the monorepo: [`sap-api-hub-mcp`](../api-hub), [`sap-roadmap-mcp`](../roadmap), and [`sap-note-search-mcp`](../notes). Each supplies a service-specific `ServiceProfile` to this module's `SapWebAuthenticator`.

> **Unofficial.** This package is not endorsed by SAP. It automates authenticated SAP web endpoints and browser session cookies in ways that may be restricted by SAP terms of service or your organization's policies. Use at your own risk and only where you are permitted to.

## Install

`playwright` is a **peer dependency** — install it in your project (the SAP MCP servers already do):

```bash
npm install @marianfoo/sap-mcp-auth playwright
npx playwright install chromium
```

Requires Node.js >= 18 and is published as ESM only.

## Quick start

```ts
import { SapWebAuthenticator, type AuthConfig, type ServiceProfile } from '@marianfoo/sap-mcp-auth';

const config: AuthConfig = {
  authMethod: 'auto',                 // 'auto' | 'password' | 'certificate' | 'interactive'
  sapUsername: process.env.SAP_USERNAME,
  sapPassword: process.env.SAP_PASSWORD,
  sapLoginUrl: 'https://me.sap.com/home',
  mfaTimeout: 180_000,
  maxSessionAgeH: 12,
  headful: false,                     // set true when MFA / manual login is required
  tokenCacheFile: '/abs/path/token-cache.json',
  ssoStorageStateFile: '/abs/path/.sap-mcp/sso-storage-state.json'
};

const profile: ServiceProfile = {
  serviceName: 'SAP Road Map',
  appUrl: 'https://roadmaps.sap.com/board',                 // optional page that mints app cookies
  cookieScope: { type: 'url', url: 'https://roadmaps.sap.com' },
  expectedHost: 'roadmaps.sap.com',
  // optional: confirm the cookies actually work before trusting them (cache reuse AND fresh login)
  validateSession: async cookieHeader => {
    const res = await fetch('https://roadmaps.sap.com/services/deliverable-search/periods?range=CURRENT-LAST', {
      headers: { cookie: cookieHeader, accept: 'application/json' }
    });
    return res.ok && (res.headers.get('content-type') || '').includes('json');
  }
};

const auth = new SapWebAuthenticator(config, profile);

const session = await auth.ensureSession();
const res = await fetch('https://roadmaps.sap.com/services/deliverable-search/search?q=workflow', {
  headers: { cookie: session.cookieHeader }
});
```

### Retry-on-expiry pattern

Wrap calls so an expired session re-authenticates once. Have your API layer throw an error whose message contains `SESSION_EXPIRED` / `401` / `Unauthorized` when the server returns a login page instead of data:

```ts
async function withAuthRetry<T>(fn: (cookieHeader: string) => Promise<T>): Promise<T> {
  const { cookieHeader } = await auth.ensureSession();
  try {
    return await fn(cookieHeader);
  } catch (err) {
    if (/SESSION_EXPIRED|401|Unauthorized/.test(String((err as Error)?.message))) {
      auth.invalidateAuth();
      const { cookieHeader: fresh } = await auth.ensureSession();
      return fn(fresh);
    }
    throw err;
  }
}
```

## How it works

- **Single-flight** — concurrent `ensureSession()` callers share one login attempt.
- **Cookie cache** — the session is cached to `tokenCacheFile` (JSON) and reused until it nears expiry (`maxSessionAgeH`, 5-minute buffer).
- **Shared SSO** — after login the Playwright storage state is written to `ssoStorageStateFile`; other SAP MCP servers seed their browser context from it, so a single SAP login is reused across services. With `sharedSsoTokenFastPath: true` a valid storage-state file is reused **without launching a browser**.
- **`validateSession` gate** — when provided, it runs on both cached reuse and fresh login; a rejected session is evicted and re-minted once.
- **Cookie scoping** — `cookieScope` decides which cookies form the header: `{ type: 'url', url }` (origin-scoped), `{ type: 'domain', includes, fallbackToAll? }`, or `{ type: 'all' }`.
- **Credential-origin guard** — password login fills credentials only on SAP's public identity origin or the configured standard customer-IAS tenant, and refuses to forward the password when federation changes the origin.

## API

### `new SapWebAuthenticator(config: AuthConfig, profile: ServiceProfile)`

| Method | Description |
| --- | --- |
| `ensureSession(): Promise<AuthSession>` | Return a valid session, logging in if needed. |
| `invalidateAuth(): void` | Drop the in-memory + on-disk cache; next call re-authenticates. |
| `loginOnly(): Promise<AuthSession>` | Force a fresh login (useful for a `HEADFUL=true` "mint SSO state" script). |
| `destroy(): Promise<void>` | Reset state and close any browser. |

### `AuthSession`

```ts
interface AuthSession {
  cookieHeader: string;       // "name=value; name2=value2" for your API requests
  cookies: Cookie[];          // Playwright cookies, scoped per profile
  expiresAt: number;          // epoch ms
  storageStateFile?: string;  // path to the shared SSO storage state, if configured
  authMethod: 'password' | 'certificate' | 'interactive';
}
```

### `ServiceProfile`

| Field | Required | Description |
| --- | --- | --- |
| `serviceName` | yes | Used in log messages. |
| `appUrl` | no | App page opened after SAP login to mint service-scoped cookies. Omit for `me.sap.com`-only flows. |
| `cookieScope` | yes | `{type:'url',url}` \| `{type:'domain',includes,fallbackToAll?}` \| `{type:'all'}`. |
| `expectedHost` | no | Substring the post-login URL must contain before the MFA/redirect wait resolves. |
| `validateSession` | no | `(cookieHeader) => Promise<boolean>`; gates cached reuse and fresh login. |
| `authCompletePredicate` | no | Override of the "left the auth pages" check during certificate auth. |
| `userAgent` | no | Custom browser user agent. |

### `AuthConfig`

`authMethod`, `sapUsername`, `sapPassword`, `pfxPath`, `pfxPassphrase`, `sapLoginUrl`, `mfaTimeout` (ms), `maxSessionAgeH`, `headful`, `tokenCacheFile`, `ssoStorageStateFile`, `browserType` (`'chromium'|'firefox'|'webkit'`), `launchRetries` (default 3), `sharedSsoTokenFastPath` (default false), `logger`.

### `loadAuthConfigFromEnv(options)`

Builds an `AuthConfig` from environment variables (reads both `MAX_JWT_AGE_H` and `MAX_COOKIE_AGE_H` for compatibility):

```ts
import { loadAuthConfigFromEnv } from '@marianfoo/sap-mcp-auth';

const config = loadAuthConfigFromEnv({
  defaultTokenCacheFile: '/abs/path/token-cache.json',
  tokenCacheEnvVars: ['MY_TOKEN_CACHE_FILE', 'TOKEN_CACHE_FILE'],
  sharedSsoTokenFastPath: false,
  logger: myLogger
});
```

| Env var | Meaning |
| --- | --- |
| `AUTH_METHOD` | `auto` (default) \| `password` \| `certificate` \| `interactive` |
| `SAP_USERNAME`, `SAP_PASSWORD` | Username/password auth |
| `PFX_PATH`, `PFX_PASSPHRASE` | SAP Passport / client-certificate auth |
| `SAP_LOGIN_URL` | Login start page (default `https://me.sap.com/home`) |
| `HEADFUL` | `true` shows the browser (needed for MFA / interactive) |
| `MFA_TIMEOUT` | ms to wait for MFA / redirect (default `180000`) |
| `MAX_JWT_AGE_H` / `MAX_COOKIE_AGE_H` | Cache lifetime in hours (default `12`) |
| `SAP_SSO_STORAGE_STATE` | Path to the shared SSO storage-state file |
| `PLAYWRIGHT_BROWSER_TYPE` | `chromium` (default) \| `firefox` \| `webkit` |

When loading configuration from a `.env` file, quote any value containing `#`; dotenv otherwise treats `#` and everything after it as a comment. For example, use `SAP_PASSWORD="My#Pass"`. The same applies to `PFX_PASSPHRASE`.

### Customer IAS and corporate identity providers

Direct password login supports the standard SAP Cloud Identity Services tenant domains
`*.accounts.ondemand.com`, `*.accounts.cloud.sap`, and `*.accounts.sapcloud.cn`. The authenticator waits
for the JavaScript redirect used by an unauthenticated tenant `/admin` entry page before detecting the
credential form.

If conditional authentication delegates the login to a corporate identity provider, the password flow
fails closed before filling `SAP_PASSWORD` on the new origin. Corporate federation can require different
credentials, MFA, passkeys, or organization-specific policies and must be completed through a separate
interactive login flow. The authenticator never assumes that `SAP_PASSWORD` is valid for the delegated
identity provider.

### Also exported

`isOnAuthPage`, `isAuthUrl`, `selectCookies`, `serializeCookies`, `defaultLogger`, and the error classes `AuthenticationError`, `CertificateLoadError`, `AuthenticationTimeoutError`, `BrowserNotFoundError`. The `Logger` interface lets you inject your own logger (`{ warn, error, info, debug }`); a stderr `defaultLogger` is used otherwise.

## Security

The `tokenCacheFile` and the SSO `storageStateFile` contain **live SAP session cookies**. Treat them as secrets: store them outside your repo (e.g. `~/.sap-mcp/`), never commit them, and add them to `.gitignore`. Credentials and passphrases are never written to these files, but the cookies they hold can be used to act as you on SAP services until they expire.

## License

[Apache-2.0](./LICENSE)
