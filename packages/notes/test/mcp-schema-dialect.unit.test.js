import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  NoteGetInputMcpSchema,
  NoteGetOutputMcpSchema,
  NoteSearchInputMcpSchema,
  NoteSearchOutputMcpSchema,
} from '../dist/schemas/sap-notes.js';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

test('advertises all SAP Notes tool schemas as JSON Schema 2020-12', async () => {
  const server = new McpServer({ name: 'schema-test-server', version: '1.0.0' });

  server.registerTool(
    'search',
    {
      inputSchema: NoteSearchInputMcpSchema,
      outputSchema: NoteSearchOutputMcpSchema,
    },
    async () => ({ content: [{ type: 'text', text: '' }], structuredContent: {} }),
  );
  server.registerTool(
    'fetch',
    {
      inputSchema: NoteGetInputMcpSchema,
      outputSchema: NoteGetOutputMcpSchema,
    },
    async () => ({ content: [{ type: 'text', text: '' }], structuredContent: {} }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-test-client', version: '1.0.0' });

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['search', 'fetch']);

    for (const tool of tools) {
      assert.equal(tool.inputSchema.$schema, JSON_SCHEMA_2020_12);
      assert.equal(tool.outputSchema?.$schema, JSON_SCHEMA_2020_12);
      assert.doesNotMatch(JSON.stringify(tool), /draft-07/);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
