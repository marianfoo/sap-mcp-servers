import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SapNoteMcpServer } from '../dist/mcp-server.js';
import { HttpSapNoteMcpServer } from '../dist/http-mcp-server.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sap-attachment-tool-'));
  const server = new SapNoteMcpServer();
  const body = Buffer.from('synthetic attachment');
  server.withAuthRetry = fn => fn('synthetic');
  server.sapNotesClient.fetchAttachment = async () => ({ body, contentType: 'application/pdf', bytes: body.length, suggestedFilename: 'note.pdf' });
  const client = new Client({ name: 'attachment-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.mcpServer.connect(b)]);
  t.after(async () => { await client.close(); await server.mcpServer.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, body, client, server, call: args => client.callTool({ name: 'fetch_attachment', arguments: { url: 'https://documents.support.sap.com/attachment.htm', ...args } }) };
}

test('the actual MCP tool saves the attachment and reports its hash', async t => {
  const { dir, body, call, client } = await fixture(t);
  const result = await call({ outputDir: dir });
  assert.ok(!result.isError);
  assert.deepEqual(await readFile(result.structuredContent.path), body);
  assert.equal(result.structuredContent.filename, 'note.pdf');
  assert.equal(result.structuredContent.sha256, createHash('sha256').update(body).digest('hex'));
  const tools = (await client.listTools()).tools;
  const tool = tools.find(tool => tool.name === 'fetch_attachment');
  assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(tool.outputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const manifest = JSON.parse(await readFile(new URL('../mcpb-bundle/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.tools.map(tool => tool.name).sort(), tools.map(tool => tool.name).sort());
});

test('an existing file is never overwritten', async t => {
  const { dir, call } = await fixture(t);
  const target = join(dir, 'note.pdf');
  await writeFile(target, 'keep this');
  const result = await call({ outputDir: dir });
  assert.equal(result.isError, true);
  assert.equal(await readFile(target, 'utf8'), 'keep this');
});

test('a symlink cannot redirect the write outside the selected directory', async t => {
  const { dir, call } = await fixture(t);
  const outside = join(dir, 'outside.txt');
  await writeFile(outside, 'keep this');
  const output = await mkdtemp(join(dir, 'output-'));
  try { await symlink(outside, join(output, 'note.pdf')); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Symlink creation unavailable'); throw error; }
  const result = await call({ outputDir: output });
  assert.equal(result.isError, true);
  assert.equal(await readFile(outside, 'utf8'), 'keep this');
});

test('concurrent downloads with the same output name cannot overwrite one another', async t => {
  const { dir, call, body } = await fixture(t);
  const results = await Promise.all([call({ outputDir: dir }), call({ outputDir: dir })]);
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.deepEqual(await readFile(join(dir, 'note.pdf')), body);
});

test('the default output lives in its own temporary directory', async t => {
  const { call } = await fixture(t);
  const filename = `sap-audit-${randomUUID()}.pdf`;
  const result = await call({ filename });
  assert.ok(!result.isError);
  const path = result.structuredContent.path;
  t.after(() => rm(dirname(path) === tmpdir() ? path : dirname(path), { recursive: true, force: true }));
  assert.notEqual(dirname(path), tmpdir());
  assert.equal(basename(path), filename);
});

test('filename precedence and confinement work with literal percent signs and legacy escapes', async t => {
  const { dir, call, server, body } = await fixture(t);
  for (const [index, example] of [
    { filename: '../caller.pdf', suggestedFilename: 'server.pdf', url: '50%.htm', expected: 'caller.pdf' },
    { suggestedFilename: '..\\..\\server.pdf', url: '50%.htm', expected: 'server.pdf' },
    { url: '50%.pdf', expected: '50%.pdf' },
    { url: '%FC.pdf', expected: '%FC.pdf' }
  ].entries()) {
    server.sapNotesClient.fetchAttachment = async () => ({ body, bytes: body.length,
      contentType: 'application/pdf', suggestedFilename: example.suggestedFilename });
    const outputDir = await mkdtemp(join(dir, `case-${index}-`));
    const result = await call({ url: `https://documents.support.sap.com/${example.url}`, filename: example.filename, outputDir });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.equal(result.structuredContent.path, join(outputDir, example.expected));
  }
});

test('invalid URL or output directory is rejected before login or download', async t => {
  const { dir, call, server } = await fixture(t);
  const regularFile = join(dir, 'existing.pdf');
  await writeFile(regularFile, 'keep this');
  let calls = 0;
  server.withAuthRetry = async () => { calls++; throw new Error('must not authenticate'); };
  for (const args of [{ url: 'https://example.com/file', outputDir: dir },
    { outputDir: join(dir, 'missing') }, { outputDir: regularFile }]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refusing attachment host|Output directory does not exist/);
  }
  assert.equal(calls, 0);
  assert.equal(await readFile(regularFile, 'utf8'), 'keep this');
});

test('a failed write removes its own partial file without deleting unrelated files', async t => {
  const { dir, call } = await fixture(t);
  const handle = await open(join(dir, 'keep.txt'), 'wx');
  await handle.writeFile('keep this');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const write = prototype.writeFile;
  t.mock.method(prototype, 'writeFile', async function(body) {
    await write.call(this, body.subarray(0, 4));
    throw new Error('synthetic disk full');
  });
  const result = await call({ outputDir: dir });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /synthetic disk full/);
  await assert.rejects(readFile(join(dir, 'note.pdf')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'keep this');
});

test('the HTTP server does not expose the local file-writing tool', async t => {
  const server = new HttpSapNoteMcpServer();
  const mcp = server.createMcpServer();
  const client = new Client({ name: 'attachment-http-tools-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await mcp.close(); });
  await Promise.all([client.connect(a), mcp.connect(b)]);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['fetch', 'search']);
});
