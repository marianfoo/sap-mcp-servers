#!/usr/bin/env node
/** Live check of the actual MCP tools: node scripts/test-attachments.mjs NOTE_ID [NOTE_ID ...] */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SapNoteMcpServer } from '../dist/mcp-server.js';

const ids = process.argv.slice(2);
if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
  console.error('Usage: node scripts/test-attachments.mjs NOTE_ID [NOTE_ID ...]');
  process.exit(1);
}
// Use the server's normal configuration (ENV_FILE/env vars/shared SSO).
// Pick notes known to contain an attachment; zero downloads can never pass.
const server = new SapNoteMcpServer();
const client = new Client({ name: 'attachment-live-check', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
const dir = await mkdtemp(join(tmpdir(), 'sap-attachments-live-'));
try {
  await Promise.all([client.connect(a), server.mcpServer.connect(b)]);
  for (const id of ids) {
    const note = await client.callTool({ name: 'fetch', arguments: { id } });
    assert.ok(!note.isError, `Note ${id} could not be fetched`);
    const attachment = note.structuredContent?.attachments?.find(item => item.url);
    assert.ok(attachment, `Note ${id} did not return an attachment URL`);
    const outputDir = await mkdtemp(join(dir, `${id}-`));
    const result = await client.callTool({ name: 'fetch_attachment', arguments: { url: attachment.url, outputDir } });
    assert.ok(!result.isError, `Attachment download failed for note ${id}: ${result.content?.[0]?.text}`);
    const output = result.structuredContent;
    const body = await readFile(output.path);
    assert.ok(body.length > 0);
    assert.equal(body.length, output.bytes);
    assert.equal(createHash('sha256').update(body).digest('hex'), output.sha256);
    console.log(JSON.stringify({ note: id, host: new URL(attachment.url).hostname,
      bytes: body.length, contentType: output.contentType, sha256: output.sha256 }));
  }
  console.log(`${ids.length} real attachment download(s) passed`);
} finally {
  await client.close();
  await server.mcpServer.close();
  await server.sapNotesClient.cleanup();
  await server.authenticator.destroy();
  await rm(dir, { recursive: true, force: true });
}
