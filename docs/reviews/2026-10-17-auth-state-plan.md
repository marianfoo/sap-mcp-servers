# Finish authentication recovery (#28)

## Validity

The HEADFUL and fake-note-success parts are already fixed on main. Two gaps remain: a malformed
shared state file aborts browser creation, and Notes accepts cookies without checking the service.
Reproduced with four invalid state files in real Chromium and three shared-session regression tests.

## Fix

1. Read shared state defensively for both login and reuse. If Playwright rejects its cookie/origin
   fields, create a clean context. Keep the file until a successful, validated login replaces it.
2. Validate Notes cookies against its existing protected search API, requesting one result. Use
   the supplied cookies, never an older file. Treat login HTML, redirects and 401/403 as rejection.
3. Run validation on shared-state reuse as well as cached and fresh login. Propagate outages such
   as 429/503 so they do not delete working credentials or trigger another password attempt.
4. Log resolved cache paths and document how to find them. Keep existing path defaults.

## Tests

- Real Chromium, intercepted network: empty, truncated, wrong-shape and malformed-cookie state.
- Shared-state validation acceptance, rejection and service outage; preserve failed-login state.
- Notes profile: partial-login cookies are rejected from both cache sources.
- Protected API response handling, no redirect following, timeout, cleanup, and cache retention
  during a service outage.
- Existing authentication, Notes and shared-path regression suites.

Live SAP checks require a current authenticated session. The saved state returned login HTML on
2026-10-17; that is not sufficient evidence to mark live qualification complete.
