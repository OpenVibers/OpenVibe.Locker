# Blind fill (phase 2 design only)

Blind fill lets a person approve a sign-in in a trusted Locker UI while a Computer session operates a browser. It waits
for Run's control lease and is not implemented by Locker's password manager.

## Flow

1. A Computer asks for a saved login by exact origin. It receives only a request id, origin, and the site title; it
   never receives a login, password, TOTP seed, or decrypted Locker item.
2. Run pauses the Computer browser under its control lease and sends a B2 approval request to the person's trusted
   device. The trusted device displays the Computer, exact origin, requested account label, and the requested fields.
3. The person approves or denies. Approval unlocks the selected login in the trusted device's extension and creates a
   short-lived, single-use fill grant scoped to that exact origin and those fields.
4. Link/Run delivers the grant to the Companion extension through its authenticated channel. The extension checks the
   active tab origin and frame origin again, fills only the approved fields in the top-level page, and submits only if
   the person approved submission. It never fills a cross-origin iframe.
5. The extension discards plaintext and grant state after use or timeout, and locks after 15 minutes idle. The agent
   tool `locker_fill_login` returns only a success/failure result; it never returns field values or secrets.

## Required controls

- The password manager extension unlocks Locker locally with the same passphrase, passkey, or recovery-kit flow.
- A saved login is eligible only when its stored origin exactly matches the requested origin or the person explicitly
  added that second origin. No wildcard domains, redirects, subdomains, or cross-origin frames inherit access.
- Approval names the target Computer, origin, account label, and fields. Each fill needs a fresh approval; approval
  cannot be replayed, transferred to another tab, or used after its short expiry.
- The browser integration must bind its grant to the active tab and top-level frame, verify the origin immediately
  before input, and abort if navigation or focus changes.
- The Locker server, Run, Link, MCP response, and agent context receive no plaintext. The extension is the only
  component that decrypts and types the selected fields.
- Audit records contain request id, origin, decision, and time only. Do not record field contents, credential ids,
  TOTP codes, page HTML, or screenshots containing secrets.
- TOTP remains locally computed. If a site needs an OTP, show that as a separately approved field in the trusted
  prompt; never expose it to the agent.

## Open decisions before implementation

- Run's control lease must provide a race-free pause/resume and identify the exact browser tab and navigation epoch.
- Link needs an authenticated, single-use channel between the trusted extension and the Companion running in the
  Computer browser.
- The B2 request contract must support origin and field scopes without allowing an agent to impersonate the trusted
  prompt.
- Product review must confirm the approval copy, timeout, recovery behavior, and extension permission model.
