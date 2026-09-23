# Stop false SAP Note results after rate limits

## Problem

`getNote` catches backend and fallback HTTP errors, then tries another source.
The final HTML fallback turns any response body into a plausible SAP Note with
placeholder content. Generic JSON and browser fallback branches also have
placeholder content paths. A rate-limited request can therefore look successful.
Callers may treat missing support-package data as a real result.

## Fix

1. Reproduce the failure with a deterministic test: backend HTTP 429 followed
   by an HTML fallback must never produce a note.
2. Stop on HTTP 429 and report a retryable error. More immediate requests to
   the same service would extend the rate limit.
3. Do not turn generic HTML or content-free JSON into a note. Keep the existing
   authenticated Detail path and fallbacks that contain actual note text.

## Verification

- First run the regression test against the old behavior to confirm it fails.
- Test HTTP 429, unrelated HTML, content-free JSON, and a valid Detail response.
- Build and run the Notes unit suite. Check that the MCP `fetch` handler returns
  an error when `getNote` throws.

No live SAP rate-limit burst is needed for this regression: the test controls
the exact HTTP responses without stressing a production endpoint.
