import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HttpSapNoteMcpServer } from '../dist/http-mcp-server.js';

test('initializes and lists Notes tools through the authenticated HTTP endpoint', async (t) => {
  const previousAccessToken = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = 'http-transport-test-token';
  t.after(() => {
    if (previousAccessToken === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = previousAccessToken;
  });

  const server = new HttpSapNoteMcpServer();
  const listener = server.app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
    listener.closeAllConnections();
  }));
  await once(listener, 'listening');

  const endpoint = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
  const unauthorized = await fetch(endpoint, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();

  const client = new Client({ name: 'http-transport-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } },
    }));
    assert.equal(client.getServerVersion()?.name, 'sap-note-search-mcp');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['search', 'fetch', 'support_package_notes']);
  } finally {
    await client.close();
  }
});
