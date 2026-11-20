import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import type { AuthMethod, ServerConfig } from './types.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dotenvOptions = { override: false };

function loadEnvFiles(): void {
  const envFile = process.env.ENV_FILE;
  if (envFile) {
    loadDotenv({ path: resolve(envFile), ...dotenvOptions });
    return;
  }

  // MCP clients (Cursor, Claude Desktop, etc.) pass credentials via mcp.json "env".
  // Those values are already on process.env before this module loads; never override them.
  loadDotenv(dotenvOptions);
  loadDotenv({ path: join(process.cwd(), '.env'), ...dotenvOptions });

  const packageEnv = join(__dirname, '..', '.env');
  if (existsSync(packageEnv)) {
    loadDotenv({ path: packageEnv, ...dotenvOptions });
  }
}

loadEnvFiles();

export function loadConfig(): ServerConfig {
  const sapUsername = process.env.SAP_USERNAME || undefined;
  const sapPassword = process.env.SAP_PASSWORD || undefined;
  const authMethod = normalizeAuthMethod(process.env.AUTH_METHOD);
  const pfxPath = resolvePfxPath(process.env.PFX_PATH);
  const pfxPassphrase = process.env.PFX_PASSPHRASE || undefined;
  const hasPassword = !!(sapUsername && sapPassword);
  const hasCertificate = !!(pfxPath && pfxPassphrase);

  if (!hasPassword && !hasCertificate && process.env.HEADFUL !== 'true') {
    logger.warn('No SAP auth credentials configured. Set SAP_USERNAME + SAP_PASSWORD or PFX_PATH + PFX_PASSPHRASE, or set HEADFUL=true for interactive sign-in.');
  }

  return {
    pfxPath,
    pfxPassphrase,
    sapUsername,
    sapPassword,
    authMethod,
    mfaTimeout: Number.parseInt(process.env.MFA_TIMEOUT || '180000', 10),
    maxCookieAgeH: Number.parseInt(process.env.MAX_COOKIE_AGE_H || '12', 10),
    headful: process.env.HEADFUL === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiHubBaseUrl: process.env.API_HUB_BASE_URL || 'https://api.sap.com',
    tokenCacheFile: process.env.API_HUB_TOKEN_CACHE_FILE || process.env.TOKEN_CACHE_FILE || join(process.cwd(), 'api-hub-token-cache.json'),
    ssoStorageStateFile: resolveOptionalPath(process.env.SAP_SSO_STORAGE_STATE || join(process.env.HOME || homedir(), '.sap-mcp', 'sso-storage-state.json')),
    sapLoginUrl: process.env.SAP_LOGIN_URL || 'https://me.sap.com/home'
  };
}

function normalizeAuthMethod(value: string | undefined): AuthMethod {
  if (value === 'password' || value === 'certificate' || value === 'auto') {
    return value;
  }

  if (value) {
    logger.warn(`Unsupported AUTH_METHOD="${value}", falling back to auto`);
  }

  return 'auto';
}

function resolvePfxPath(value: string | undefined): string | undefined {
  return resolveOptionalPath(value);
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  let resolvedPath = value;
  if (resolvedPath.startsWith('~')) {
    const home = process.env.HOME || homedir();
    resolvedPath = join(home, resolvedPath.slice(2));
  }

  if (!isAbsolute(resolvedPath)) {
    resolvedPath = join(process.cwd(), resolvedPath);
  }

  return resolve(resolvedPath);
}
