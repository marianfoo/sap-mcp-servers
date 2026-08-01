import { existsSync, readFileSync } from 'fs';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType as PwBrowserType,
  type Cookie,
  type Page
} from 'playwright';
import type { AuthConfig, AuthSession, CachedToken, Logger, ResolvedAuthMethod, ServiceProfile } from './types.js';
import { AuthenticationError, BrowserNotFoundError, CertificateLoadError } from './errors.js';
import { defaultLogger } from './logger.js';
import { loadCachedToken, removeCachedToken, saveCachedToken } from './cookie-cache.js';
import { loadSharedSsoToken, saveSharedSsoStorageState } from './sso-storage-state.js';
import { selectCookies, serializeCookies } from './cookie-scope.js';
import { performCertificateNavigation, performInteractiveLogin, performPasswordLogin } from './ias-login.js';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CERTIFICATE_ORIGIN = 'https://accounts.sap.com';
const BROWSERS: Record<string, PwBrowserType> = { chromium, firefox, webkit };

interface AuthState {
  token?: string;
  cookies?: Cookie[];
  expiresAt?: number;
  authMethod?: ResolvedAuthMethod;
}

export class SapWebAuthenticator {
  private authState: AuthState = {};
  private sessionPromise: Promise<AuthSession> | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private skipSharedSsoOnce = false;
  // Live, kept-alive authenticated session for runInSession() (SAP for Me backend
  // endpoints only serve JSON to a real logged-in browser, not to plain HTTP clients).
  private liveBrowser: Browser | null = null;
  private liveContext: BrowserContext | null = null;
  private livePage: Page | null = null;
  private liveExpiresAt = 0;
  private readonly log: Logger;

