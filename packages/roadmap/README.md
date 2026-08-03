# SAP Roadmap MCP Server

> Part of the [**sap-mcp-servers**](../../README.md) monorepo (npm workspaces) — published to npm independently as `sap-roadmap-mcp` with [build provenance](https://docs.npmjs.com/generating-provenance-statements).

MCP server for SAP Road Map Explorer (`roadmaps.sap.com`) using cookie-backed API calls. Authentication can use SAP username/password or SAP Passport/PFX certificate auth. In `AUTH_METHOD=auto`, username/password is preferred when both password and PFX are configured, matching `mcp-sap-notes`. The browser is used only to authenticate and collect SAP session cookies; all Roadmap data retrieval uses HTTP API endpoints.

## Important Warning

This project is unofficial and is not endorsed by SAP. It uses authenticated SAP Road Map Explorer web endpoints and browser session cookies in ways that may be restricted by SAP terms of service, SAP account terms, or your organization's policies. Publishing, installing, or using this package does not grant permission to automate SAP services.

Use this MCP server only at your own risk. You are responsible for checking whether this usage is allowed for your SAP account, tenant, data, and jurisdiction. Do not use it for production, broad distribution, or shared access unless you have explicit approval.

## Install From npm

```bash
npm install -g sap-roadmap-mcp
# or use npx without a global install (see MCP config below)
```

On first install, the package runs `playwright install chromium` for SAP login. To skip that (for example in CI), set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and run `npm run install:browsers` in the package directory when you need auth.

Copy `env.example` to a path outside the package (for example `~/.config/sap-roadmap-mcp/.env`) and point the server at it:

```env
ENV_FILE=/absolute/path/to/.env
ROADMAP_TOKEN_CACHE_FILE=/absolute/path/to/roadmap-token-cache.json
```

## Development Setup

This package lives in the [`sap-mcp-servers`](../../README.md) monorepo — clone and build from the repo root:

```bash
git clone https://github.com/marianfoo/sap-mcp-servers.git
cd sap-mcp-servers
npm install          # installs all workspaces + links @marianfoo/sap-mcp-auth locally
npm run build        # builds auth first, then the servers → this one lands in packages/roadmap/dist
```

Build just this package with `npm run build -w sap-roadmap-mcp` (after auth is built).

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

The default is headless browser login (`HEADFUL=false`). Set `HEADFUL=true` only when MFA or manual login is required. After cookies are cached in `roadmap-token-cache.json` in the server working directory, switch it back to `false`.

Roadmap auth first opens the shared SAP login start URL (`SAP_LOGIN_URL`, default `https://me.sap.com/home`) to establish SAP SSO, then opens `roadmaps.sap.com/board` to mint Roadmap-specific cookies. Without a certificate, Roadmap redirects through SAP IAS to an `accounts.sap.com` "Central IT Prod: Sign In" page with a two-step form: username/email, then password. The server handles that flow and caches only cookies that a browser would actually send to `roadmaps.sap.com`; other SSO-chain cookies are kept only in the optional shared browser storage state.

If headless password login appears to complete but the API still returns login HTML, the server rejects those cookies and does not cache them. This usually means the SAP account requires MFA or another interactive step. For non-visible auth, configure SAP Passport/PFX and either set `AUTH_METHOD=certificate` or remove the password pair so `auto` can choose certificate auth.

For a one-time username/password + MFA bootstrap, run:

```bash
npm run auth:login
```

This starts a headful browser only for login, validates the collected cookies against the Roadmap JSON API, writes `roadmap-token-cache.json`, and exits. Restart your MCP client afterward; normal MCP runs can stay `HEADFUL=false`.

Set `SAP_SSO_STORAGE_STATE` to a shared file, for example `~/.sap-mcp/sso-storage-state.json`, if you want Roadmap and other SAP MCP servers to reuse the same `accounts.sap.com` browser SSO cookies. Each app still needs its own app-specific token cache.

## Browser And API Boundary

- Browser automation is limited to `src/auth.ts`, where Playwright opens SAP login and collects cookies. It runs headless unless `HEADFUL=true`.
- Roadmap tools do not scrape pages or inspect DOM content.
- Roadmap data comes from API calls in `src/roadmap-api.ts`, including `/services/deliverable-search/search`, `/services/deliverable-search/filter`, `/services/deliverable-search/periods`, and `/services/innovation/details/{id}`.

For installed/package usage you can point the server at an explicit env file and token cache path:

```bash
ENV_FILE=/absolute/path/to/.env
ROADMAP_TOKEN_CACHE_FILE=/absolute/path/to/roadmap-token-cache.json
```

## Transports

The default transport is local `stdio`, which is what desktop MCP clients usually expect:

```bash
npm run serve:stdio
```

The same server can also run as a Streamable HTTP MCP server:

```bash
MCP_TRANSPORT=streamable-http MCP_PORT=3000 npm run serve:http
```

Default HTTP endpoint:

```text
http://127.0.0.1:3000/mcp
```

Config knobs:

```env
MCP_TRANSPORT=stdio          # stdio | streamable-http
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_HTTP_PATH=/mcp
```

## Stdio MCP Client Config

Credentials can be set directly in the MCP client `env` block (no `.env` file required). Values from `mcp.json` take precedence over any `.env` file on disk.

Password auth:

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "command": "npx",
      "args": ["-y", "sap-roadmap-mcp"],
      "env": {
        "AUTH_METHOD": "password",
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password",
        "ROADMAP_TOKEN_CACHE_FILE": "/absolute/path/to/roadmap-token-cache.json"
      }
    }
  }
}
```

Certificate (PFX) auth:

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "command": "npx",
      "args": ["-y", "sap-roadmap-mcp"],
      "env": {
        "AUTH_METHOD": "certificate",
        "PFX_PATH": "/absolute/path/to/sap-passport.pfx",
        "PFX_PASSPHRASE": "your-passphrase",
        "ROADMAP_TOKEN_CACHE_FILE": "/absolute/path/to/roadmap-token-cache.json"
      }
    }
  }
}
```

