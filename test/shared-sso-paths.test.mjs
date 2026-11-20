import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SapNoteMcpServer } from '../packages/notes/dist/mcp-server.js';
import { HttpSapNoteMcpServer } from '../packages/notes/dist/http-mcp-server.js';

import { createApiHubAuthenticator } from '../packages/api-hub/dist/auth.js';
import { loadConfig as apiHubConfig } from '../packages/api-hub/dist/config.js';
import { loadConfig as roadmapConfig } from '../packages/roadmap/dist/config.js';
import { loadAuthConfigFromEnv } from '../packages/auth/dist/auth-config.js';

const configs = [
  ['auth', () => loadAuthConfigFromEnv({ defaultTokenCacheFile: join(homedir(), 'test-cache.json') })],
  ['api-hub', apiHubConfig],
  ['roadmap', roadmapConfig],
  ['notes stdio', () => SapNoteMcpServer.prototype.loadConfig.call({})],
  ['notes http', () => HttpSapNoteMcpServer.prototype.loadConfig.call({})]
];

// Run fn with the given environment variables set (undefined removes one), then restore them.
function withEnv(vars, fn) {
  const saved = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('without HOME (Windows), the shared SSO state lives in the home directory, not the working directory', () => {
  for (const [name, load] of configs) {
    const config = withEnv({ HOME: undefined, SAP_SSO_STORAGE_STATE: undefined }, () =>
      load()
    );
    assert.equal(config.ssoStorageStateFile, join(homedir(), '.sap-mcp', 'sso-storage-state.json'), name);
  }
});

test('HOME still takes precedence, and SAP_SSO_STORAGE_STATE over both', () => {
  for (const [name, load] of configs) {
    const home = join(homedir(), 'sap-mcp-test-home');
    let config = withEnv({ HOME: home, SAP_SSO_STORAGE_STATE: undefined }, () =>
      load()
    );
    assert.equal(config.ssoStorageStateFile, join(home, '.sap-mcp', 'sso-storage-state.json'), name);

    const explicit = join(homedir(), 'explicit-state.json');
    config = withEnv({ HOME: home, SAP_SSO_STORAGE_STATE: explicit }, () =>
      load()
    );
    assert.equal(config.ssoStorageStateFile, explicit, name);
  }
});

test('~ in a configured path expands to the home directory even without HOME', () => {
  for (const [name, load] of configs) {
    const config = withEnv({ HOME: undefined, USERPROFILE: undefined, SAP_SSO_STORAGE_STATE: '~/state.json' }, () =>
      load()
    );
    assert.equal(config.ssoStorageStateFile, join(homedir(), 'state.json'), name);
  }
});

test('different MCP working directories resolve to the same shared state file', () => {
  const cwd = process.cwd();
  try {
    withEnv({ HOME: undefined, SAP_SSO_STORAGE_STATE: undefined }, () => {
      const expected = join(homedir(), '.sap-mcp', 'sso-storage-state.json');
      for (const directory of [homedir(), cwd]) {
        process.chdir(directory);
        for (const [name, load] of configs) assert.equal(load().ssoStorageStateFile, expected, name);
      }
    });
  } finally {
    process.chdir(cwd);
  }
});

test('API Hub intentionally ignores shared browser state and starts at its own service', () => {
  const auth = withEnv({ SAP_SSO_STORAGE_STATE: 'shared.json', SAP_LOGIN_URL: 'https://me.sap.com/home' },
    () => createApiHubAuthenticator(apiHubConfig()));
  assert.equal(auth.config.ssoStorageStateFile, undefined);
  assert.equal(auth.config.sapLoginUrl, undefined);
  assert.equal(new URL(auth.profile.appUrl).hostname, 'api.sap.com');
});
