import type { Page } from 'playwright';
import type { AuthConfig, Logger, ServiceProfile } from './types.js';
import { AuthenticationError } from './errors.js';

const USERNAME_SELECTORS = [
  '#j_username',
  'input[name="j_username"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[type="email"]',
  '#logOnFormUsername',
  'input[name="logOnFormUsername"]',
  '#USERNAME_FIELD input',
  'input[id*="username" i]',
  'input[id*="email" i]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="User ID" i]',
  'input[aria-label*="Email" i]',
  'input[aria-label*="User ID" i]'
];

const PASSWORD_SELECTORS = [
  '#j_password',
  'input[name="j_password"]',
  'input[name="password"]',
  'input[type="password"]',
  '#logOnFormPassword',
  'input[name="logOnFormPassword"]',
  '#PASSWORD_FIELD input',
  'input[id*="password" i]',
  'input[placeholder*="Password" i]',
  'input[aria-label*="Password" i]'
];

const CONTINUE_SELECTORS = [
  '#logOnFormSubmit',
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")',
  'input[type="submit"][value*="Continue" i]',
  'button:has-text("Next")',
  '[role="button"]:has-text("Next")',
  'button[id*="continue" i]',
  'button[id*="next" i]',
  'a[id*="continue" i]'
];

const SUBMIT_SELECTORS = [
  '#logOnFormSubmit',
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Sign In")',
  'button:has-text("Sign in")',
  '[role="button"]:has-text("Sign In")',
  '[role="button"]:has-text("Sign in")',
  'button:has-text("Log On")',
  'button:has-text("Log in")',
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")',
  'button[id*="login" i]',
  'button[id*="signin" i]',
  'button[id*="submit" i]'
];

const SAP_PUBLIC_IDENTITY_ORIGIN = 'https://accounts.sap.com';
const STANDARD_CUSTOMER_IAS_SUFFIXES = [
  '.accounts.ondemand.com',
  '.accounts.cloud.sap',
  '.accounts.sapcloud.cn'
];
const CUSTOMER_IAS_AUTH_PATH_PREFIXES = ['/saml2/', '/oauth2/', '/ui/', '/ids/'];
const IAS_BOOTSTRAP_TIMEOUT_MS = 10000;

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isStandardCustomerIasHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return STANDARD_CUSTOMER_IAS_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function isStandardCustomerIasAuthUrl(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed || !isStandardCustomerIasHostname(parsed.hostname)) return false;
  const path = parsed.pathname.toLowerCase();
  return CUSTOMER_IAS_AUTH_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
}

function isCustomerIasBootstrapPage(url: string, title: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || !isStandardCustomerIasHostname(parsed.hostname)) return false;
  return parsed.pathname.toLowerCase().startsWith('/admin') &&
    title.toLowerCase().includes('administration console');
}

function allowedCredentialOrigins(config: AuthConfig): Set<string> {
  const origins = new Set([SAP_PUBLIC_IDENTITY_ORIGIN]);
  const configuredLogin = config.sapLoginUrl ? parseUrl(config.sapLoginUrl) : undefined;
  if (
    configuredLogin?.protocol === 'https:' &&
    isStandardCustomerIasHostname(configuredLogin.hostname)
  ) {
    origins.add(configuredLogin.origin);
  }
  return origins;
}

// Login selectors intentionally support several IAS page variants. Re-check the
// top-level origin immediately before every fill so a redirect cannot rebind a
// generic username/password selector to a delegated or lookalike identity site.
function requireCredentialOrigin(
  page: Page,
  config: AuthConfig,
  field: 'username' | 'password',
  expectedOrigin?: string
): string {
  const parsed = parseUrl(page.url());
  const origin = parsed?.origin;
  const allowed = allowedCredentialOrigins(config);

  if (!origin || !allowed.has(origin)) {
    throw new AuthenticationError(
      `Refusing to fill SAP ${field} on untrusted origin ${origin ?? 'unknown'}. ` +
      `Allowed credential origins: ${[...allowed].join(', ')}. ` +
      'The login may have been delegated to a corporate identity provider; complete that flow with a separate interactive login.'
    );
  }
  if (expectedOrigin && origin !== expectedOrigin) {
    throw new AuthenticationError(
      `Refusing to fill SAP ${field} after the credential origin changed from ${expectedOrigin} to ${origin}. ` +
      'The login may have been delegated to a corporate identity provider; complete that flow with a separate interactive login.'
    );
  }
  return origin;
}

