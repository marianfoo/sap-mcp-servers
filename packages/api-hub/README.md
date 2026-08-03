# SAP API Hub MCP Server

> Part of the [**sap-mcp-servers**](../../README.md) monorepo (npm workspaces) — published to npm independently as `sap-api-hub-mcp` with [build provenance](https://docs.npmjs.com/generating-provenance-statements).

TypeScript MCP server for read-only SAP Business Accelerator Hub catalog access.

The server logs in to [api.sap.com](https://api.sap.com/) through Playwright, caches browser cookies, then exposes MCP tools for catalog categories, search, metadata, resources, specs, and packages. Authentication can use SAP username/password or SAP Passport/PFX certificate auth. In `AUTH_METHOD=auto`, username/password is preferred when both password and PFX are configured, matching `mcp-sap-notes`. The browser is used only to authenticate and collect SAP session cookies; all API Hub data retrieval uses HTTP catalog/spec endpoints.

## Important Warning

This project is unofficial and is not endorsed by SAP. It uses authenticated SAP Business Accelerator Hub web/catalog endpoints and browser session cookies in ways that may be restricted by SAP terms of service, SAP account terms, or your organization's policies. Publishing, installing, or using this package does not grant permission to automate SAP services.

Use this MCP server only at your own risk. You are responsible for checking whether this usage is allowed for your SAP account, tenant, data, and jurisdiction. Do not use it for production, broad distribution, or shared access unless you have explicit approval.

## Install From npm

```bash
npm install -g sap-api-hub-mcp
# or use npx without a global install (see MCP config below)
```

On first install, the package runs `playwright install chromium` for SAP login. To skip that (for example in CI), set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and run `npm run install:browsers` in the package directory when you need auth.

Copy `env.example` to a path outside the package (for example `~/.config/sap-api-hub-mcp/.env`) and point the server at it:

```env
ENV_FILE=/absolute/path/to/.env
API_HUB_TOKEN_CACHE_FILE=/absolute/path/to/api-hub-token-cache.json
```

## Development Setup

This package lives in the [`sap-mcp-servers`](../../README.md) monorepo — clone and build from the repo root:

```bash
git clone https://github.com/marianfoo/sap-mcp-servers.git
cd sap-mcp-servers
npm install                # installs all workspaces + links @marianfoo/sap-mcp-auth locally
npm run install:browsers   # one-time: Chromium for Playwright login
npm run build              # builds auth first, then the servers → this one lands in packages/api-hub/dist
```

Build just this package with `npm run build -w sap-api-hub-mcp` (after auth is built).

Fill the scaffolded `.env`:

```env
AUTH_METHOD=auto
SAP_USERNAME=your.email@company.com
SAP_PASSWORD="your_sap_password"
HEADFUL=false
```

When using a `.env` file, quote any value containing `#`; dotenv otherwise treats `#` and everything after it as a comment. For example, use `SAP_PASSWORD="My#Pass"`. The same applies to `PFX_PASSPHRASE`.

Optional SAP Passport/PFX fallback:

```env
PFX_PATH=/absolute/path/to/sap-passport.pfx
PFX_PASSPHRASE="your-passphrase"
```

`AUTH_METHOD=auto` chooses auth in this order:

1. `SAP_USERNAME` + `SAP_PASSWORD`
2. `PFX_PATH` + `PFX_PASSPHRASE`

Set `AUTH_METHOD=password` or `AUTH_METHOD=certificate` to force one path.

The default is headless browser login (`HEADFUL=false`). If SAP requires MFA or manual login, set:

```bash
HEADFUL=true
```

The cookie cache is stored in `api-hub-token-cache.json` in the server working directory and expires after `MAX_COOKIE_AGE_H` hours.

API Hub auth first opens the shared SAP login start URL (`SAP_LOGIN_URL`, default `https://me.sap.com/home`) to establish SAP SSO, then opens `api.sap.com` to mint API Hub-specific cookies. Set `SAP_SSO_STORAGE_STATE`, for example `~/.sap-mcp/sso-storage-state.json`, if you want SAP MCP servers to reuse the same `accounts.sap.com` browser SSO cookies. Each app still keeps its own app-specific token cache.

For installed/package usage you can point the server at an explicit env file and token cache path:

```bash
ENV_FILE=/absolute/path/to/.env
API_HUB_TOKEN_CACHE_FILE=/absolute/path/to/api-hub-token-cache.json
```

## Browser And API Boundary

- Browser automation is limited to `src/auth.ts`, where Playwright opens SAP login and collects cookies. It runs headless unless `HEADFUL=true`.
- API Hub tools do not scrape pages or inspect DOM content.
- API Hub data comes from HTTP calls in `src/api-hub-client.ts`, including `/api/1.0/containergroup/ContentTypes`, `/api/1.0/searchservice`, `/odata/1.0/catalog.svc/...`, and `$value` spec endpoints.

## Build

```bash
npm run build
```

## Run

Local stdio mode, for desktop MCP clients:

```bash
npm run serve:stdio
```

Streamable HTTP mode:

```bash
MCP_TRANSPORT=streamable-http MCP_PORT=3001 npm run serve:http
```

Default HTTP endpoint:

```text
http://127.0.0.1:3001/mcp
```

Config knobs:

```env
MCP_TRANSPORT=stdio          # stdio | streamable-http
MCP_HOST=127.0.0.1
MCP_PORT=3001
MCP_HTTP_PATH=/mcp
```

## Stdio MCP Client Config

Credentials can be set directly in the MCP client `env` block (no `.env` file required). Values from `mcp.json` take precedence over any `.env` file on disk.

Password auth:

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "command": "npx",
      "args": ["-y", "sap-api-hub-mcp"],
      "env": {
        "AUTH_METHOD": "password",
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password",
        "API_HUB_TOKEN_CACHE_FILE": "/absolute/path/to/api-hub-token-cache.json",
        "MCP_MODE": "true"
      }
    }
  }
}
```

Certificate (PFX) auth:

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "command": "npx",
      "args": ["-y", "sap-api-hub-mcp"],
      "env": {
        "AUTH_METHOD": "certificate",
        "PFX_PATH": "/absolute/path/to/sap-passport.pfx",
        "PFX_PASSPHRASE": "your-passphrase",
        "API_HUB_TOKEN_CACHE_FILE": "/absolute/path/to/api-hub-token-cache.json",
        "MCP_MODE": "true"
      }
    }
  }
}
```

