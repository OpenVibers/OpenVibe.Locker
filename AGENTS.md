# AGENTS.md — OpenVibe.Locker

## Project Overview

OpenVibe.Locker is the front door for private files, passwords and expiring Sends. It stores **ciphertext and opaque
access metadata only**: the server never seals, opens, indexes, previews, transcodes or runs AI on content. Names,
MIME types and bytes are inside the envelope, sealed and opened in the browser by the device UI and
`openvibe-sdk/locker`; the browser worker writes to OPFS in 1 MiB chunks.

- **Domain:** `openvibe.locker` · **Port:** 5145 (drill 15145) · **Service id:** `locker` · **Env prefix:** `LOCKER`/`OV_`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Playwright
  for browser tests.
- **Read first:** [README.md](README.md), [docs/BLIND-FILL.md](docs/BLIND-FILL.md),
  [deploy/LAUNCH.md](deploy/LAUNCH.md), [SECURITY.md](SECURITY.md), [public/openapi.json](public/openapi.json).

**Network context:** identity, sign-in, staff roles, account export/deletion and the Companion token validation are
OpenVibe.Network (`locker` OAuth client; the Companion token needs `locker.login.manage`; `/internal/identity/resolve`
with `trust=1` decides standing). Ciphertext lives in a private OpenVibe.Media tenant (`locked.ovlk`,
`application/octet-stream`); Locker queues durable erasure there. Events are OpenVibe.Events. Share UI and the SDK
envelope are OpenVibe.Shared/SDK, not reimplemented here.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm start                      # http://localhost:5145, PGlite under data/pglite
npm test                       # node --test --test-concurrency=1 test/*.test.js (real WebCrypto, local adapters)
npm run check                  # syntax check (scripts/check.js)
npm run test:browser           # starts a local instance, real browser worker, 390/1280 screenshots in artifacts/
node --test test/companion.test.js   # one file (companion isolation and ciphertext-only checks)
```

There is **no `test:pg` script**: the suite uses isolated PGlite databases. Browser checks use Playwright's Chromium
or local Chrome. There is no build step; the page JS in [public/js/](public/js/) (`app.js`, `passwords.js`,
`payload.js`, `seal-worker.js`) is served as-is.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — creates the app, starts the due jobs
  ([server/jobs.js](server/jobs.js)) and the two ADR-033 subscriptions, listens, and on SIGTERM stops jobs/subscriptions
  and closes the database. Production refuses to start without the service credentials and event secret.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP (no-referrer, worker-src self), `/internal/events`,
  `/api/v1/companion`, `/auth`, optional auth, the same-origin + `X-Requested-With` CSRF gate on writes, `/api/v1`,
  `/shared` + static, pages, error handler. `createApp({ db, network, media, sso, now })` is injectable for tests.
- **Config/db:** [server/config.js](server/config.js) (pure load), [server/db.js](server/db.js) — migrations
  [migrations/](migrations/) at boot; no table is created at runtime.
- **Core:** [server/service.js](server/service.js) (accounts, quota, items, viewing rules, rates, removal),
  [server/envelope.js](server/envelope.js) (shape, prefix, exact length), [server/media.js](server/media.js) (private
  Media objects and multipart), [server/network.js](server/network.js) (identity/standing),
  [server/account-data.js](server/account-data.js), [server/sharing.js](server/sharing.js) (the Share sheet),
  [server/uploads.js](server/uploads.js) (resumable sessions), [server/companion.js](server/companion.js).
- **Pages:** [server/pages.js](server/pages.js) — `/`, `/drive`, `/passwords`, `/files/:id`, `/sends`,
  `/s/:id#k=…`, `/recovery`, `/staff`, `/docs`; [public/llms.txt](public/llms.txt),
  [public/llms-full.txt](public/llms-full.txt), [public/robots.txt](public/robots.txt),
  [public/.well-known/agent.json](public/.well-known/agent.json).
- **Database:** [migrations/](migrations/): `locker_accounts`, `locker_items`, `locker_uploads`,
  `locker_upload_parts`, `locker_upload_results`, `locker_reports`, `locker_moderation`, `locker_rates`, `locker_gc`.
- **Deploy:** [deploy/systemd/openvibe-locker.service](deploy/systemd/openvibe-locker.service) (PORT 5145,
  `/etc/openvibe/locker.env`, `/opt/openvibe.locker`) and [deploy/nginx/openvibe.locker.conf](deploy/nginx/openvibe.locker.conf)
  (33 MiB parts, 91 MiB legacy single envelopes, 64 KiB for everything else, buffering off, long read timeouts, no
  query strings/cookies/bodies in logs). Install through `ov-vhost-install`; database `ov_locker`; Media multipart
  must allow at least 2304 MiB of padded ciphertext.

## Ownership and Boundaries

Locker owns its accounts/quota, items and access rules, upload sessions/results, reports, moderation and rate rows, and
the access/moderation history it retains as security evidence. It does **not** own identity, sign-in, Wrapped keys
(Network), the ciphertext bytes (Media), event delivery (Events), or the envelope/crypto format (`openvibe-sdk/locker`;
payload framing in [public/js/payload.js](public/js/payload.js) is an application payload inside that envelope). It
never sees a filename, MIME type or plaintext byte. A folder is organisational: sharing a folder does not grant its
children.

