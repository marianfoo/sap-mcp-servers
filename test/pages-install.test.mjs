import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_BUNDLE_URL,
  PAGES_BASE_URL,
  buildInstallPageUrl,
  buildWerkbankUrl,
  normalizeBundleUrl,
} from '../site/assets/install.mjs';

const README = new URL('../packages/notes/README.md', import.meta.url);

test('builds the exact Werkbank MCPB protocol URL', () => {
  const deepLink = buildWerkbankUrl(DEFAULT_BUNDLE_URL);
  assert.equal(
    deepLink,
    `werkbank://install-mcpb?url=${encodeURIComponent(DEFAULT_BUNDLE_URL)}`
  );

  const parsed = new URL(deepLink);
  assert.equal(parsed.protocol, 'werkbank:');
  assert.equal(parsed.hostname, 'install-mcpb');
  assert.equal(parsed.searchParams.get('url'), DEFAULT_BUNDLE_URL);
});

test('rejects unsafe bundle handoffs', () => {
  assert.equal(normalizeBundleUrl('http://example.com/server.mcpb'), null);
  assert.equal(normalizeBundleUrl('https://user:password@example.com/server.mcpb'), null);
  assert.equal(normalizeBundleUrl('https://example.com:8443/server.mcpb'), null);
  assert.equal(normalizeBundleUrl('not a URL'), null);
});

test('README badge points at the GitHub Pages install route', async () => {
  const expected = buildInstallPageUrl(DEFAULT_BUNDLE_URL, PAGES_BASE_URL);
  const readme = await readFile(README, 'utf8');
  assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(readme, /getwerkbank\.com\/install-mcpb/);
});