`auto` tries password first, then certificate (same as `env.example`):

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "command": "npx",
      "args": ["-y", "sap-roadmap-mcp"],
      "env": {
        "AUTH_METHOD": "auto",
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password",
        "PFX_PATH": "/absolute/path/to/sap-passport.pfx",
        "PFX_PASSPHRASE": "your-passphrase",
        "ROADMAP_TOKEN_CACHE_FILE": "/absolute/path/to/roadmap-token-cache.json"
      }
    }
  }
}
```

Optional: load a `.env` file instead of inline secrets:

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "command": "npx",
      "args": ["-y", "sap-roadmap-mcp"],
      "env": {
        "ENV_FILE": "/absolute/path/to/.env",
        "ROADMAP_TOKEN_CACHE_FILE": "/absolute/path/to/roadmap-token-cache.json"
      }
    }
  }
}
```

Use absolute paths for `PFX_PATH` and cache files when using `npx` (working directory may vary). For MFA bootstrap, add `"HEADFUL": "true"` temporarily or run `npm run auth:login`.

Global install: replace `"command": "npx", "args": ["-y", "sap-roadmap-mcp"]` with `"command": "sap-roadmap-mcp"`.

Local development:

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "command": "node",
      "args": ["/absolute/path/to/sap-roadmap-mcp/dist/mcp-server.js"],
      "env": {
        "SAP_USERNAME": "your.email@company.com",
        "SAP_PASSWORD": "your_sap_password"
      }
    }
  }
}
```

## Streamable HTTP MCP Client Config

Use this when the client supports MCP Streamable HTTP:

```json
{
  "mcpServers": {
    "sap-roadmap": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Tools

- `search` - search roadmap deliverables, optionally returning Markdown.
- `filters` - list available filters and counts for a search.
- `periods` - list roadmap periods and deliverable counts.
- `fetch_item` - fetch one roadmap item by ID from `/services/innovation/details/{id}`.
- `export_markdown` - return a Markdown document grouped by period, optionally enriched with item details.

Filters use the same query keys as the web app. Example:

```json
{
  "q": "work zone",
  "range": "CURRENT-LAST",
  "filters": [
    {
      "type": "PRODUCT",
      "id": "42F2E964FAAF1EDAACA615BDFC0FC0E8"
    }
  ]
}
```

## Work Zone Markdown Test

After filling `.env`, run:

```bash
npm run export:workzone
```

This writes `docs/workzone-roadmap.md` using query `work zone` and range `CURRENT-LAST`.

By default it also fetches item details so benefits are included. Disable that with:

```bash
ROADMAP_EXPORT_INCLUDE_DETAILS=false npm run export:workzone
```

## Publishing To npm

Prerequisites:

1. npm account with publish rights to the `sap-roadmap-mcp` name (currently unclaimed on npm).
2. `npm login` on the machine you publish from.
3. Optional but recommended: add `repository`, `homepage`, and `bugs` in `package.json` after pushing the project to GitHub.

Pre-publish checks:

```bash
npm run pack:check
```

Confirm the tarball lists only `dist/`, `scripts/postinstall.mjs`, `README.md`, `env.example`, `LICENSE`, and `package.json`. It must not include `.env`, `roadmap-token-cache.json`, or `.playwright-mcp/`.

Publish:

```bash
npm publish --access public
```

For a scoped package use `@scope/sap-roadmap-mcp` and `"publishConfig": { "access": "public" }`. This project publishes unscoped as `sap-roadmap-mcp`.

The npm package is allowlisted via the `files` field in `package.json`. Never publish `.env`, token cache files, Playwright traces, screenshots, or generated customer-specific exports.
