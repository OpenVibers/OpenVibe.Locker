# OpenVibe.Locker

A front door for private files, passwords and expiring Sends. Node 22, Express/CommonJS and PostgreSQL via `openvibe-sdk/db`.
The server stores ciphertext and opaque access metadata. It never seals, opens, indexes, previews, transcodes or
runs AI on content. The cryptographic format and operations are the existing `locker.envelope.v1` and
`openvibe-sdk/locker`; the device UI and Share sheet are Shared's `ov-locker.js`, `ov-locker-core.js` and `ov-share.js`.

**Live site:** https://openvibe.locker · **API docs:** https://openvibe.services · **For AI:** https://openvibe.locker/llms.txt
**Run it:** `npm ci && npm start` (Node 22 or newer) · **Tests:** `npm test`

## Run and verify

`npm ci`, then `npm start`. Without database settings, development uses PGlite in `data/pglite`.
Network SSO and private Media storage need the service credentials configured by the operator; there is no fake
production backend or sample content. `npm test` uses isolated PGlite databases, real WebCrypto and local adapters.
`npm run test:browser` starts a local test instance, exercises the real browser worker and saves 390/1280 screenshots
in both themes to `artifacts/`. `npm run check` checks syntax. Browser checks use Playwright's Chromium or local Chrome.

Production requires PostgreSQL, a separate migration role, the Locker Network principal and the private Media
Locker tenant. [Launch handoff](deploy/LAUNCH.md) names the exact configuration, port 5145, drill port 15145,
`ov_locker`, `openvibe-locker.service` and `/etc/openvibe/locker.env`. No host or DNS changes are made here.

## Pages

- `/`: device lock status and the front door.
- `/drive`: encrypted files, folders, rename and delete. Names appear only after the browser decrypts them.
- `/passwords`: browser-encrypted logins, password generation, TOTP, local search and CSV import. Each breach check
  asks before sending only the first five SHA-1 hex characters to Have I Been Pwned. Password logins cannot be shared.
- `/files/:id`: open, download, rename, the people Share sheet, and Report.
- `/sends`: create a link-locked file or note, choose 1 hour to 30 days and an optional download-attempt limit.
- `/s/:id#k=<base64url>`: anonymous opening; the key never leaves the fragment. Each content request consumes a claim,
  including disconnected downloads. GET metadata and HEAD do not consume one.
- `/recovery`: Shared setup, passphrase or supported device passkey, and a one-time 24-word kit with print/save.
- `/staff`: Network staff can review reports, disable items and restrict uploads.
- `/docs`: Locked items on OpenVibe, the SDK example and API links. See [OpenAPI](public/openapi.json) and [llms.txt](public/llms.txt).

If you lose the password (or your locker passphrase and recovery kit), nobody can open this, including OpenVibe.

## Private payload

The whole payload below is sealed by the existing SDK. This is an application payload inside the envelope, not a
new cryptographic format. The server never parses it:

1. Four bytes, unsigned big-endian, giving the JSON metadata length (at most 65536).
2. UTF-8 JSON `{ version: 1, name, type, size, folder? }` (original filename, MIME type and true byte count).
3. Exactly `size` content bytes. A folder has zero content bytes. Text Sends use UTF-8 and `text/plain`.

`public/js/payload.js` is usable from Node and a browser. `prefix(meta)` gives the framing bytes; `pack(meta, stream)`
and `unpack(stream)` work with WHATWG streams. Feed the packed stream to `locker.sealStream` with its exact plaintext
size. The worker processes SDK chunks of 1 MiB into OPFS; no whole large file is buffered. Opening streams to an
atomic file writer; final verification must succeed before the writable is committed. The bounded Blob fallback
is 32 MiB. Opening a list label reads only its first authenticated chunk and cancels the remaining content stream.

## Storage and access

Single-request ciphertext routes accept `application/octet-stream` with Content-Length up to **90 MiB**. The server counts
actual received bytes, bounds the header at 64 KiB and uses `openvibe-sdk/locker/server.inspectEnvelopePrefix` to
validate shape and the exact expected ciphertext length. Drive starts with the owner's people slot only. Sends
are link locks. Unknown plaintext metadata is rejected. The browser enforces the true file limit; the server can
only enforce the corresponding padded size, since true sizes are encrypted.

Browser uploads use resumable sessions, so every request fits Cloudflare's 100 MB limit:

1. `POST /api/v1/uploads` with JSON `{ kind: "file" | "folder" | "login" | "send", bytes, parent?, expires_in?, download_limit? }`.
   `bytes` is the entire encrypted envelope size; this reserves quota and returns `{ id, part_size: 33554432 }`.
