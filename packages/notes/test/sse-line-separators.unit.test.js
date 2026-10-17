import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HttpSapNoteMcpServer } from '../dist/http-mcp-server.js';
import { createLineSeparatorEscaper, escapeSseLineSeparators } from '../dist/sse-line-separators.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const BACKSLASH = String.fromCharCode(0x5c);
const escapedForm = (text) => text.split(LS).join(`${BACKSLASH}u2028`).split(PS).join(`${BACKSLASH}u2029`).split(NEL).join(`${BACKSLASH}u0085`);

// What Python's str.splitlines() treats as a line break (the client behaviour behind the bug).
const PY_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);
const pySplitLines = (t) => { const out = []; let s = 0; for (let i = 0; i < t.length; i++) { if (PY_BREAKS.has(t.charCodeAt(i))) { out.push(t.slice(s, i)); if (t.charCodeAt(i) === 0x0d && t.charCodeAt(i + 1) === 0x0a) i++; s = i + 1; } } out.push(t.slice(s)); return out; };

test('escaper rewrites U+2028/U+2029 and leaves other multi-byte characters alone', () => {
  const escaper = createLineSeparatorEscaper();
  const input = `a${LS}b${PS}cô€${LS}`;
  const out = Buffer.concat([escaper.push(Buffer.from(input)), escaper.flush()]).toString('utf8');
  assert.equal(out, escapedForm(input));
  assert.ok(out.includes('ô€'));
});

test('escaper handles a separator split across any chunk boundary', () => {
  const input = Buffer.from(`data: {"t":"a${LS}b${PS}c€©\u00a0\u2019${LS}${NEL}end"}\n\n`);
  const expected = escapedForm(input.toString('utf8'));
  for (let split = 0; split <= input.length; split++) {
    const escaper = createLineSeparatorEscaper();
    const out = Buffer.concat([
      escaper.push(input.subarray(0, split)),
      escaper.push(input.subarray(split)),
      escaper.flush()
    ]).toString('utf8');
    assert.equal(out, expected, `split at byte ${split}`);
  }
});

test('escaper flushes a dangling partial sequence unchanged', () => {
  for (const bytes of [[0x61, 0xe2, 0x80], [0xe2], [0xc2]]) {
    const escaper = createLineSeparatorEscaper();
    const out = Buffer.concat([escaper.push(Buffer.from(bytes)), escaper.flush()]);
    assert.deepEqual([...out], bytes);
  }
});

test('middleware escapes SSE responses (writeHead and setHeader) and leaves JSON untouched', async (t) => {
  const payload = `data: {"t":"a${LS}b${PS}c"}\n\n`;
  const app = express();
  app.use(escapeSseLineSeparators);
  app.get('/sse-writehead', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(payload);
    res.write(bytes.subarray(0, 14)); // splits inside the first U+2028 (E2 | 80 A8)
    res.end(bytes.subarray(14));
  });
  app.get('/sse-setheader', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.write(payload);
    res.end();
  });
  app.get('/json', (_req, res) => {
    res.json({ t: `a${LS}b` });
  });

  const listener = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
    listener.closeAllConnections();
  }));
  await once(listener, 'listening');
  const base = `http://127.0.0.1:${listener.address().port}`;
  const get = async (path) => {
    const response = await fetch(base + path);
    return { text: await response.text(), length: response.headers.get('content-length') };
  };

  assert.equal((await get('/sse-writehead')).text, escapedForm(payload));
  assert.equal((await get('/sse-setheader')).text, escapedForm(payload));

  const json = await get('/json');
  assert.equal(Number(json.length), Buffer.byteLength(json.text), 'Content-Length still matches the body');
  assert.equal(JSON.parse(json.text).t, `a${LS}b`);
});

test('HTTP endpoint: note text with U+2028 survives a line-splitting SSE reader', async (t) => {
  const previousAccessToken = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = 'sse-line-separators-test-token';
  t.after(() => {
    if (previousAccessToken === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = previousAccessToken;
  });

  const noteText = `${'a'.repeat(3000)}${LS}step 1${PS}ô€${LS}${NEL}end`;
  const server = new HttpSapNoteMcpServer();
  server.createMcpServer = () => {
    const mcp = new McpServer({ name: 'sap-note-search-mcp', version: 'test' });
    mcp.registerTool('fetch', { description: 'test', inputSchema: { id: z.string() } },
      async () => ({ content: [{ type: 'text', text: noteText }] }));
    return mcp;
  };

  const listener = server.app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
    listener.closeAllConnections();
  }));
  await once(listener, 'listening');

  const response = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch', arguments: { id: '1' } } })
  });
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const raw = await response.text();

  assert.ok(!raw.includes(LS) && !raw.includes(PS), 'no raw U+2028/U+2029 on the wire');
  const dataLine = pySplitLines(raw).find((line) => line.startsWith('data:'));
  const message = JSON.parse(dataLine.slice(5));
  assert.equal(message.result.content[0].text, noteText, 'the note text is unchanged after decoding');
});
