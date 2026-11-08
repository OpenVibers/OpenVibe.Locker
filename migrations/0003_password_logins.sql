-- phase: expand
ALTER TABLE locker_items DROP CONSTRAINT locker_items_kind_check;
ALTER TABLE locker_items ADD CONSTRAINT locker_items_kind_check CHECK (kind IN ('file', 'folder', 'send', 'login'));