2. `PUT /api/v1/uploads/:id/parts/:n` with an octet-stream slice, numbered from zero. Each part is exactly
   32 MiB except the last, which is exactly the remaining bytes. Received parts are immutable and retryable.
3. `GET /api/v1/uploads/:id` lists `received_parts`. Resume only the missing parts, including after a server restart.
4. `POST /api/v1/uploads/:id/complete` checks all parts and the envelope, stores it in Media and returns the item.
   Completion retries return the same result for 24 hours; GET also returns that result with `state: "complete"`.
   A session expires after one hour without a new part. Expired staging files and reservations are removed by the due job.

Use `kind: "replace"` or `"reseal"` with `item_id` and the item's `If-Match` revision on initiation **and completion**.
Replace returns the updated item; reseal returns the receipt for the Share API below. Completion rechecks standing,
revision and recipients. The worker retries lost part/completion responses and queries received parts before retrying.
The encrypted OPFS file and Send key remain with that worker; closing the page requires starting a new browser upload.
A server interruption during Media completion leaves the reservation for expiry cleanup; retry a new session after expiry.

Accounts must be signed in, at least seven days old and not banned/deleted in Network's current
`/internal/identity/resolve?subject_id=…&trust=1` response. Local moderation restrictions always apply.
`LOCKER_ALLOWLIST_ONLY` can additionally restrict the launch cohort. PostgreSQL locks the account row to reserve
quota before accepting an upload, including the full size of each staged replacement. Renaming or changing sharing needs enough free quota for the incoming encrypted copy until it commits. Defaults: 5 GiB per account, 2 GiB per file,
60 uploads/hour, 20 Sends/hour. Server metadata contains the owner, IDs, padded/ciphertext sizes, times and access
rules, never names or MIME types. Media sees only a private `file`, `application/octet-stream` and `locked.ovlk`.

For sharing a large file, seal a new envelope in the browser for the owner and all remaining recipients, then:

1. Complete a resumable `reseal` session with `item_id` and `If-Match: "<item revision>"`.
   Envelopes up to 90 MiB can also use `POST /api/v1/files/:id/reseals`.
2. `PUT /api/v1/files/:id/share` with `{ members: [{ subject, role: "viewer", key_slot }], envelope_ref }`, preferably
   with the Share GET's ETag in `If-Match`. The SDK checks recipients and fresh-key removal; Locker checks that the
   staged upload belongs to this owner, file and revision. The Media reference, quota and ACL commit together.
3. An unconsumed receipt expires after one hour. Old objects and abandoned uploads are queued for erasure.

The nginx vhost limits ordinary JSON requests to 64 KiB. Use staged receipts for sharing; only tiny envelopes fit inline. Large reseals carry a
short receipt, never a giant JSON body. Names and every content byte are re-sealed locally; a departing member's
old key cannot open the new envelope. Recipients may still keep a prior copy. Folder membership is organizational;
sharing a folder does not grant its children. Transfer and the password-manager phase are outside v1.

Expiry, user deletion and replacement queue durable Media erasure. A bounded due-based job retries failures; access
ends at the due time even during a Media outage. `DELETE ?purge=1` is reserved to the Locker principal in Media and
has no restore window. Reports carry a reason code, never a content key. Staff changes are recorded locally.

ADR-033 export provides an opaque manifest with IDs and download routes; each envelope is downloadable separately
while the account exists. Network owns the wrapped-key export. Account deletion denies all access immediately,
queues ciphertext erasure, cancels pending deliveries and removes memberships. Append-only access/moderation
history and an account deletion marker are retained as security evidence; they contain no plaintext or keys.

### Companion password access

`/api/v1/companion` accepts only a Bearer token which Network validates live at
`GET /api/v1/me/keys/companion` (the Companion needs `locker.login.manage`). Deploy
that Network scope/endpoint first; existing Companion grants require a new sign-in.
No extension origin CORS wildcard or cookie authentication is added.

- `GET /keys`: the caller's subject and wrapped key backups, never plaintext keys.
- `GET /logins?before=…`: owner-only encrypted login metadata with the normal cursor.
- `GET /logins/:id/content`: only that owner's `kind=login` ciphertext.
- `POST /logins`: an SDK envelope, `application/octet-stream`, at most 2 MiB; the
  item kind is fixed to `login`. Site, username, password, TOTP and notes belong in
  the sealed payload. Normal upload quota, age and envelope validation apply.

The scoped token cannot reach the general file API, key updates or blind fill.
Every request revalidates Network's live token family, including content downloads.
Run `node --test test/companion.test.js` for isolation and ciphertext-only checks.

<!-- versions:start -->
- openvibe-contracts: v0.417.0
- openvibe-sdk: v0.161.0
- openvibe-shared: v4.229.0
<!-- versions:end -->
