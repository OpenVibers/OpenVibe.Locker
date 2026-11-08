-- phase: expand
ALTER TABLE locker_uploads ADD COLUMN options jsonb;
ALTER TABLE locker_uploads ADD COLUMN completing boolean NOT NULL DEFAULT false;
CREATE TABLE locker_upload_parts (
    upload_id uuid NOT NULL REFERENCES locker_uploads(id) ON DELETE CASCADE,
    part integer NOT NULL CHECK (part >= 0),
    bytes bigint NOT NULL CHECK (bytes > 0),
    PRIMARY KEY(upload_id, part)
);
-- Completion retries after a lost HTTP response return the original item/receipt.
CREATE TABLE locker_upload_results (
    id uuid PRIMARY KEY,
    owner text NOT NULL REFERENCES locker_accounts(subject),
    result jsonb NOT NULL,
    due_at timestamptz NOT NULL
);
CREATE INDEX locker_upload_results_due ON locker_upload_results(due_at);
CREATE INDEX locker_uploads_due ON locker_uploads(due_at);
