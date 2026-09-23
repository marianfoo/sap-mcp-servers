import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isAuthUrl, isOnAuthPage, performPasswordLogin } from '../src/ias-login.js';
import type { AuthConfig, Logger, ServiceProfile } from '../src/types.js';

const logger: Logger = {
  warn() {},
  error() {},
  info() {},
  debug() {}
};

function config(sapLoginUrl: string): AuthConfig {
  return {
    authMethod: 'password',
    sapUsername: 'dummy.user@example.invalid',
    sapPassword: 'DUMMY_PASSWORD',
    sapLoginUrl,
    mfaTimeout: 1_000,
    maxSessionAgeH: 1,
    headful: false,
    tokenCacheFile: '/tmp/not-used.json',
    logger
  };
}

const profile: ServiceProfile = {
  serviceName: 'IAS login test',
  cookieScope: { type: 'all' }
};

type Scenario = 'public-same-origin' | 'customer-bootstrap' | 'federated-cross-origin' | 'lookalike-origin';
type Stage = 'initial' | 'bootstrap' | 'username' | 'password' | 'complete';

class FakeLoginPage {
  currentUrl = 'about:blank';
  currentTitle = '';
  stage: Stage = 'initial';
  readonly filled: Array<{ label: 'username' | 'password'; origin: string; value: string }> = [];

  constructor(private readonly scenario: Scenario) {}

  async goto(url: string): Promise<null> {
    if (this.scenario === 'customer-bootstrap') {
      this.currentUrl = url;
      this.stage = 'bootstrap';
      this.currentTitle = 'Administration Console for Cloud Identity Services';
    } else {
      this.currentUrl = this.scenario === 'public-same-origin'
        ? 'https://accounts.sap.com/saml2/idp/sso'
        : this.scenario === 'lookalike-origin'
          ? 'https://accounts.sap.com.evil.example/login'
          : url;
      this.stage = 'username';
      this.currentTitle = 'Sign In';
    }
    return null;
  }

  async waitForLoadState(): Promise<void> {}

  async waitForURL(predicate: (url: URL) => boolean): Promise<void> {
    if (this.stage === 'bootstrap') {
      this.stage = 'username';
      this.currentUrl = 'https://tenant.accounts.ondemand.com/saml2/idp/sso?sp=example';
      this.currentTitle = 'Administration Console: Sign In';
    }
    if (!predicate(new URL(this.currentUrl))) {
      throw new Error(`URL predicate rejected ${this.currentUrl}`);
    }
  }

  async waitForSelector(selector: string): Promise<FakeElement | null> {
    if (this.stage === 'username' && selector === '#j_username') {
      return new FakeElement(this, 'username');
    }
    if (this.stage === 'password' && selector === '#j_password') {
      return new FakeElement(this, 'password');
    }
    if ((this.stage === 'username' || this.stage === 'password') && selector === '#logOnFormSubmit') {
      return new FakeElement(this, 'button');
    }
    return null;
  }

  async waitForTimeout(): Promise<void> {}
  async screenshot(): Promise<Buffer> { return Buffer.alloc(0); }
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.currentTitle; }

  advance(): void {
    if (this.stage === 'username') {
      this.stage = 'password';
      if (this.scenario === 'federated-cross-origin') {
        this.currentUrl = 'https://login.corporate-idp.example/password';
        this.currentTitle = 'Corporate Identity Provider';
      } else if (this.scenario === 'public-same-origin') {
        this.currentUrl = 'https://accounts.sap.com/ui/password';
        this.currentTitle = 'Sign In';
      } else {
        this.currentUrl = 'https://tenant.accounts.ondemand.com/ui/password';
        this.currentTitle = 'Log On';
      }
      return;
    }

    this.stage = 'complete';
    this.currentUrl = 'https://service.example/complete';
    this.currentTitle = 'Target Application';
  }
}

class FakeElement {
  constructor(
    private readonly page: FakeLoginPage,
    private readonly kind: 'username' | 'password' | 'button'
  ) {}

  async click(): Promise<void> {
    if (this.kind === 'button') this.page.advance();
  }

  async fill(value: string): Promise<void> {
    if (this.kind === 'button') throw new Error('Cannot fill a button');
    this.page.filled.push({
      label: this.kind,
      origin: new URL(this.page.currentUrl).origin,
      value
    });
  }
}

describe('SAP IAS password login boundaries', () => {
  it('preserves the supported accounts.sap.com two-step password flow', async () => {
    const page = new FakeLoginPage('public-same-origin');

    await performPasswordLogin(
      page as unknown as Page,
      config('https://me.sap.com/home'),
      profile,
      logger
    );

    expect(page.filled).toEqual([
      { label: 'username', origin: 'https://accounts.sap.com', value: 'dummy.user@example.invalid' },
      { label: 'password', origin: 'https://accounts.sap.com', value: 'DUMMY_PASSWORD' }
    ]);
  });

  it('refuses to forward the configured SAP password to a federated corporate IdP', async () => {
    const page = new FakeLoginPage('federated-cross-origin');

    await expect(performPasswordLogin(
      page as unknown as Page,
      config('https://accounts.sap.com/saml2/idp/sso'),
      profile,
      logger
    )).rejects.toThrow(/refusing to fill.*password.*origin/i);

    expect(page.filled.filter(entry => entry.label === 'password')).toEqual([]);
  });

  it('rejects a lookalike hostname before filling even the username', async () => {
    const page = new FakeLoginPage('lookalike-origin');

    await expect(performPasswordLogin(
      page as unknown as Page,
      config('https://accounts.sap.com/saml2/idp/sso'),
      profile,
      logger
    )).rejects.toThrow(/untrusted origin https:\/\/accounts\.sap\.com\.evil\.example/i);

    expect(page.filled).toEqual([]);
  });

  it('waits through the customer-IAS admin bootstrap before looking for credentials', async () => {
    const page = new FakeLoginPage('customer-bootstrap');

    await performPasswordLogin(
      page as unknown as Page,
      config('https://tenant.accounts.ondemand.com/admin/'),
      profile,
      logger
    );

    expect(page.filled).toEqual([
      { label: 'username', origin: 'https://tenant.accounts.ondemand.com', value: 'dummy.user@example.invalid' },
      { label: 'password', origin: 'https://tenant.accounts.ondemand.com', value: 'DUMMY_PASSWORD' }
    ]);
  });

  it('recognizes standard customer-IAS login URLs and the Log On title', () => {
    const url = 'https://tenant.accounts.cloud.sap/ui/public?spId=example';
    expect(isOnAuthPage(url, 'Log On')).toBe(true);
    expect(isAuthUrl(url)).toBe(true);
  });
});
