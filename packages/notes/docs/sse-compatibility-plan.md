# Unicode in SSE responses (#85 / #86)

## Is it worth fixing?

Yes. SAP Note text can contain Unicode line separators. The server emits valid SSE, but an affected
client truncates the JSON at those characters. The reporter cannot change that client. Escaping at
the transport boundary preserves the original text and lets those clients read the whole result.

## Root cause and research

- SSE recognizes CR, LF and CRLF as line endings. Python `str.splitlines()` also recognizes U+2028,
  U+2029 and U+0085. These three can appear literally in a JSON string; JSON already escapes the
  other ASCII control characters recognized by `splitlines()`.
- Offline reproduction with real Python/httpx-sse 0.4.1: raw separators truncate JSON; escaped
  separators round-trip exactly. Version 0.4.3 handles both forms correctly.
- httpx-sse fixed the parser in 0.4.2 and its performance in 0.4.3. Operators who control their
  Python client should upgrade. This is not available to every hosted-client user.
- Equivalent TypeScript SDK fixes #1925 (v2) and #1926 (v1) were still open on 2026-10-17.

Sources: [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream),
[Python line splitting](https://docs.python.org/3/library/stdtypes.html#str.splitlines),
[httpx-sse changelog](https://github.com/florimondmanca/httpx-sse/blob/master/CHANGELOG.md),
[SDK v1 fix](https://github.com/modelcontextprotocol/typescript-sdk/pull/1926).

## Small fix

Keep the contributor's middleware on `/mcp`. It escapes the wire bytes, carries incomplete UTF-8
sequences between chunks, and leaves ordinary JSON responses alone. Add U+0085 to cover the same
parser failure. No content normalization, SDK fork, extra dependency or client-specific setting.

Remove the middleware when the minimum supported SDK escapes all three characters, retaining the
HTTP endpoint regression and making sure it passes without the middleware. A released fix for only two characters is not
enough to remove the U+0085 coverage.

## Verification

Test every chunk boundary, non-ASCII text, partial sequences, both ways of setting SSE headers,
ordinary JSON content length, and a real HTTP MCP tool response. Parse the result with the faulty
line-splitting behavior and compare the full decoded content. Before the U+0085 addition, the
expanded chunk-boundary and HTTP tests fail; after it, both pass.
