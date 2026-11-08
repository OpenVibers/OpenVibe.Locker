'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { fail } = require('./errors');
const { inspectFile, headerInfo } = require('./envelope');
const { padme } = require('openvibe-sdk/locker');
const subjectRef = (id) => ({ type: 'user', id });
const shareRef = (id) => ({ service: 'locker', kind: 'files', id });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userId = (user) => {
    const id = user && (user.subject_id || user.subject?.id || user.sub);
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '') || user.is_anon) fail(401, 'locker.auth.required', 'Sign in with an OpenVibe account.');
    return id;
};
function createService({ db, config, network, media, now = Date.now }) {
    let shares;
    const iso = () => new Date(now()).toISOString();
    // True sizes stay encrypted. The client enforces the 2 GiB plaintext limit; the server bounds its padded envelope.
    const maxPadded = padme(config.maxFileBytes + 65536 + 8);
    const maxWire = maxPadded + Math.ceil(maxPadded / 1048576) * 33 + 65544;
    const tmp = path.join(config.dataDir, 'uploads');
    const wire = (r) => ({ id: r.id, kind: r.kind, parent: r.parent, envelope_bytes: r.envelope_bytes, lock: r.lock,
        created_at: r.created_at, expires_at: r.expires_at, download_limit: r.download_limit, downloads: r.downloads,
        disabled: r.disabled, revision: r.revision });
    async function account(subject, t = db) {
        await t.exec('INSERT INTO locker_accounts(subject) VALUES ($1) ON CONFLICT DO NOTHING', [subject]);
        return t.one('SELECT * FROM locker_accounts WHERE subject = $1 FOR UPDATE', [subject]);
    }
    async function rate(bucket, limit, windowMs = 3600000) {
        const start = Math.floor(now() / windowMs) * windowMs;
        const r = await db.one(`INSERT INTO locker_rates(bucket, window_start, attempts) VALUES ($1,$2,1)
            ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start,
            attempts = CASE WHEN locker_rates.window_start = excluded.window_start THEN locker_rates.attempts + 1 ELSE 1 END RETURNING attempts`, [bucket, start]);
        if (r.attempts > limit) fail(429, 'locker.rate_limited', 'Please wait before trying again.');
    }
    async function standing(user) {
        const subject = userId(user);
        const state = await network.standing(subject);
        const age = state?.trust?.account_age_days;
        if (!state || state.subject?.id !== subject || state.banned || state.deleted || state.restricted || state.trust?.upload_restricted
            || !Number.isFinite(age) || age < config.minAgeDays || (config.allowlistOnly && !config.allowlist.has(subject))) {
            fail(403, 'locker.upload.ineligible', `Uploads need an account at least ${config.minAgeDays} days old in good standing.`);
        }
        return subject;
    }
    async function reserve(user, bytes, kind) {
        const subject = await standing(user);
        if (!Number.isSafeInteger(bytes) || bytes < 8) fail(411, 'locker.length.required', 'Send Content-Length for the encrypted envelope.');
        if (bytes > maxWire) fail(413, 'locker.file.too_large', 'The encrypted file is too large.');
        await rate(`upload:${subject}`, config.uploadsPerHour);
        if (kind === 'send') await rate(`send:${subject}`, config.sendsPerHour);
        const id = randomUUID();
        // A staged replacement is a real second ciphertext copy until it commits.
        const held = bytes;
        await db.tx(async (t) => {
            const a = await account(subject, t);
            if (a.restricted || a.deleted) fail(403, 'locker.upload.restricted', 'Uploads are restricted for this account.');
            if (a.used_bytes + a.reserved_bytes + held > config.quotaBytes) fail(413, 'locker.quota', 'Your locker storage is full. Delete an item to make room.');
            await t.exec('UPDATE locker_accounts SET reserved_bytes = reserved_bytes + $2 WHERE subject = $1', [subject, held]);
            await t.exec('INSERT INTO locker_uploads(id, owner, bytes, due_at) VALUES ($1,$2,$3,$4)', [id, subject, held, new Date(now() + 3600000).toISOString()]);
        });
        return { id, owner: subject, bytes: held, total: bytes, file: path.join(tmp, `${id}.ovlk`), media_id: null };
    }
    async function queue(t, mediaId) {
        if (mediaId) await t.exec('INSERT INTO locker_gc(media_id,due_at) VALUES ($1,$2) ON CONFLICT DO NOTHING', [mediaId, iso()]);
    }
    async function release(upload, expiredOnly = false) {
        const removed = await db.tx(async (t) => {
            await account(upload.owner, t);
            const r = await t.maybe('DELETE FROM locker_uploads WHERE id = $1 AND ($2::boolean = false OR due_at <= $3) RETURNING *', [upload.id, expiredOnly, iso()]);
            if (!r) return;
            await t.exec('UPDATE locker_accounts SET reserved_bytes = reserved_bytes - $2 WHERE subject = $1', [r.owner, r.bytes]);
            await queue(t, r.media_id);
            return true;
        });
        if (expiredOnly && !removed) return;
        if (upload.file) await fs.rm(upload.file, { force: true });
    }
    async function receive(upload, source) {
        await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
        let count = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) {
            count += chunk.length;
            if (count > upload.total) done(Object.assign(new Error('Envelope length mismatch.'), { status: 400, code: 'locker.length' }));
            else done(null, chunk);
        } });
        await pipeline(source, limit, createWriteStream(upload.file, { flags: 'wx', mode: 0o600 }));
        if (count !== upload.total) fail(400, 'locker.length', 'Envelope length mismatch.');
        const info = await inspectFile(upload.file, count, maxPadded);
        return info;
    }
    async function putMedia(upload) {
        upload.media_id = await media.upload(upload.file, upload.total, upload.owner, async (id) => {
            upload.media_id = id;
            const result = await db.exec('UPDATE locker_uploads SET media_id = $2 WHERE id = $1', [upload.id, id]);
            if (!result) { await queue(db, id); fail(409, 'locker.upload.expired', 'The upload reservation expired. Try again.'); }
        });
    }
    function checkPeople(header, owner, members = []) {
        const expected = new Set([owner, ...members]);
        const actual = header.slots.people || [];
        if (actual.length !== expected.size || actual.some((s) => s.subject.type !== 'user' || !expected.delete(s.subject.id)) || expected.size) {
            fail(400, 'locker.recipients', 'The envelope must have exactly the owner and the current sharing list.');
        }
    }
    async function owned(user, id, t = db) {
        if (!ID.test(id)) fail(404, 'locker.not_found', 'Item not found.');
        const r = await t.maybe('SELECT * FROM locker_items WHERE id = $1 AND owner = $2 AND deleted_at IS NULL', [id, userId(user)]);
        if (!r) fail(404, 'locker.not_found', 'Item not found.');
        return r;
    }
    async function ready(t, upload, delta) {
        const a = await account(upload.owner, t);
        if (a.restricted || a.deleted) fail(403, 'locker.upload.restricted', 'Uploads are restricted for this account.');
        const row = await t.maybe('DELETE FROM locker_uploads WHERE id = $1 RETURNING *', [upload.id]);
        if (!row || Date.parse(row.due_at) <= now()) fail(409, 'locker.upload.expired', 'The upload reservation expired. Try again.');
        await t.exec('UPDATE locker_accounts SET used_bytes = used_bytes + $2, reserved_bytes = reserved_bytes - $3 WHERE subject = $1', [upload.owner, delta, row.bytes]);
    }
    async function remember(t, upload, result) {
        if (upload.resumable) await t.exec(`INSERT INTO locker_upload_results(id,owner,result,due_at) VALUES ($1,$2,$3::jsonb,$4)`,
            [upload.id, upload.owner, JSON.stringify(result), new Date(now() + 86400000).toISOString()]);
    }
    async function create(user, source, bytes, { kind = 'file', parent = null, expiresIn, downloadLimit } = {}, prepared = null) {
        if (!['file', 'folder', 'send'].includes(kind)) fail(400, 'locker.kind', 'Choose a file, folder or Send.');
        let expires = null;
        if (kind === 'send') {
            if (!Number.isSafeInteger(expiresIn) || expiresIn < 3600 || expiresIn > 30 * 86400) fail(400, 'locker.expiry', 'A Send expires in 1 hour to 30 days.');
            if (downloadLimit != null && (!Number.isSafeInteger(downloadLimit) || downloadLimit < 1 || downloadLimit > 100000)) fail(400, 'locker.download_limit', 'The download limit must be a positive integer up to 100000.');
            expires = new Date(now() + expiresIn * 1000).toISOString();
            if (parent) fail(400, 'locker.parent', 'Sends do not belong to folders.');
        }
        const upload = prepared?.upload || await reserve(user, bytes, kind);
        try {
            const { header } = prepared?.info || await receive(upload, source);
            if (kind === 'send' ? header.lock !== 'link' : header.lock !== 'people') fail(400, 'locker.lock', kind === 'send' ? 'Sends use a link lock.' : 'Drive items use a people lock.');
            if (kind !== 'send') checkPeople(header, upload.owner);
            await putMedia(upload);
            const row = await db.tx(async (t) => {
                // The account lock also serializes a parent deletion with this child insertion.
                await ready(t, upload, bytes);
                if (parent) {
                    const p = await owned(user, parent, t);
                    if (p.kind !== 'folder' || p.disabled) fail(400, 'locker.parent', 'Choose one of your active folders.');
                }
                const id = randomUUID();
                const r = await t.one(`INSERT INTO locker_items(id,owner,kind,parent,media_id,envelope_bytes,lock,header,created_at,updated_at,expires_at,download_limit)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,$10,$11) RETURNING *`,
                [id, upload.owner, kind, parent, upload.media_id, bytes, header.lock, JSON.stringify(header), iso(), expires, downloadLimit || null]);
                if (kind !== 'send') {
                    await shares.register(shareRef(id), { owner_subject: subjectRef(upload.owner), audience: 'people', lock: 'people' });
                    await t.exec('UPDATE shares SET reseal_nonce_base = $2 WHERE service = \'locker\' AND kind = \'files\' AND resource_id = $1', [id, header.nonce_base]);
                }
                await remember(t, upload, wire(r));
                return r;
            });
            return wire(row);
        } finally { await release(upload); }
    }
    async function replace(user, id, source, bytes, revision, prepared = null) {
        const old = await owned(user, id);
        if (old.kind === 'send' || old.disabled) fail(409, 'locker.replace', 'This item cannot be changed.');
        if (revision !== old.revision) fail(412, 'locker.revision', 'The item changed. Open it again before saving.');
        const upload = prepared?.upload || await reserve(user, bytes, old.kind);
        try {
            const { header } = prepared?.info || await receive(upload, source);
            if (header.lock !== 'people') fail(400, 'locker.lock', 'Drive items use a people lock.');
            await putMedia(upload);
            return await db.tx(async (t) => {
                const current = await t.one('SELECT * FROM locker_items WHERE id = $1 FOR UPDATE', [id]);
                if (current.revision !== revision || current.deleted_at || current.disabled) fail(412, 'locker.revision', 'The item changed. Open it again.');
                const members = await t.many('SELECT subject FROM share_members WHERE service = \'locker\' AND kind = \'files\' AND resource_id = $1', [id]);
                checkPeople(header, upload.owner, members.map((m) => m.subject.id));
                await ready(t, upload, bytes - old.envelope_bytes);
                await queue(t, old.media_id);
                const r = await t.one('UPDATE locker_items SET media_id=$2,envelope_bytes=$3,header=$4::jsonb,revision=revision+1,updated_at=$5 WHERE id=$1 RETURNING *', [id, upload.media_id, bytes, JSON.stringify(header), iso()]);
                await t.exec('UPDATE shares SET reseal_nonce_base=$2, revision=revision+1 WHERE service=\'locker\' AND kind=\'files\' AND resource_id=$1', [id, header.nonce_base]);
                for (const slot of header.slots.people) await t.exec('UPDATE share_members SET key_slot=$3::jsonb WHERE service=\'locker\' AND kind=\'files\' AND resource_id=$1 AND subject=$2::jsonb', [id, JSON.stringify(slot.subject), JSON.stringify(slot)]);
                await remember(t, upload, wire(r));
                return wire(r);
            });
        } finally { await release(upload); }
    }
    async function list(user, kind, { before, limit = 100 } = {}) {
        let date = null, id = null;
        if (before) {
            try {
                [date, id] = JSON.parse(Buffer.from(before, 'base64url').toString());
                if (!Number.isFinite(Date.parse(date)) || !ID.test(id)) throw new Error('cursor');
            } catch { fail(400, 'locker.cursor', 'Invalid cursor.'); }
        }
        const count = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 100));
        const rows = await db.many(`SELECT * FROM locker_items WHERE owner=$1 AND deleted_at IS NULL AND (kind='send')=$2
            AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
        [userId(user), kind === 'send', date, id, count]);
        return { items: rows.map(wire), next_cursor: rows.length === count ? Buffer.from(JSON.stringify([rows.at(-1).created_at, rows.at(-1).id])).toString('base64url') : null };
    }
    async function view(user, id, send = false) {
        if (!ID.test(id)) fail(404, 'locker.not_found', 'Item not found.');
        const r = await db.maybe('SELECT * FROM locker_items WHERE id=$1 AND deleted_at IS NULL AND disabled=false', [id]);
        if (!r || (r.kind === 'send') !== send) fail(404, 'locker.not_found', 'Item not found.');
        if (send) {
            if (Date.parse(r.expires_at) <= now() || (r.download_limit && r.downloads >= r.download_limit)) fail(410, 'locker.send.expired', 'This Send has expired or reached its download limit.');
        } else if (!user || !await shares.canView({ subject: subjectRef(userId(user)) }, shareRef(id))) fail(404, 'locker.not_found', 'Item not found.');
        return r;
    }
    async function download(user, id, send) {
        let r = await view(user, id, send);
        if (send) {
            // One atomic claim per fetch. A disconnected or failed transfer consumes its claim too.
            r = await db.maybe(`UPDATE locker_items SET downloads=downloads+1 WHERE id=$1 AND kind='send' AND disabled=false AND deleted_at IS NULL
                AND expires_at>$2 AND (download_limit IS NULL OR downloads<download_limit) RETURNING *`, [id, iso()]);
            if (!r) fail(410, 'locker.send.expired', 'This Send has expired or reached its download limit.');
        }
        return { row: r, response: await media.read(r.media_id) };
    }
    async function removeIn(t, row) {
        if (row.deleted_at) return;
        await t.exec('UPDATE locker_items SET deleted_at=$2,disabled=true WHERE id=$1 AND deleted_at IS NULL', [row.id, iso()]);
        await t.exec('UPDATE locker_items SET parent=NULL WHERE parent=$1', [row.id]);
        await t.exec('UPDATE locker_accounts SET used_bytes=used_bytes-$2 WHERE subject=$1', [row.owner, row.envelope_bytes]);
        await queue(t, row.media_id);
    }
    async function remove(user, id) {
        const subject = userId(user);
        await db.tx(async (t) => {
            await account(subject, t);
            const row = await owned(user, id, t);
            await removeIn(t, row);
        });
    }
    async function sweep() {
        // Due rows, one bounded batch per invocation. A one-shot timer schedules the next due timestamp.
        await db.tx(async (t) => {
            const expired = await t.many(`SELECT * FROM locker_items WHERE kind='send' AND deleted_at IS NULL AND expires_at<=$1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [iso()]);
            for (const row of expired) { await account(row.owner, t); await removeIn(t, row); }
        });
        const abandoned = await db.many('SELECT * FROM locker_uploads WHERE due_at<=$1 ORDER BY due_at LIMIT 100', [iso()]);
        for (const u of abandoned) await release({ ...u, file: path.join(tmp, `${u.id}.ovlk`) }, true);
        const garbage = await db.many('SELECT * FROM locker_gc WHERE due_at<=$1 ORDER BY due_at LIMIT 100', [iso()]);
        for (const g of garbage) {
            try { await media.delete(g.media_id); await db.exec('DELETE FROM locker_gc WHERE media_id=$1', [g.media_id]); }
            catch { await db.exec('UPDATE locker_gc SET attempts=attempts+1,due_at=$2 WHERE media_id=$1', [g.media_id, new Date(now() + Math.min(3600000, 30000 * 2 ** Math.min(g.attempts, 7))).toISOString()]); }
        }
        await db.exec('DELETE FROM locker_upload_results WHERE due_at<=$1', [iso()]);
        await db.exec('DELETE FROM locker_rates WHERE window_start<$1', [now() - 2 * 3600000]);
    }
    async function nextDue() {
        return db.value(`SELECT MIN(due) FROM (SELECT MIN(expires_at) due FROM locker_items WHERE kind='send' AND deleted_at IS NULL
            UNION ALL SELECT MIN(due_at) FROM locker_upload_results UNION ALL SELECT MIN(due_at) FROM locker_gc UNION ALL SELECT MIN(due_at) FROM locker_uploads) q`);
    }
    return { db, config, now, iso, wire, maxPadded, maxWire, rate, standing, account, owned, create, replace, list, view, download, remove,
        removeIn, sweep, nextDue, remember, reserve, receive, putMedia, release, queue, ready, checkPeople, inspect: (b) => headerInfo(b, b.length, maxPadded),
        flushShares: () => shares?.flush(), setShares(value) { shares = value; } };
}
module.exports = { createService, userId, subjectRef, shareRef, ID };