`auto` tries password first, then certificate (same as `env.example`):

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "command": "npx",
      "args": ["-y", "sap-api-hub-mcp"],
      "env": {
        "AUTH_METHOD": "auto",
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password",
        "PFX_PATH": "/absolute/path/to/sap-passport.pfx",
        "PFX_PASSPHRASE": "your-passphrase",
        "API_HUB_TOKEN_CACHE_FILE": "/absolute/path/to/api-hub-token-cache.json",
        "MCP_MODE": "true"
      }
    }
  }
}
```

Optional: load a `.env` file instead of inline secrets:

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "command": "npx",
      "args": ["-y", "sap-api-hub-mcp"],
      "env": {
        "ENV_FILE": "/absolute/path/to/.env",
        "API_HUB_TOKEN_CACHE_FILE": "/absolute/path/to/api-hub-token-cache.json",
        "MCP_MODE": "true"
      }
    }
  }
}
```

Use absolute paths for `PFX_PATH` and cache files when using `npx` (working directory may vary). For MFA bootstrap, add `"HEADFUL": "true"` temporarily.

Global install: replace `"command": "npx", "args": ["-y", "sap-api-hub-mcp"]` with `"command": "sap-api-hub-mcp"`.

Local development:

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "command": "node",
      "args": ["/absolute/path/to/sap-api-hub-mcp/dist/mcp-server.js"],
      "env": {
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password",
        "MCP_MODE": "true"
      }
    }
  }
}
```

Supported `env` keys: `SAP_USERNAME`, `SAP_PASSWORD`, `PFX_PATH`, `PFX_PASSPHRASE`, `AUTH_METHOD`, `HEADFUL`, `MFA_TIMEOUT`, `API_HUB_TOKEN_CACHE_FILE`, `SAP_SSO_STORAGE_STATE`, `ENV_FILE`, `MCP_MODE`.

Streamable HTTP MCP client config:

```json
{
  "mcpServers": {
    "sap-api-hub": {
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

## Tools

- `categories` - list API Hub content categories and counts.
- `search` - search catalog artifacts, optionally constrained by category or artifact type.
- `fetch` - fetch normalized metadata for APIs, Events, CDS Views, generic artifacts, or packages.
- `resources` - summarize API paths, Event channels, CDS fields, or generic artifact sections.
- `spec` - return full OpenAPI, AsyncAPI, EDMX, CDS JSON, or raw artifact values on explicit request.
- `package` - fetch package metadata, docs, and artifacts grouped by type/subtype.

## Safety Boundaries

- This server is read-only.
- It does not call business or sandbox API endpoints.
- It does not retrieve or expose the user's SAP API key.
- Full specifications are returned only by the explicit `spec` tool.

## Publishing Safety

Before publishing or sharing a package, run:

```bash
npm run publish:check
```

The npm package is allowlisted to built code, this README, `env.example`, `LICENSE`, and `package.json`. Never publish `.env`, token cache files, Playwright traces, screenshots, or generated customer-specific exports.

See [PUBLISHING.md](./PUBLISHING.md) for the full npmjs release checklist.

## Examples

Search APIs:

```json
{
  "q": "sales order",
  "categoryKey": "API",
  "artifactType": "API",
  "top": 5
}
```

Fetch API overview:

```json
{
  "id": "salesorder",
  "kind": "api"
}
```

Get API resources:

```json
{
  "id": "salesorder",
  "kind": "api"
}
```

Get OpenAPI JSON:

```json
{
  "id": "salesorder",
  "kind": "api",
  "format": "json"
}
```
