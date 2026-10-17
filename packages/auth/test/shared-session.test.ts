import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SapWebAuthenticator } from '../src/authenticator.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const logger = { warn() {}, error() {}, info() {}, debug() {} };
const cookie = { name: 'session', value: 'old', domain: 'me.sap.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };

function fixture(validateSession: (token: string) => Promise<boolean>) {
  const dir = mkdtempSync(join(tmpdir(), 'sap-shared-session-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  const original = JSON.stringify({ cookies: [cookie], origins: [] });
  writeFileSync(file, original);
  const auth = new SapWebAuthenticator({ authMethod: 'auto', headful: false, mfaTimeout: 100,
    maxSessionAgeH: 1, tokenCacheFile: join(dir, 'token.json'), ssoStorageStateFile: file,
    sharedSsoTokenFastPath: true, logger
  }, { serviceName: 'test', cookieScope: { type: 'all' }, validateSession });
  return { auth, file, original, dir };
}

it('validates shared SSO cookies before accepting them', async () => {
  const validate = vi.fn(async () => true);
  const { auth } = fixture(validate);
  expect((await auth.ensureSession()).cookieHeader).toBe('session=old');
  expect((await auth.ensureSession()).cookieHeader).toBe('session=old');
  expect(validate).toHaveBeenCalledExactlyOnceWith('session=old');
  await auth.destroy();
});

it('rejects invalid shared cookies without caching them or overwriting the shared file', async () => {
  const validate = vi.fn(async () => false);
  const { auth, file, original } = fixture(validate);
  await expect(auth.ensureSession()).rejects.toThrow('No authentication credentials configured');
  expect(validate).toHaveBeenCalledOnce();
  expect(readFileSync(file, 'utf8')).toBe(original);
  await auth.destroy();
});

it('surfaces a validation outage without treating it as an expired login', async () => {
  const { auth, file, original } = fixture(async () => { throw new Error('service unavailable'); });
  await expect(auth.ensureSession()).rejects.toThrow('service unavailable');
  expect(readFileSync(file, 'utf8')).toBe(original);
  await auth.destroy();
});
