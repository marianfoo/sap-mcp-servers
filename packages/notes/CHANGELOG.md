# Changelog

## [0.3.10](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.9...sap-note-search-mcp-v0.3.10) (2026-10-17)


### Features

* **notes:** add fetch_attachment tool to download SAP Note attachments ([#48](https://github.com/marianfoo/sap-mcp-servers/issues/48)) ([b7f5655](https://github.com/marianfoo/sap-mcp-servers/commit/b7f5655fe60b99ae0003a0d5fd14a37c94a65d29))


### Bug Fixes

* **auth:** recover malformed SSO state and validate Notes sessions ([#87](https://github.com/marianfoo/sap-mcp-servers/issues/87)) ([565145c](https://github.com/marianfoo/sap-mcp-servers/commit/565145c5c980c14d10e5b27efa328b433cfe5607))
* **deps:** refresh SDK and vulnerable dependency resolutions ([#83](https://github.com/marianfoo/sap-mcp-servers/issues/83)) ([e20284b](https://github.com/marianfoo/sap-mcp-servers/commit/e20284b923c92c3896f9d38eb79e6a438cc5c6e6))
* **notes:** escape Unicode line breaks in SSE responses ([#86](https://github.com/marianfoo/sap-mcp-servers/issues/86)) ([6ca692a](https://github.com/marianfoo/sap-mcp-servers/commit/6ca692ad2ee3992d1cf3358dbbd0e3d74a795eb3))
* **notes:** honour HEADFUL=true over stdio and on Windows ([#82](https://github.com/marianfoo/sap-mcp-servers/issues/82)) ([267b0f4](https://github.com/marianfoo/sap-mcp-servers/commit/267b0f4ab265619b07fcd771dacc5e26f9d35598))
* shared SSO state path on Windows, real notes version, keep SSO state on session expiry ([#81](https://github.com/marianfoo/sap-mcp-servers/issues/81)) ([b9ffee1](https://github.com/marianfoo/sap-mcp-servers/commit/b9ffee17604348df056eab591c8eaed1a806604b))

## [0.3.9](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.8...sap-note-search-mcp-v0.3.9) (2026-09-23)


### Bug Fixes

* **notes:** reject rate limits and content-free fallbacks ([#67](https://github.com/marianfoo/sap-mcp-servers/issues/67)) ([407ef6c](https://github.com/marianfoo/sap-mcp-servers/commit/407ef6cf686c205cb54dc9da275e6b7afbd61a9a))

## [0.3.8](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.7...sap-note-search-mcp-v0.3.8) (2026-09-08)


### Bug Fixes

* **notes:** advertise JSON Schema 2020-12 ([#56](https://github.com/marianfoo/sap-mcp-servers/issues/56)) ([4ccdab8](https://github.com/marianfoo/sap-mcp-servers/commit/4ccdab86c807f7314b097b0ba566ebb9b13cbb17))

## [0.3.7](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.6...sap-note-search-mcp-v0.3.7) (2026-08-10)


### Bug Fixes

* **notes:** add required CorrIns paging and TCI package URL ([#45](https://github.com/marianfoo/sap-mcp-servers/issues/45)) ([1a840e7](https://github.com/marianfoo/sap-mcp-servers/commit/1a840e7b37e7dbc2431d43ce0a728d3aec039dbd))

## [0.3.6](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.5...sap-note-search-mcp-v0.3.6) (2026-08-08)


### Bug Fixes

* **notes:** extract and harden Detail enriched metadata ([#43](https://github.com/marianfoo/sap-mcp-servers/issues/43)) ([a97b25c](https://github.com/marianfoo/sap-mcp-servers/commit/a97b25c9eca0903fda5cd8d79c240a1ff1601dcb))

## [0.3.5](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.4...sap-note-search-mcp-v0.3.5) (2026-08-05)


### Bug Fixes

* **notes:** add installable MCPB distribution ([#40](https://github.com/marianfoo/sap-mcp-servers/issues/40)) ([2368546](https://github.com/marianfoo/sap-mcp-servers/commit/23685469887c83d27ce9e958e3f5b46219072237))

## [0.3.4](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.3...sap-note-search-mcp-v0.3.4) (2026-08-01)


### Bug Fixes

* **notes:** restore authenticated backend access ([#32](https://github.com/marianfoo/sap-mcp-servers/issues/32)) ([ff8e497](https://github.com/marianfoo/sap-mcp-servers/commit/ff8e497c643ef268161e480de4d73a9a4ff9e3a9))

## [0.3.3](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.2...sap-note-search-mcp-v0.3.3) (2026-06-02)


### Bug Fixes

* **auth:** update authentication flow to use session management and improve cookie handling ([8fcbdb6](https://github.com/marianfoo/sap-mcp-servers/commit/8fcbdb697cc957f2160467f214f35b1779f59ff6))

## [0.3.2](https://github.com/marianfoo/sap-mcp-servers/compare/sap-note-search-mcp-v0.3.1...sap-note-search-mcp-v0.3.2) (2026-05-29)


### Documentation

* **notes:** note npm build provenance ([603dc5f](https://github.com/marianfoo/sap-mcp-servers/commit/603dc5fb991f576f0699e6eba06e7e2e4775e95d))
