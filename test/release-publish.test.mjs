import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = new URL('../', import.meta.url);
const paths = ['packages/notes', 'packages/roadmap', 'packages/auth', 'packages/api-hub'];
const packages = Object.fromEntries(paths.map(folder => [folder,
  JSON.parse(readFileSync(new URL(`${folder}/package.json`, repo), 'utf8'))]));
const auth = packages['packages/auth'].name;
const notes = packages['packages/notes'].name;
const workflow = readFileSync(new URL('.github/workflows/release.yml', repo), 'utf8');
const section = workflow.split('      - name: Publish released packages\n')[1];
const block = section?.match(/        run: \|\n((?:          .*\n|\n)+)/)?.[1];
assert.ok(block, 'test must execute the actual release workflow shell');
const script = block.split('\n').map(line => line.slice(10)).join('\n');

// No network, credentials, real publication or delays: only npm and sleep are mocked.
const npmMock = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
let exit = 0;
if (args[0] === 'publish') {
  const pkg = JSON.parse(fs.readFileSync(args[2] + '/package.json', 'utf8'));
  if (state.failPublish === pkg.name || state.published.includes(pkg.name)) {
    exit = 1;
  } else {
    state.published.push(pkg.name);
  }
} else if (args[0] === 'view') {
  const split = args[1].lastIndexOf('@');
  const name = args[1].slice(0, split);
  const version = args[1].slice(split + 1);
  if (!state.published.includes(name) || state.unavailable === name) {
    exit = 1;
  } else if ((state.delays[name] || 0) > 0) {
    state.delays[name]--;
    exit = 1;
  } else {
    state.visible.push(name);
    console.log(version);
  }
  if (exit) console.error('E404: version is not available');
} else {
  throw new Error('Unexpected npm command: ' + args);
}
fs.writeFileSync(file, JSON.stringify(state));
process.exit(exit);
`;

function simulate(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-publish-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    for (const [folder, manifest] of Object.entries(packages)) {
      mkdirSync(path.join(dir, folder), { recursive: true });
      writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(manifest));
    }
    writeFileSync(path.join(bin, 'npm'), npmMock);
    writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    for (const name of ['npm', 'sleep']) chmodSync(path.join(bin, name), 0o755);
    const stateFile = path.join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ published: [], delays: {}, calls: [], visible: [], ...options }));
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        PATHS_RELEASED: JSON.stringify(options.paths ?? paths), RELEASE_TEST_STATE: stateFile },
      encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(result.error);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    return { ...result, ...state, publishCalls: state.calls.filter(args => args[0] === 'publish').map(args => args[2]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('auth becoming available after the former five-minute limit still releases consumers', () => {
  const result = simulate({ delays: { [auth]: 70 } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publishCalls[0], 'packages/auth');
  assert.deepEqual(new Set(result.publishCalls), new Set(paths));
  for (const args of result.calls.filter(args => args[0] === 'view')) {
    assert.ok(args.includes('--prefer-online'), 'read fresh registry metadata');
    assert.ok(args.includes('--fetch-retries=0'));
    assert.ok(args.includes('--fetch-timeout=5000'));
  }
  for (const args of result.calls.filter(args => args[0] === 'publish')) {
    assert.ok(args.includes('--provenance'));
  }
});

test('the last server must be visible before the publish job can succeed', () => {
  const result = simulate({ paths: ['packages/notes'], published: [auth], delays: { [notes]: 3 } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.visible.includes(notes), 'new Notes version was checked after publication');
  assert.equal(result.delays[notes], 0);
});

test('a retry skips already published versions and finishes the remaining packages', () => {
  const result = simulate({ published: [auth, notes] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Set(result.publishCalls), new Set(['packages/roadmap', 'packages/api-hub']));
});

test('a completed release can be retried without publishing anything', () => {
  const result = simulate({ published: Object.values(packages).map(pkg => pkg.name) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publishCalls, []);
});

test('auth publication failure stops every consumer', () => {
  const result = simulate({ failPublish: auth });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.publishCalls, ['packages/auth']);
});

test('a server-only release cannot publish without its existing auth dependency', () => {
  const result = simulate({ paths: ['packages/notes'] });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.publishCalls, []);
});

test('unavailable auth eventually fails without publishing a consumer', () => {
  const result = simulate({ unavailable: auth });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.publishCalls, ['packages/auth']);
  assert.match(result.stderr, /not available|not yet available/);
});

test('an unavailable published server fails the job, keeping the bundle job blocked', () => {
  const result = simulate({ paths: ['packages/notes'], published: [auth], unavailable: notes });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.publishCalls, ['packages/notes']);
  assert.match(result.stderr, /E404/);
  assert.match(result.stderr, /Re-run failed jobs/);
});

test('an empty release does not publish any package', () => {
  const result = simulate({ paths: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test('an auth-only release also waits for registry visibility', () => {
  const result = simulate({ paths: ['packages/auth'], delays: { [auth]: 2 } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.publishCalls, ['packages/auth']);
  assert.ok(result.visible.includes(auth));
});
