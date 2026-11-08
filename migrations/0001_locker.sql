-- phase: expand
CREATE TABLE locker_accounts (
    subject text PRIMARY KEY,
    restricted boolean NOT NULL DEFAULT false,
    deleted boolean NOT NULL DEFAULT false,
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);
CREATE TABLE locker_items (
    id uuid PRIMARY KEY,
    owner text NOT NULL REFERENCES locker_accounts(subject),
    kind text NOT NULL CHECK (kind IN ('file', 'folder', 'send')),
    parent uuid REFERENCES locker_items(id),
    media_id text,
    envelope_bytes bigint NOT NULL CHECK (envelope_bytes > 0),
    lock text NOT NULL CHECK (lock IN ('people', 'password', 'link')),
    header jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz,
    download_limit integer CHECK (download_limit > 0),
    downloads integer NOT NULL DEFAULT 0,
    disabled boolean NOT NULL DEFAULT false,
    deleted_at timestamptz,
    revision integer NOT NULL DEFAULT 1,
    CHECK ((kind = 'send') = (expires_at IS NOT NULL))
);
CREATE INDEX locker_items_owner ON locker_items(owner, created_at DESC);
CREATE INDEX locker_items_due ON locker_items(expires_at) WHERE deleted_at IS NULL;
CREATE TABLE locker_uploads (
    id uuid PRIMARY KEY,
    owner text NOT NULL REFERENCES locker_accounts(subject),
    bytes bigint NOT NULL,
    media_id text,
    total_bytes bigint,
    target uuid,
    revision integer,
    prefix bytea,
    due_at timestamptz NOT NULL
);
CREATE TABLE locker_gc (
    media_id text PRIMARY KEY,
    due_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX locker_gc_due ON locker_gc(due_at);
CREATE TABLE locker_rates (
    bucket text PRIMARY KEY,
    window_start bigint NOT NULL,
    attempts integer NOT NULL
);
CREATE TABLE locker_reports (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES locker_items(id),
    reporter text,
    reason text NOT NULL CHECK (reason IN ('abuse', 'illegal', 'malware', 'other')),
    created_at timestamptz NOT NULL,
    resolved_at timestamptz
);
CREATE TABLE locker_moderation (
    id uuid PRIMARY KEY,
    actor text NOT NULL,
    target text NOT NULL,
    action text NOT NULL,
    created_at timestamptz NOT NULL
);
