# Operator launch handoff

Nothing in this change deploys, changes DNS or accesses the host. Opus reviews the key-related changes before merging.

1. Review and merge [SDK #141](https://github.com/OpenVibers/OpenVibe.SDK/pull/141), [Shared #347](https://github.com/OpenVibers/OpenVibe.Shared/pull/347), [Network #677](https://github.com/OpenVibers/OpenVibe.Network/pull/677) and [Media #357](https://github.com/OpenVibers/OpenVibe.Media/pull/357).
   Release/pin the SDK and Shared changes; Locker initially pins the reviewed commits so CI can verify the whole change.
2. Provision PostgreSQL database `ov_locker` through the Host service-role workflow. Give the migration owner a direct
   `DATABASE_DIRECT_URL` and runtime role a PgBouncer `DATABASE_URL`; only the migration role creates tables.
3. Register the `locker` OAuth client with callback `https://openvibe.locker/auth/callback`. The Network PR seeds its
   metadata and least-privilege grants. Use Network's normal credential setup; no credentials belong in this repository.
4. Supply `/etc/openvibe/locker.env`: `BASE_URL=https://openvibe.locker`, the two database URLs,
   `OV_OAUTH_CLIENT_SECRET`, `LOCKER_EVENTS_SECRET`, `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`,
   `OV_MEDIA_URL`, and `OV_EVENTS_URL`. `LOCKER_DATA_DIR` must have room for concurrent encrypted upload staging.
   Restrict write access to the service. Media's multipart limit must accommodate at least 2304 MiB of padded ciphertext.
5. Run the drill on `PORT=15145`, its own writable directory and drill database, then check `/api/health`, Network SSO,
   key setup/unlock, a full browser upload/open, sharing and expiry erasure. Never point a drill at the live database.
6. Install the reviewed unit as `openvibe-locker.service`. Configure the vhost to proxy to `127.0.0.1:5145`, allow
   a 2304 MiB request body, stream requests (`proxy_request_buffering off`), and allow uploads up to 30 minutes.
   Do not log query strings, cookies, bearer tokens or request bodies. Never rewrite a Send fragment into a query.
7. Verify both ADR-033 Events subscriptions at boot and the export/deletion grants together. Stop launch if the
   delivery subscriptions, Media tenant, service grants or migrations are missing. No contents are indexed or sent to AI.

Storage settings: `LOCKER_QUOTA_BYTES` defaults to 5 GiB and includes reserved ciphertext; `LOCKER_MAX_FILE_BYTES`
defaults to 2 GiB of plaintext in the browser. Replacements reserve their full incoming size, so renaming/sharing requires temporary free quota. The server cannot see true sizes, so it enforces the corresponding
maximum padded envelope size. `LOCKER_MIN_ACCOUNT_DAYS=7`, `LOCKER_UPLOADS_PER_HOUR=60`, `LOCKER_SENDS_PER_HOUR=20`.
`LOCKER_ALLOWLIST_ONLY=true` additionally requires the subject in `LOCKER_UPLOAD_ALLOWLIST` (comma-separated).
Network ban/deletion and age checks still apply. Local staff restrictions always apply.

Cleanup selects due rows, runs bounded batches and schedules one timer for the next due time, capped at one minute.
Media erasure failures remain in the outbox with backoff. Access ends immediately on expiry/disable/deletion even if
Media is unavailable; bytes are erased when it recovers. Retention holds remain visible failures and never count as erased.
One-hour abandoned uploads release their reservations and queue any remote object for deletion.

Browser capabilities: OPFS keeps large encrypted upload staging out of heap. Without OPFS the UI limits uploads to
32 MiB. Downloads over 32 MiB require File System Access for a writable destination and commit only after the final
chunk verifies; smaller files work through a Blob download. Passkey setup requires WebAuthn PRF and recovery is always
available through the saved kit. Only a credential id and PRF input are kept locally, bound to the account and origin.

Known product boundary: folder sharing does not recursively grant access to children; share each file. Ownership
transfer, password manager, blind fill, Photos and Scanner are later phases. A shared item is a viewer-only file.