## Access, Crypto and Moderation

- **Payload:** 4-byte big-endian metadata length (≤65536) + UTF-8 JSON `{ version:1, name, type, size, folder? }` +
  exactly `size` content bytes. `prefix`/`pack`/`unpack` are in [public/js/payload.js](public/js/payload.js); the worker
  feeds chunks to `locker.sealStream` and verifies before commit.
- **Access:** a Send is a link lock (`/s/:id#k=…`, the key never leaves the fragment; 1 hour–30 days and an optional
  attempt limit); a drive item is a people lock with the owner's slot and the current sharing list. Each content
  request consumes one claim, including disconnected downloads; GET metadata and HEAD do not.
- **Sharing:** seal a new envelope for the owner and all remaining recipients, complete a resumable `reseal` (or an
  inline `POST /files/:id/reseals` for ≤90 MiB), then `PUT /files/:id/share` with `{ members, envelope_ref }` (and the
  Share GET's ETag in `If-Match` where possible). The Media reference, quota and ACL commit together; an unconsumed
  receipt expires after an hour and old objects are queued for erasure. A departing member's old key cannot open the
  new envelope (they may still keep a prior copy).
- **Limits:** `LOCKER_QUOTA_BYTES` 5 GiB, `LOCKER_MAX_FILE_BYTES` 2 GiB plaintext (browser-enforced; the server can
  only enforce the padded size), 60 uploads/hour, 20 Sends/hour, 32 MiB parts, `LOCKER_MIN_ACCOUNT_DAYS=7`; sign-in,
  age and Network ban/deletion, local restrictions and optional `LOCKER_ALLOWLIST_ONLY` all apply.
- **Companion:** only a Bearer token Network validates live per request; `GET /keys`, `GET /logins`,
  `GET /logins/:id/content`, `POST /logins` (≤2 MiB, kind fixed `login`). The scoped token cannot reach the general
  file API, key updates or blind fill. Any change to this surface must be reviewed as security-sensitive.
- **Reports** carry a reason code only (`abuse`, `illegal`, `malware`, `other`) — never a key or plaintext. Staff
  (Network `global_mod`+) disable items and restrict uploads; every change is recorded locally.
- **Account export/deletion** (ADR-033) provides an opaque manifest with separately downloadable envelopes while the
  account exists; deletion denies access immediately, queues ciphertext erasure, cancels deliveries and removes
  memberships. Access/moderation history and the deletion marker remain as evidence, with no plaintext or keys.
- Errors use stable `locker.*` codes and never echo an envelope's contents. Hostile input stays text.

## Key Pitfalls

- **The server must never decrypt, sniff, index or log content.** Do not add an MIME check by content, a preview, an
  AI call, a search index or a filename column; "unknown plaintext metadata is rejected" is enforced on the envelope
  header, not by opening it.
- **Exact length:** the server checks the envelope shape and the exact expected ciphertext length while counting actual
  received bytes; a mismatch is a 400 `locker.length`. The 64 KiB header bound is part of the protocol.
- **CSRF:** writes require the same origin **and** `X-Requested-With`; a bearer-only or cross-site form post must not
  pass. Do not relax it for the "convenience" of a client.
- **Sends:** never rewrite the fragment into a query or a server log; `#k=` stays client-side. HEAD/GET metadata must
  not consume a download claim; content requests must.
- **Resumable uploads:** parts are immutable and retryable, numbered from zero, each exactly 32 MiB except the last;
  completion is idempotent for 24 h and rechecks standing/revision/recipients. A lost completion response is retried
  by querying, not by re-uploading blindly.
- **Expiry/erasure is due-based and bounded:** access ends at `due_at` even during a Media outage; cleanup retries
  failures. Never restore or reuse a deleted envelope.
- **CSP/`Referrer-Policy: no-referrer`** is security-relevant: no third-party script, no referrer carrying a fragment,
  no `frameAncestors` widening. The only named external origins are Network, Media, Chat, Billing, Events, Cloudflare
  insights and HIBP (for the first five SHA-1 hex chars, after asking).
- **No fake backend or sample content** in production; development uses PGlite and real WebCrypto.
- **Drill:** port 15145, its own writable directory and drill database — never point a drill at the live database.

## Testing

`npm test` runs `node --test` over [test/](test/): locker access/quota/leniency, resumable uploads, passwords/login
envelopes, sharing, Media adapter, companion isolation/ciphertext-only, public pages and real browser checks.
`npm run test:browser` starts a local instance and exercises the real worker, saving 390/1280 screenshots in both themes
to `artifacts/`. `npm run check` checks syntax. There is no PostgreSQL suite; state that plainly rather than inventing
one.

## Documentation

- [README.md](README.md) — run/verify, pages, private payload, storage/access, companion, versions.
- [deploy/LAUNCH.md](deploy/LAUNCH.md) — the operator handoff: PRs, database, OAuth client, env, drill, units, limits.
- [docs/BLIND-FILL.md](docs/BLIND-FILL.md) — the Run/Companion/Run blind-fill flow and its security requirements.
- [public/openapi.json](public/openapi.json), [public/llms.txt](public/llms.txt), [SECURITY.md](SECURITY.md).
