# Stop false SAP Note results after rate limits

## Problem

`getNote` used to continue after HTTP 429 and could turn an HTML error page into
a note with placeholder content. A legacy launchpad login page could also be
mistaken for an expired SAP for Me session. The auth retry checked for `401`
anywhere in an error, including inside a note number.

## Fix

1. Stop fetch and search fallbacks on HTTP 429 and return the rate-limit error.
2. Accept fallback JSON only when it has note text. Treat generic HTML as no note.
3. Detect session expiry on SAP for Me endpoints, not on the legacy launchpad.
4. Retry authentication for a standalone 401 or session-expired error.

## Verification

- Confirm the SAML, `401`-in-note-ID, and generic HTML tests fail before the fix.
- Build, typecheck, and run the offline Notes tests locally and in PR CI.
- Check that a real Detail response still succeeds and the MCP fetch tool
  returns an error for HTTP 429.

No live SAP rate-limit burst is needed for this regression: the test controls
the exact HTTP responses without stressing a production endpoint.
