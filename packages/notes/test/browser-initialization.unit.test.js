import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { SapNotesApiClient } from '../dist/sap-notes-api.js';

function fixture(t) {
  const client = new SapNotesApiClient({ headful: false });
  client.buildStorageStateFromTokenCache = async () => undefined;
  const context = {};
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
    close: async () => {}
  };
  t.after(() => client.cleanup());
  return { client, browser, context };
}

for (const state of ['cold', 'idle']) {
  test(`concurrent ${state} browser initialization shares one launch and context`, async t => {
    const { client, browser, context } = fixture(t);
    let oldBrowserCloses = 0;
    if (state === 'idle') {
      client.browser = {
        isConnected: () => true,
        close: async () => { oldBrowserCloses++; }
      };
      client.browserContext = {};
      client.browserLastUsed = Date.now() - 6 * 60 * 1000;
    }
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const launch = t.mock.method(chromium, 'launch', async () => {
      await gate;
      return browser;
    });

    const first = client.ensurePersistentBrowser('synthetic');
    const second = client.ensurePersistentBrowser('synthetic');
    release();
    await Promise.all([first, second]);

    assert.equal(launch.mock.callCount(), 1);
    assert.equal(oldBrowserCloses, state === 'idle' ? 1 : 0);
    assert.equal(client.browser, browser);
    assert.equal(client.browserContext, context);
    await client.ensurePersistentBrowser('synthetic');
    assert.equal(launch.mock.callCount(), 1, 'a ready browser remains reusable');
  });
}

test('a caller arriving during context setup waits for that context', async t => {
  const { client, browser, context } = fixture(t);
  let releaseContext;
  const gate = new Promise(resolve => { releaseContext = resolve; });
  let contextStarted;
  const started = new Promise(resolve => { contextStarted = resolve; });
  browser.newContext = async () => {
    contextStarted();
    await gate;
    return context;
  };
  const launch = t.mock.method(chromium, 'launch', async () => browser);

  const first = client.ensurePersistentBrowser('synthetic');
  await started;
  const second = client.ensurePersistentBrowser('synthetic').then(() => {
    assert.equal(client.browserContext, context);
  });
  releaseContext();
  await Promise.all([first, second]);
  assert.equal(launch.mock.callCount(), 1);
});

test('concurrent launch failures reach both callers and allow a later retry', async t => {
  const { client, browser } = fixture(t);
  const error = new Error('synthetic launch failure');
  const launch = t.mock.method(chromium, 'launch', async () => { throw error; });

  const results = await Promise.allSettled([
    client.ensurePersistentBrowser('synthetic'),
    client.ensurePersistentBrowser('synthetic')
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, error);
  }
  assert.equal(launch.mock.callCount(), 1);

  launch.mock.mockImplementation(async () => browser);
  await client.ensurePersistentBrowser('synthetic');
  assert.equal(launch.mock.callCount(), 2);
  assert.equal(client.browser, browser);
});
