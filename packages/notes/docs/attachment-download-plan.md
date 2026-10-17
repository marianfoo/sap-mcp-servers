# SAP Note attachments (#48)

## Worth implementing?

Yes. Notes already return attachment URLs, but users need the referenced PDFs, images and archives
to follow the instructions. Keep this as one local stdio tool; a local path is not a useful file
delivery mechanism for a remote HTTP client.

## Findings in the submitted PR

- Five new tests through the actual MCP tool failed: old schema dialect, overwrite of an existing
  file, write through a symlink, concurrent overwrites, and a shared default temporary directory.
- Only the initial URL was allowlisted; Playwright follows redirects automatically by default.
- The size check ran after Playwright had buffered the entire response.
- A persistent attachment request context was not closed by client cleanup.
- The manual check could pass without downloading any attachment.

## Small implementation

1. Retain the contributor's tool, result fields and Content-Disposition filename support.
2. Stream one HTTPS download per call. Check every redirect before sending cookies or the SAP
   Passport, keep TLS verification, and bound duration, redirects and received bytes. Request
   identity HTTP encoding; reject unexpected compression rather than adding a decoding pipeline.
3. Use the standard `tough-cookie` jar for domain, path and expiry rules instead of implementing
   cookie parsing. Restore browser cookies and process Set-Cookie headers along the redirect chain.
4. Validate URL and output directory before authentication/download. Confine filenames to the output
   directory; tolerate literal percent signs. Create files exclusively and remove only this call's
   partial file on failure. Use a private temporary directory by default and JSON Schema 2020-12.
5. Make the live check use the actual MCP tools and require a real successful download.

The per-call stream removes the retained-request-context lifecycle problem. No persistent browser,
background job, queue, download manager or HTTP file-serving API is added.

## Verification

Offline tests use real local sockets for streaming, aborts and redirects, with synthetic cookies and
certificate options. Cover safe/unsafe origins, host/path/expiry cookie scope, redirected cookies,
login HTML, 401/403, empty/truncated bodies, Content-Length and chunked limits, unexpected encoding,
timeouts, filenames, exclusive writes, symlinks and concurrent calls. Test the real MCP tool,
reported hash and its absence from HTTP tools/list. Run the existing Notes suite and all three
executable-bin smoke tests.

Live SAP verification remains separate: validate both document hosts with an entitled account and
its current SAP Passport/cookies. Passing a local transport fixture does not prove SAP TLS or
account entitlement. Do not claim the contributor's earlier live run validates this revised transport.

References: [Playwright request behavior](https://playwright.dev/docs/api/class-apirequestcontext),
[Node HTTPS](https://nodejs.org/api/https.html#httpsrequesturl-options-callback),
[tough-cookie](https://github.com/salesforce/tough-cookie).