export function isOnAuthPage(url: string, title: string): boolean {
  const combined = `${url} ${title}`.toLowerCase();
  return (
    isStandardCustomerIasAuthUrl(url) ||
    combined.includes('authentication') ||
    combined.includes('accounts.sap.com') ||
    combined.includes('login') ||
    combined.includes('oauth') ||
    combined.includes('saml') ||
    combined.includes('sign in') ||
    combined.includes('log on') ||
    combined.includes('two-factor') ||
    combined.includes('verify') ||
    combined.includes('passcode')
  );
}

export function isAuthUrl(url: string): boolean {
  const value = url.toLowerCase();
  return (
    isStandardCustomerIasAuthUrl(url) ||
    value.includes('authentication') ||
    value.includes('accounts.sap.com') ||
    value.includes('login') ||
    value.includes('oauth') ||
    value.includes('saml') ||
    value.includes('two-factor') ||
    value.includes('verify') ||
    value.includes('passcode')
  );
}

async function openAuthPage(page: Page, url: string, label: string, logger: Logger): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
  } catch (error) {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank') {
      throw error;
    }
    logger.warn(`${label} navigation did not settle at ${currentUrl}; continuing with login detection`, error);
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {
    logger.warn(`${label} DOMContentLoaded wait timed out; continuing with login detection`);
  });

  const committedUrl = page.url();
  const committedTitle = await page.title();
  if (isCustomerIasBootstrapPage(committedUrl, committedTitle)) {
    logger.warn(`${label} reached the SAP Cloud Identity Services bootstrap page; waiting for its authentication redirect`);
    const redirected = await page.waitForURL(
      next => next.toString() !== committedUrl,
      { timeout: IAS_BOOTSTRAP_TIMEOUT_MS, waitUntil: 'commit' }
    ).then(() => true).catch(() => false);

    if (redirected) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {
        logger.warn(`${label} authentication redirect did not finish loading; continuing with login detection`);
      });
    } else {
      logger.warn(`${label} SAP Cloud Identity Services bootstrap did not redirect within ${IAS_BOOTSTRAP_TIMEOUT_MS / 1000}s`);
    }
  }
}

async function tryFillFirstVisible(
  page: Page,
  selectors: string[],
  value: string,
  label: string,
  timeout: number,
  logger: Logger,
  beforeFill?: () => void
): Promise<boolean> {
  for (const selector of selectors) {
    const field = await page.waitForSelector(selector, { timeout, state: 'visible' }).catch(() => null);
    if (field) {
      beforeFill?.();
      await field.click({ clickCount: 3 });
      await field.fill(value);
      logger.warn(`Filled ${label} field using selector ${selector}`);
      return true;
    }
  }
  return false;
}

async function fillFirstVisible(
  page: Page,
  selectors: string[],
  value: string,
  label: string,
  logger: Logger,
  beforeFill?: () => void
): Promise<void> {
  const filled = await tryFillFirstVisible(page, selectors, value, label, 5000, logger, beforeFill);
  if (!filled) {
    await page.screenshot({ path: `debug-${label}-not-found.png`, fullPage: true }).catch(() => {});
    throw new AuthenticationError(`Could not find ${label} field on SAP login page`);
  }
}

async function clickFirstVisible(page: Page, selectors: string[], label: string, logger: Logger): Promise<void> {
  for (const selector of selectors) {
    const element = await page.waitForSelector(selector, { timeout: 3000, state: 'visible' }).catch(() => null);
    if (element) {
      await element.click();
      logger.warn(`Clicked ${label} button using selector ${selector}`);
      return;
    }
  }
  throw new AuthenticationError(`Could not find ${label} button on SAP login page`);
}

async function completePasswordLoginIfNeeded(
  page: Page,
  config: AuthConfig,
  logger: Logger,
  label: string,
  expectedHost?: string
): Promise<void> {
  const currentUrl = page.url();
  const pageTitle = await page.title();
  if (!isOnAuthPage(currentUrl, pageTitle)) {
    logger.warn(`${label} loaded without visible authentication challenge`);
    return;
  }

  logger.warn(`Authentication page detected: ${pageTitle} at ${currentUrl}`);
  let credentialOrigin = '';
  await fillFirstVisible(page, USERNAME_SELECTORS, config.sapUsername!, 'username', logger, () => {
    credentialOrigin = requireCredentialOrigin(page, config, 'username');
  });

  const guardPasswordFill = () => requireCredentialOrigin(page, config, 'password', credentialOrigin);
  let passwordFilled = await tryFillFirstVisible(
    page,
    PASSWORD_SELECTORS,
    config.sapPassword!,
    'password',
    500,
    logger,
    guardPasswordFill
  );
  if (!passwordFilled) {
    logger.warn('Password field not visible yet; submitting username step');
    await clickFirstVisible(page, CONTINUE_SELECTORS, 'continue', logger);
    passwordFilled = await tryFillFirstVisible(
      page,
      PASSWORD_SELECTORS,
      config.sapPassword!,
      'password',
      15000,
      logger,
      guardPasswordFill
    );
    if (!passwordFilled) {
      throw new AuthenticationError('Could not find password field after username submission');
    }
  }

  await clickFirstVisible(page, SUBMIT_SELECTORS, 'submit', logger);

  await page.waitForTimeout(3000);
  const postLoginUrl = page.url();
  const postLoginTitle = await page.title();

  if (isOnAuthPage(postLoginUrl, postLoginTitle)) {
    logger.warn(`Waiting up to ${config.mfaTimeout / 1000}s for MFA or final redirect`);
    if (!config.headful) {
      logger.warn('If MFA is required, set HEADFUL=true and rerun');
    }
    await page.waitForURL(url => {
      const value = url.toString().toLowerCase();
      if (isAuthUrl(value)) return false;
      return expectedHost ? value.includes(expectedHost) : true;
    }, { timeout: config.mfaTimeout }).catch(() => {
      logger.warn('MFA/redirect wait timed out; checking whether cookies are still usable');
    });
  }
}

