#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SapWebAuthenticator } from '@marianfoo/sap-mcp-auth';
import { createRoadmapAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { SapRoadmapApiClient } from './roadmap-api.js';
import { DetailInputSchema, MarkdownInputSchema, RoadmapQueryInputSchema, SearchInputSchema } from './schemas.js';
import type { RoadmapQuery, ServerConfig } from './types.js';
import { PACKAGE_VERSION } from './version.js';

class SapRoadmapMcpServer {
  private config: ServerConfig;
  private authenticator: SapWebAuthenticator;
  private roadmapClient: SapRoadmapApiClient;
  private mcpServer: McpServer;
  private httpServer?: HttpServer;
  private streamableSessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    server: SapRoadmapMcpServer;
  }>();

  constructor() {
    this.config = loadConfig();
    this.authenticator = createRoadmapAuthenticator(this.config);
    this.roadmapClient = new SapRoadmapApiClient(this.config);
    this.mcpServer = new McpServer({
      name: 'sap-roadmap-mcp',
      version: PACKAGE_VERSION
    });

    this.setupTools();
  }

  async start(): Promise<void> {
    const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
    if (transport === 'streamable-http' || transport === 'http' || transport === 'streamable') {
      await this.startStreamableHttp();
      return;
    }

    await this.startStdio();
  }

  async authenticateOnly(): Promise<void> {
    await this.authenticator.ensureSession();
    logger.warn(`SAP Road Map authentication is valid. Cookie cache: ${this.config.tokenCacheFile}`);
    await this.closeRuntimeResources();
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, session] of this.streamableSessions) {
      this.streamableSessions.delete(sessionId);
      await session.transport.close().catch(error => logger.warn(`Failed to close Streamable HTTP transport ${sessionId}`, error));
      await session.server.shutdown().catch(error => logger.warn(`Failed to close Streamable HTTP server ${sessionId}`, error));
    }

    if (this.httpServer) {
      await new Promise<void>(resolveClose => this.httpServer!.close(() => resolveClose()));
      this.httpServer = undefined;
    }

    await this.mcpServer.close().catch(error => logger.warn('Failed to close MCP server', error));
    await this.closeRuntimeResources();
  }

  private async startStdio(): Promise<void> {
    logger.warn('Starting SAP Roadmap MCP Server over stdio');
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    logger.warn('SAP Roadmap MCP Server ready on stdio');
  }

  private async connectTransport(transport: StdioServerTransport | StreamableHTTPServerTransport): Promise<void> {
    await this.mcpServer.connect(transport);
  }

  private async startStreamableHttp(): Promise<void> {
    const port = Number.parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);
    const host = process.env.MCP_HOST || '127.0.0.1';
    const path = process.env.MCP_HTTP_PATH || '/mcp';

    this.httpServer = createServer(async (req, res) => {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      if (requestUrl.pathname !== path) {
        writeJsonRpcError(res, 404, `Not found. MCP endpoint is ${path}.`);
        return;
      }

      if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
        writeJsonRpcError(res, 405, 'Method not allowed.');
        return;
      }

      let parsedBody: unknown;
      let createdTransport: StreamableHTTPServerTransport | undefined;
      let createdServer: SapRoadmapMcpServer | undefined;

      try {
        if (req.method === 'POST') {
          parsedBody = await readJsonBody(req);
        }

        const sessionId = getSessionId(req);
        let session = sessionId ? this.streamableSessions.get(sessionId) : undefined;

        if (!session) {
          if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
            writeJsonRpcError(res, 400, 'Bad Request: initialize with POST before using this Streamable HTTP session.');
            return;
          }

          const sessionServer = new SapRoadmapMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: initializedSessionId => {
              this.streamableSessions.set(initializedSessionId, {
                transport,
                server: sessionServer
              });
              logger.warn(`SAP Roadmap Streamable HTTP session initialized: ${initializedSessionId}`);
            }
          });

          transport.onclose = () => {
            const initializedSessionId = transport.sessionId;
            if (initializedSessionId) {
              this.streamableSessions.delete(initializedSessionId);
              logger.warn(`SAP Roadmap Streamable HTTP session closed: ${initializedSessionId}`);
            }
            void sessionServer.closeRuntimeResources().catch(error => logger.warn('Failed to close Roadmap session runtime resources', error));
          };

          createdTransport = transport;
          createdServer = sessionServer;
          await sessionServer.connectTransport(transport);
          session = { transport, server: sessionServer };
        }

        await session.transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`SAP Roadmap Streamable HTTP request failed: ${message}`);
        if (createdTransport && !createdTransport.sessionId) {
          await createdTransport.close().catch(closeError => logger.warn('Failed to close failed Streamable HTTP transport', closeError));
          await createdServer?.shutdown().catch(closeError => logger.warn('Failed to shutdown failed Streamable HTTP server', closeError));
        }
        if (!res.headersSent) {
          writeJsonRpcError(res, 500, 'Internal server error.');
        }
      }
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      this.httpServer!.once('error', rejectListen);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off('error', rejectListen);
        resolveListen();
      });
    });

    logger.warn(`SAP Roadmap MCP Server ready over Streamable HTTP at http://${host}:${port}${path}`);
  }

  private async closeRuntimeResources(): Promise<void> {
    await this.authenticator.destroy();
  }

  private async withAuthRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { cookieHeader } = await this.authenticator.ensureSession();
    try {
      return await fn(cookieHeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SESSION_EXPIRED') || message.includes('401') || message.includes('Unauthorized')) {
        logger.warn('Roadmap session expired, re-authenticating and retrying once');
        this.authenticator.invalidateAuth();
        const { cookieHeader: newCookie } = await this.authenticator.ensureSession();
        return fn(newCookie);
      }
      throw error;
    }
  }

  private setupTools(): void {
    this.mcpServer.registerTool(
      'search',
      {
        title: 'Search SAP Road Map Items',
        description: 'Search SAP Road Map Explorer deliverables. Supports the same filters used by roadmaps.sap.com, for example PRODUCT=<id>, PROCESS=<id>, INDUSTRY=<id>, SC=<id>, BC=<id>, BD=<id>, BA=<id>.',
        inputSchema: SearchInputSchema
      },
      async ({ q, range, filters, markdown }) => {
        try {
          const query = this.normalizeQuery({ q, range, filters });
          const response = await this.withAuthRetry(token => this.roadmapClient.search(query, token));
          const items = this.roadmapClient.flattenSearchResponse(response);
          const summary = `Found ${response.numberOfDeliverables?.total ?? items.length} SAP Road Map deliverable(s) for "${query.q || ''}".`;
          const markdownText = markdown ? `\n\n${this.roadmapClient.toMarkdown(response, query)}` : '';

          return {
            content: [{ type: 'text', text: `${summary}${markdownText}` }],
            structuredContent: {
              query,
              counts: response.numberOfDeliverables,
              items,
              raw: response
            }
          };
        } catch (error) {
          return this.errorResult('Roadmap search failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'fetch_item',
      {
        title: 'Fetch SAP Road Map Item Details',
        description: 'Fetch detailed SAP Road Map Explorer innovation data by ID, including description, benefits, tags, and related deliverables when available.',
        inputSchema: DetailInputSchema
      },
      async ({ id }) => {
        try {
          const detail = await this.withAuthRetry(token => this.roadmapClient.details(id, token));
          let text = `# ${detail.title}\n\nID: ${detail.id}\n`;
          if (detail.description) text += `\n## Description\n\n${detail.description}\n`;
          if (detail.benefits) text += `\n## Benefits\n\n${detail.benefits}\n`;

          return {
            content: [{ type: 'text', text }],
            structuredContent: detail
          };
        } catch (error) {
          return this.errorResult('Roadmap item fetch failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'filters',
      {
        title: 'List SAP Road Map Filters',
        description: 'Return available Road Map Explorer filters for a query/range/current filter combination, including product, process, industry, capability, and domain filters with result counts.',
        inputSchema: RoadmapQueryInputSchema
      },
      async ({ q, range, filters }) => {
        try {
          const query = this.normalizeQuery({ q, range, filters });
          const response = await this.withAuthRetry(token => this.roadmapClient.filters(query, token));
          const groups = response.map(group => ({
            type: group.categoryTypeInformation.categoryType,
            name: group.categoryTypeInformation.namePlural || group.categoryTypeInformation.nameSingular || group.categoryTypeInformation.categoryType,
            filters: group.categoryFilters.map(filter => ({
              id: filter.category.id,
              title: filter.category.title,
              technicalType: filter.category.technicalType,
              count: filter.deliverablesCount
            }))
          }));

          return {
            content: [{ type: 'text', text: `Found ${groups.reduce((sum, group) => sum + group.filters.length, 0)} filter value(s).` }],
            structuredContent: { query, groups, raw: response }
          };
        } catch (error) {
          return this.errorResult('Roadmap filters failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'periods',
      {
        title: 'List SAP Road Map Periods',
        description: 'Return Road Map Explorer periods and deliverable counts for a query/range/current filter combination.',
        inputSchema: RoadmapQueryInputSchema
      },
      async ({ q, range, filters }) => {
        try {
          const query = this.normalizeQuery({ q, range, filters });
          const periods = await this.withAuthRetry(token => this.roadmapClient.periods(query, token));
          const nonEmpty = periods.filter(period => period.deliverableCount > 0);

          return {
            content: [{ type: 'text', text: `Found ${nonEmpty.length} period(s) with roadmap deliverables.` }],
            structuredContent: { query, periods }
          };
        } catch (error) {
          return this.errorResult('Roadmap periods failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'export_markdown',
      {
        title: 'Export SAP Road Map Items as Markdown',
        description: 'Search SAP Road Map Explorer and return a Markdown document grouped by period.',
        inputSchema: MarkdownInputSchema
      },
      async ({ q, range, filters, includeDetails }) => {
        try {
          const query = this.normalizeQuery({ q, range, filters });
          const response = await this.withAuthRetry(token => this.roadmapClient.search(query, token));
          const details = includeDetails
            ? await this.fetchDetailsForMarkdown(response)
            : undefined;
          const markdown = this.roadmapClient.toMarkdown(response, query, details);

          return {
            content: [{ type: 'text', text: markdown }],
            structuredContent: {
              query,
              counts: response.numberOfDeliverables,
              itemCount: this.roadmapClient.flattenSearchResponse(response).length
            }
          };
        } catch (error) {
          return this.errorResult('Roadmap markdown export failed', error);
        }
      }
    );
  }

  private normalizeQuery(query: RoadmapQuery): RoadmapQuery {
    return {
      q: query.q?.trim() || undefined,
      range: query.range || this.config.defaultRange,
      filters: query.filters || []
    };
  }

  private async fetchDetailsForMarkdown(response: ReturnType<SapRoadmapApiClient['search']> extends Promise<infer T> ? T : never) {
    const items = this.roadmapClient.flattenSearchResponse(response);
    const details = new Map<string, Awaited<ReturnType<SapRoadmapApiClient['details']>>>();
    const uniqueIds = [...new Set(items.map(item => item.id))];

    for (const id of uniqueIds) {
      try {
        const detail = await this.withAuthRetry(token => this.roadmapClient.details(id, token));
        details.set(id, detail);
      } catch (error) {
        logger.warn(`Failed to fetch detail for roadmap item ${id}`, error);
      }
    }

    return details;
  }

  private errorResult(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${prefix}: ${message}`);
    return {
      content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
      isError: true
    };
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (Array.isArray(header)) return header[0];
  return header;
}

function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message
    },
    id: null
  }));
}

function isDirectRun(): boolean {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? realpathSync(resolve(process.argv[1])) : '';
    return thisFile === invoked;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const server = new SapRoadmapMcpServer();
  process.on('SIGINT', () => server.shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => server.shutdown().then(() => process.exit(0)));
  const run = process.env.AUTH_LOGIN_ONLY === 'true'
    ? server.authenticateOnly()
    : server.start();

  run.catch(error => {
    logger.error('Failed to start SAP Roadmap MCP Server', error);
    process.exit(1);
  });
}

export { SapRoadmapMcpServer };
