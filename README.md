# SAP MCP Servers

Monorepo for the SAP **Model Context Protocol (MCP)** servers and the shared SAP authentication
module they build on. Managed with **npm workspaces**.

These servers let an AI agent gather evidence from official SAP sources — the Business Accelerator
Hub, Road Map Explorer, and SAP Notes — from behind SAP login. They power the
[SAP API Policy evidence skill](https://github.com/marianfoo/sap-api-policy-skill), but are usable
standalone with any MCP client (Claude Code, Cursor, Codex, …).

## Packages

| Package (npm) | Dir | Role |
| --- | --- | --- |
| [`@marianfoo/sap-mcp-auth`](packages/auth) | `packages/auth` | Shared SAP IAS/SSO browser-login + session module (Playwright). Used by the three servers below. |
| [`sap-api-hub-mcp`](packages/api-hub) | `packages/api-hub` | MCP server for the SAP Business Accelerator Hub — Published-API status, specs, docs. |
| [`sap-roadmap-mcp`](packages/roadmap) | `packages/roadmap` | MCP server for SAP Road Map Explorer — future/planned features (planning only). |
| [`sap-note-search-mcp`](packages/notes) | `packages/notes` | MCP server for searching SAP Notes / KBAs. |

Each package is **published to npm independently under its own name** — the monorepo is for
development. Consumers still install a single server (`npx -y sap-api-hub-mcp`, etc.).

## Quick start

```bash
git clone https://github.com/marianfoo/sap-mcp-servers.git
cd sap-mcp-servers
npm install                # installs all workspaces + links @marianfoo/sap-mcp-auth locally
npm run build              # builds auth first, then the three servers
npm run install:browsers   # one-time: Chromium for Playwright login (also auto-runs on install)
```

`npm install` creates a single root lockfile, hoists shared dependencies, and symlinks
`@marianfoo/sap-mcp-auth` into each server from `packages/auth` — so you can change the auth module
and rebuild without publishing it.

## Running a server

Each server is a stdio/HTTP MCP server. See each package's README for its tools and environment:

- [`packages/api-hub/README.md`](packages/api-hub/README.md)
- [`packages/roadmap/README.md`](packages/roadmap/README.md)
- [`packages/notes/README.md`](packages/notes/README.md)

For wiring them into an MCP client (Claude Code / Cursor / Codex) with auth and MFA, see the skill's
**[MCP_SETUP.md](https://github.com/marianfoo/sap-api-policy-skill/blob/main/MCP_SETUP.md)**.

## Shared SAP authentication

All three servers authenticate to SAP the same way, via `@marianfoo/sap-mcp-auth`:

- `SAP_USERNAME` / `SAP_PASSWORD` (interactive IAS login on first run), **or** a SAP Passport client
  certificate (`.pfx`), selected via `AUTH_METHOD`.
- For browser sign-in, use `HEADFUL=true`. Notes and Roadmap can share `SAP_SSO_STORAGE_STATE`. Roadmap must visit its own app to obtain service cookies. API Hub signs in directly in a fresh browser context and reuses its own validated token cache.

Never commit credentials, `.env`, `*.pfx`, or `*-token-cache.json` — they are gitignored.

## Development

- **Build order matters:** `packages/auth` must build before the servers (they import its types).
  `npm run build` handles this; `npm run build:auth` builds just the auth module.
- Build one package: `npm run build -w sap-roadmap-mcp`.
- Watch/dev a server: `npm run dev -w sap-api-hub-mcp`.
- Typecheck / test everything: `npm run typecheck` / `npm test`.

## Contributing & commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): subject`,
e.g. `fix(auth): refresh expired SSO cookie`. A husky `commit-msg` hook + a CI job lint this. Allowed
scopes: `auth`, `api-hub`, `roadmap`, `notes`, `deps`, `release`, `ci`, `repo`. See
**[AGENTS.md](AGENTS.md)** for the full contributor/dev guide.

## Releases

Releasing is automated with **[release-please](https://github.com/googleapis/release-please)** —
landing conventional commits on `main` opens a per-package "release PR"; merging it bumps that
package's version + `CHANGELOG`, tags it (e.g. `sap-api-hub-mcp-v0.1.2`), and the
[`release.yml`](.github/workflows/release.yml) workflow publishes it to npm with provenance (OIDC).
No manual `npm version` / `npm publish`. Setup details and the npm trusted-publisher one-time config
are in **[AGENTS.md → Commits, CI & releasing](AGENTS.md)**.

## Licensing

All packages are licensed **Apache-2.0** — see each package's `LICENSE` file.
