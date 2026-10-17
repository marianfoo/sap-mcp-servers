# Password login for document attachments (#48)

## Problem confirmed live

The same S-user can read Notes and download attachments. `userapps.support.sap.com` works with
Notes cookies. `documents.support.sap.com/customerkba/` needs its own SAML session. Retrying a
Notes login does not create it. SAP returns HTTP 200 login HTML with the
`com.sap.cloud.security.login: login-request` header, then posts through
`authn.hana.ondemand.com` to `accounts.sap.com`.

## Options

| Option | User experience | Cost / impact | Decision |
| --- | --- | --- | --- |
| Ask users to prepare cookies or a Passport | Extra setup and expiry handling | Small code change | Keep existing support, but not the default password experience. |
| Log into Documents during every Notes login | Extra browser work even without attachments | Changes ordinary Notes login and adds another failure dependency | Reject. |
| Log into Documents only when its download asks for sign-in | Existing S-user/password; later downloads reuse cookies | One bounded login and retry on the affected path | Choose. |

The unmodified shared authenticator failed both the public Documents root and the attachment URL:
it returned before the SAML bootstrap completed. The public root is not protected. Use the stable
protected `/customerkba/` directory to establish the session without transferring the attachment
through a browser. Wait through the known Neo bootstrap before running existing guarded login. Use one timeout for
all supported password selectors; the previous sequential waits multiplied a missing field's
15-second deadline into several minutes.

## Small implementation

1. Distinguish an attachment login challenge from an access denial or transport failure.
2. Keep the direct downloader first. Only a Documents login challenge starts the existing shared
   authenticator, with clean private temporary state. Reusing the Notes identity state stalled in two live trials;
   isolate the legacy Documents login rather than making either service depend on the other's IdP state.
3. Reuse its password/certificate/MFA handling and credential-origin checks. Close the browser and
   remove temporary state after the attempt. Concurrent attachment calls share one login attempt.
4. Retry the bounded Node HTTPS download once. A denial, timeout or failed login ends the call.
   If SAP rejects the completed document login, stop automatic password attempts until the server is restarted.
   Explain how to check credentials or complete interactive sign-in. Preserve the working Notes session.
5. Keep only Documents cookies from this login. On a successful download, merge those cookies into
   the existing shared SSO file while preserving Notes cookies and origin storage. Keep an in-memory
   copy if persistence fails. No new user settings or permanent browser are needed.

## Verification

Reproduce the missing-bootstrap failure before the change. Test synthetic browser redirects,
credential delegation, fresh login, concurrent calls, reuse, expired Documents cookies, denied
access, login cancellation/timeouts, and preservation of Notes state. Repeat actual MCP downloads
with a fresh S-user/password session on both hosts; verify PDF/PNG/Excel/ZIP bytes and hashes.
Review the resulting code with Claude Opus 5.5 Max and fix concrete findings before publishing the PR
update. This task does not merge or release.

References: [SAP Neo authentication and login-response header](https://help.sap.com/docs/btp/sap-btp-neo-environment/html5-apps-descriptor-file-authentication),
[SAP Passport setup](https://support.sap.com/en/my-support/single-sign-on-passports.html).