  constructor(private readonly config: AuthConfig, private readonly profile: ServiceProfile) {
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Returns a valid authenticated session, performing login if needed.
   * Single-flight: concurrent callers share one in-progress attempt.
   */
  async ensureSession(): Promise<AuthSession> {
    if (this.isStateValid()) {
      return this.buildSession();
    }
    if (this.sessionPromise) {
      return this.sessionPromise;
    }
    this.sessionPromise = this.performAuth();
    try {
      return await this.sessionPromise;
    } finally {
      this.sessionPromise = null;
    }
  }

  /** Drop cached state (memory + disk) and force a fresh login on next ensureSession(). */
  invalidateAuth(): void {
    this.log.warn(`Invalidating cached ${this.profile.serviceName} authentication`);
    this.authState = {};
    this.skipSharedSsoOnce = true;
    removeCachedToken(this.config.tokenCacheFile, this.log);
  }

  /** Force a fresh login (used by HEADFUL "login only" flows to mint shared SSO state). */
  async loginOnly(): Promise<AuthSession> {
    this.invalidateAuth();
    return this.ensureSession();
  }

  async destroy(): Promise<void> {
    this.authState = {};
    await this.cleanup();
    await this.closeLiveBrowser();
  }

  private async performAuth(): Promise<AuthSession> {
    await this.authenticate();
    if (!this.authState.token) {
      throw new AuthenticationError('Authentication completed but no cookies were captured');
    }
    return this.buildSession();
  }

  private buildSession(): AuthSession {
    return {
      cookieHeader: this.authState.token!,
      cookies: this.authState.cookies ?? [],
      expiresAt: this.authState.expiresAt!,
      storageStateFile: this.config.ssoStorageStateFile,
      authMethod: this.authState.authMethod ?? 'password'
    };
  }

  private isStateValid(): boolean {
    if (!this.authState.token || !this.authState.expiresAt) return false;
    return Date.now() < this.authState.expiresAt - EXPIRY_BUFFER_MS;
  }

  private applyState(cached: CachedToken): void {
    this.authState = {
      token: cached.access_token,
      cookies: cached.cookies,
      expiresAt: cached.expiresAt,
      authMethod: cached.authMethod
    };
  }

  private resolveAuthMethod(): ResolvedAuthMethod {
    const hasPassword = !!(this.config.sapUsername && this.config.sapPassword);
    const hasCertificate = !!(this.config.pfxPath && this.config.pfxPassphrase);

    if (this.config.authMethod === 'password') {
      if (!hasPassword) throw new AuthenticationError('Password auth requested but SAP_USERNAME or SAP_PASSWORD is not set');
      return 'password';
    }
    if (this.config.authMethod === 'certificate') {
      if (!hasCertificate) throw new AuthenticationError('Certificate auth requested but PFX_PATH or PFX_PASSPHRASE is not set');
      return 'certificate';
    }
    if (this.config.authMethod === 'interactive') {
      if (!this.config.headful) throw new AuthenticationError('Interactive auth requested but HEADFUL is not true');
      return 'interactive';
    }

    if (hasPassword) {
      this.log.warn('Auto auth: using username/password authentication');
      return 'password';
    }
    if (hasCertificate) {
      this.log.warn('Auto auth: using SAP Passport certificate authentication');
      return 'certificate';
    }
    if (this.config.ssoStorageStateFile && this.config.headful) {
      this.log.warn('Auto auth: no credentials configured, using interactive browser login');
      return 'interactive';
    }

    throw new AuthenticationError(
      'No authentication credentials configured. Set SAP_USERNAME + SAP_PASSWORD, PFX_PATH + PFX_PASSPHRASE, ' +
      'or SAP_SSO_STORAGE_STATE with HEADFUL=true for interactive login.'
    );
  }

  private prepareClientCertificate() {
    const certPath = this.config.pfxPath!;
    try {
      if (!existsSync(certPath)) {
        throw new Error(`PFX file not found: ${certPath}`);
      }
      return {
        origin: CERTIFICATE_ORIGIN,
        pfx: readFileSync(certPath),
        passphrase: this.config.pfxPassphrase
      };
    } catch (error) {
      throw new CertificateLoadError(certPath, error as Error);
    }
  }

  private async launchBrowser(headless: boolean): Promise<Browser> {
    const type = this.config.browserType ?? 'chromium';
    const launcher = BROWSERS[type];
    if (!launcher) throw new BrowserNotFoundError(type);

    const maxRetries = this.config.launchRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await launcher.launch({ headless });
      } catch (error) {
        lastError = error as Error;
        const message = lastError.message;
        this.log.error(`Browser launch failed (attempt ${attempt}/${maxRetries}): ${message}`);
        if ((message.includes('pthread_create') || message.includes('Resource temporarily unavailable')) && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          this.log.warn(`Resource exhaustion, retrying in ${delayMs / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        if (attempt >= maxRetries) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw lastError ?? new BrowserNotFoundError(type);
  }

  private async authenticate(): Promise<void> {
    const cached = loadCachedToken(this.config.tokenCacheFile, this.log);
    if (cached && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) {
      if (this.profile.validateSession) {
        this.log.warn(`Validating cached ${this.profile.serviceName} cookies`);
        if (await this.profile.validateSession(cached.access_token)) {
          this.log.warn(`Using cached ${this.profile.serviceName} cookies`);
          this.applyState(cached);
          return;
        }
        this.log.warn(`Cached ${this.profile.serviceName} cookies were rejected; forcing fresh authentication`);
        removeCachedToken(this.config.tokenCacheFile, this.log);
      } else {
        this.log.warn(`Using cached ${this.profile.serviceName} cookies`);
        this.applyState(cached);
        return;
      }
    }

    if (this.config.sharedSsoTokenFastPath && !this.skipSharedSsoOnce) {
      const sso = loadSharedSsoToken(this.config.ssoStorageStateFile, this.config.maxSessionAgeH, this.log);
      if (sso) {
        this.log.warn('Using shared SAP SSO browser state');
        this.applyState(sso);
        saveCachedToken(this.config.tokenCacheFile, sso, this.log);
        return;
      }
    } else if (this.skipSharedSsoOnce) {
      this.log.warn('Skipping shared SAP SSO browser state for this authentication retry');
      this.skipSharedSsoOnce = false;
    }

    try {
      const result = await this.launchAndLogin();
      this.browser = result.browser;
      this.context = result.context;
      this.page = result.page;

      if (this.profile.validateSession && !(await this.profile.validateSession(result.cookieHeader))) {
        throw new AuthenticationError(
          `${this.profile.serviceName} login produced cookies, but the service still rejected the session. ` +
          'Headless username/password login likely requires MFA or another interactive step. ' +
          'Run once with HEADFUL=true for manual completion, or configure SAP Passport auth with PFX_PATH and PFX_PASSPHRASE.'
        );
      }

      this.authState = {
        token: result.cookieHeader,
        cookies: result.scoped,
        expiresAt: result.expiresAt,
        authMethod: result.authMethod
      };

      saveCachedToken(
        this.config.tokenCacheFile,
        { access_token: result.cookieHeader, cookies: result.scoped, expiresAt: result.expiresAt, authMethod: result.authMethod },
        this.log
      );
      await saveSharedSsoStorageState(result.context, this.config.ssoStorageStateFile, this.log);
    } catch (error) {
      this.authState = {};
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`${this.profile.serviceName} authentication failed: ${message}`);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Launch a browser, open a context (reusing SSO storage state when present), perform the
   * resolved login flow, and return the live handles plus the captured session cookies.
   * Shared by performAuth() (which captures cookies then closes the browser) and
   * ensureLivePage() (which keeps the browser alive for runInSession()).
   */
  private async launchAndLogin(): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
    cookieHeader: string;
    scoped: Cookie[];
    authMethod: ResolvedAuthMethod;
    expiresAt: number;
  }> {
    const authMethod = this.resolveAuthMethod();
    const headless = !this.config.headful;
    const startTime = Date.now();
    this.log.warn(`Starting ${this.profile.serviceName} authentication (method: ${authMethod}, headless: ${headless})`);

    const browser = await this.launchBrowser(headless);

    const contextOptions: BrowserContextOptions = {
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 }
    };
    if (this.profile.userAgent) {
      contextOptions.userAgent = this.profile.userAgent;
    }
    if (this.config.ssoStorageStateFile && existsSync(this.config.ssoStorageStateFile)) {
      contextOptions.storageState = this.config.ssoStorageStateFile;
      this.log.warn(`Loading shared SAP SSO browser state from ${this.config.ssoStorageStateFile}`);
    }
    if (authMethod === 'certificate') {
      contextOptions.clientCertificates = [this.prepareClientCertificate()];
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.on('dialog', dialog => {
      this.log.warn(`Dialog appeared: ${dialog.type()} ${dialog.message()}`);
      dialog.dismiss().catch(() => {});
    });

    if (authMethod === 'password') {
      await performPasswordLogin(page, this.config, this.profile, this.log);
    } else if (authMethod === 'certificate') {
      await performCertificateNavigation(page, this.config, this.profile, this.log);
    } else {
      await performInteractiveLogin(page, this.config, this.profile, this.log);
    }

    await page.waitForTimeout(1500);

    const allCookies = await context.cookies();
    if (allCookies.length === 0) {
      throw new AuthenticationError('Authentication appeared to succeed but no cookies were set');
    }

    const scoped = await selectCookies(context, this.profile.cookieScope);
    const cookieHeader = serializeCookies(scoped);
    if (!cookieHeader) {
      throw new AuthenticationError(
        `${this.profile.serviceName} login completed but no cookies were captured for the configured scope`
      );
    }

    const expiresAt = Date.now() + this.config.maxSessionAgeH * 60 * 60 * 1000;
    this.log.warn(`${this.profile.serviceName} authentication completed in ${Date.now() - startTime}ms (method: ${authMethod})`);
    return { browser, context, page, cookieHeader, scoped, authMethod, expiresAt };
  }

  /**
   * Run a callback inside a live, authenticated browser page, kept alive across calls.
   * SAP for Me backend endpoints (/backend/raw/...) return a JS-bootstrap HTML stub to plain
   * HTTP clients and only serve JSON to a real logged-in browser, so consumers that need those
   * endpoints must run their fetches in-page via this method rather than with the cookie header.
   */
  async runInSession<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.ensureLivePage();
    return fn(page);
  }

  /** Force the next runInSession() call to perform a fresh login. */
  invalidateLiveSession(): void {
    this.liveExpiresAt = 0;
  }

  private async ensureLivePage(): Promise<Page> {
    if (this.livePage && !this.livePage.isClosed() && Date.now() < this.liveExpiresAt - EXPIRY_BUFFER_MS) {
      return this.livePage;
    }
    await this.closeLiveBrowser();

    const result = await this.launchAndLogin();
    this.liveBrowser = result.browser;
    this.liveContext = result.context;
    this.livePage = result.page;
    this.liveExpiresAt = result.expiresAt;

    // Keep the memory + disk session in sync so ensureSession() consumers benefit too.
    this.authState = {
      token: result.cookieHeader,
      cookies: result.scoped,
      expiresAt: result.expiresAt,
      authMethod: result.authMethod
    };
    saveCachedToken(
      this.config.tokenCacheFile,
      { access_token: result.cookieHeader, cookies: result.scoped, expiresAt: result.expiresAt, authMethod: result.authMethod },
      this.log
    );
    await saveSharedSsoStorageState(result.context, this.config.ssoStorageStateFile, this.log);

    return this.livePage;
  }

  private async closeLiveBrowser(): Promise<void> {
    if (this.liveBrowser) {
      await this.liveBrowser.close().catch(error => this.log.warn('Failed to close live browser', error));
      this.liveBrowser = null;
      this.liveContext = null;
      this.livePage = null;
    }
  }

  private async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(error => this.log.warn('Failed to close browser', error));
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