export async function performPasswordLogin(
  page: Page,
  config: AuthConfig,
  profile: ServiceProfile,
  logger: Logger
): Promise<void> {
  if (config.sapLoginUrl) {
    logger.warn(`Opening shared SAP login start URL: ${config.sapLoginUrl}`);
    await openAuthPage(page, config.sapLoginUrl, 'SAP login start', logger);
    await completePasswordLoginIfNeeded(page, config, logger, 'shared SAP login');
  }

  if (profile.appUrl) {
    logger.warn(`Opening ${profile.serviceName} app to mint service session cookies`);
    await openAuthPage(page, profile.appUrl, `${profile.serviceName} app`, logger);
    const currentUrl = page.url();
    const pageTitle = await page.title();
    if (!isOnAuthPage(currentUrl, pageTitle)) {
      logger.warn(`${profile.serviceName} app loaded without visible authentication challenge`);
      return;
    }
    logger.warn(`Authentication page detected: ${pageTitle} at ${currentUrl}`);
    await completePasswordLoginIfNeeded(page, config, logger, `${profile.serviceName} app session`, profile.expectedHost);
  }
}

export async function performCertificateNavigation(
  page: Page,
  config: AuthConfig,
  profile: ServiceProfile,
  logger: Logger
): Promise<void> {
  const target = profile.appUrl ?? config.sapLoginUrl;
  if (!target) {
    throw new AuthenticationError('No appUrl or sapLoginUrl configured for certificate authentication');
  }

  await openAuthPage(page, target, `${profile.serviceName} app`, logger);
  const currentUrl = page.url();
  const pageTitle = await page.title();

  if (isOnAuthPage(currentUrl, pageTitle)) {
    logger.warn(`Still on authentication page after certificate navigation: ${pageTitle} at ${currentUrl}`);
    await page.waitForURL(url => {
      const value = url.toString().toLowerCase();
      if (profile.authCompletePredicate) return profile.authCompletePredicate(value);
      if (isAuthUrl(value)) return false;
      return profile.expectedHost ? value.includes(profile.expectedHost) : true;
    }, { timeout: config.mfaTimeout }).catch(() => {
      logger.warn('Certificate auth redirect wait timed out; checking whether cookies are still usable');
    });
  } else {
    logger.warn(`${profile.serviceName} app loaded without visible authentication challenge`);
  }
}

export async function performInteractiveLogin(
  page: Page,
  config: AuthConfig,
  profile: ServiceProfile,
  logger: Logger
): Promise<void> {
  if (!config.headful) {
    throw new AuthenticationError('Interactive SAP login requires HEADFUL=true');
  }
  const target = config.sapLoginUrl ?? profile.appUrl;
  if (!target) {
    throw new AuthenticationError('No sapLoginUrl or appUrl configured for interactive authentication');
  }

  logger.warn(`Opening SAP login page for manual sign-in: ${target}`);
  await openAuthPage(page, target, 'SAP login', logger);

  if (isOnAuthPage(page.url(), await page.title())) {
    logger.warn(`Complete SAP sign-in in the browser window (timeout: ${config.mfaTimeout / 1000}s)`);
    await page.waitForURL(url => !isAuthUrl(url.toString().toLowerCase()), { timeout: config.mfaTimeout }).catch(() => {
      logger.warn('Manual login wait timed out; checking whether cookies are still usable');
    });
  }

  if (isOnAuthPage(page.url(), await page.title())) {
    throw new AuthenticationError('Manual SAP login did not complete before the timeout');
  }
  logger.warn('Manual SAP login completed');
}
