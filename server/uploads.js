'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ID, userId } = require('./service');
const { inspectFile } = require('./envelope');
const { fail } = require('./errors');
const PART_SIZE = 32 * 1024 ** 2;
const SINGLE_LIMIT = 90 * 1024 ** 2;
function createUploads({ service, sharing }) {
    const { db, config } = service;
    const directory = path.join(config.dataDir, 'uploads');
    const fileFor = (id) => path.join(directory, `${id}.ovlk`);
    const due = () => new Date(service.now() + 3600000).toISOString();
    async function row(user, id, t = db, lock = false) {
        if (!ID.test(id)) fail(404, 'locker.upload.not_found', 'Upload not found.');
        const r = await t.maybe(`SELECT * FROM locker_uploads WHERE id=$1 AND owner=$2 AND options IS NOT NULL${lock ? ' FOR UPDATE' : ''}`, [id, userId(user)]);
        if (!r || Date.parse(r.due_at) <= service.now()) fail(404, 'locker.upload.not_found', 'Upload not found or expired.');
        return r;
    }
    async function result(user, id) {
        if (!ID.test(id)) fail(404, 'locker.upload.not_found', 'Upload not found.');
        return db.maybe('SELECT result FROM locker_upload_results WHERE id=$1 AND owner=$2 AND due_at>$3', [id, userId(user), service.iso()]);
    }
    async function start(user, input, revision) {
        const allowed = ['kind', 'bytes', 'parent', 'expires_in', 'download_limit', 'item_id'];
        if (!input || Array.isArray(input) || Object.keys(input).some((k) => !allowed.includes(k))) fail(400, 'locker.metadata.private', 'Only upload settings belong outside the envelope.');
        const { kind, bytes, parent, expires_in: expiresIn, download_limit: downloadLimit, item_id: itemId } = input;
        if (!['file', 'folder', 'send', 'replace', 'reseal'].includes(kind)) fail(400, 'locker.kind', 'Choose file, folder, send, replace or reseal.');
        if (['replace', 'reseal'].includes(kind)) {
            if (!Number.isSafeInteger(revision) || revision < 1) fail(428, 'locker.revision.required', 'Send the item revision in If-Match.');
            const item = await service.owned(user, itemId);
            if (item.kind === 'send' || item.disabled || item.revision !== revision) fail(412, 'locker.revision', 'The item changed. Open it again.');
        } else if (itemId != null) fail(400, 'locker.kind', 'Use replace or reseal with item_id.');
        if (kind === 'send') {
            if (!Number.isSafeInteger(expiresIn) || expiresIn < 3600 || expiresIn > 30 * 86400) fail(400, 'locker.expiry', 'A Send expires in 1 hour to 30 days.');
            if (downloadLimit != null && (!Number.isSafeInteger(downloadLimit) || downloadLimit < 1 || downloadLimit > 100000)) fail(400, 'locker.download_limit', 'Choose a positive download limit up to 100000.');
        } else if (expiresIn != null || downloadLimit != null) fail(400, 'locker.kind', 'Only Sends have expiry and download limits.');
        if (parent != null) {
            if (!['file', 'folder'].includes(kind)) fail(400, 'locker.parent', 'Only Drive items belong to folders.');
            const folder = await service.owned(user, parent);
            if (folder.kind !== 'folder' || folder.disabled) fail(400, 'locker.parent', 'Choose an active folder.');
        }
        const upload = await service.reserve(user, bytes, kind);
        try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const file = await fs.open(upload.file, 'wx', 0o600);
            try { await file.truncate(bytes); } finally { await file.close(); }
            await db.exec('UPDATE locker_uploads SET options=$2::jsonb,total_bytes=$3,target=$4,revision=$5 WHERE id=$1',
                [upload.id, JSON.stringify(input), bytes, itemId || null, revision || null]);
            return { id: upload.id, part_size: PART_SIZE };
        } catch (e) { await service.release(upload); throw e; }
    }
    async function status(user, id) {
        const done = await result(user, id);
        if (done) return { id, part_size: PART_SIZE, state: 'complete', result: done.result };
        const r = await row(user, id);
        const parts = await db.many('SELECT part FROM locker_upload_parts WHERE upload_id=$1 ORDER BY part', [id]);
        return { id, part_size: PART_SIZE, bytes: r.total_bytes, received_parts: parts.map((p) => p.part),
            state: r.completing ? 'completing' : 'open', expires_at: r.due_at };
    }
    async function part(user, id, number, source, length) {
        if (!/^(0|[1-9][0-9]*)$/.test(number)) fail(400, 'locker.upload.part', 'Invalid part number.');
        const n = Number(number);
        // Hold the row lock through writes and fsync. Completion, duplicate parts and cleanup
        // cannot race these writes, including when multiple service processes share the database.
        await db.tx(async (t) => {
            const r = await row(user, id, t, true);
            if (r.completing) fail(409, 'locker.upload.busy', 'The upload is completing.');
            const expected = Math.min(PART_SIZE, r.total_bytes - n * PART_SIZE);
            if (!Number.isSafeInteger(n) || expected <= 0) fail(400, 'locker.upload.part', 'Part is outside the envelope.');
            if (length > PART_SIZE || length > expected) fail(413, 'locker.upload.part_size', 'The part is too large.');
            if (length != null && length !== expected) fail(400, 'locker.upload.length', 'The part length does not match.');
            if (await t.maybe('SELECT part FROM locker_upload_parts WHERE upload_id=$1 AND part=$2', [id, n])) {
                source.resume(); return; // A lost response can safely retry a committed part.
            }
            const file = await fs.open(fileFor(id), 'r+');
            let count = 0;
            try {
                // Do not destroy IncomingMessage on a length error; the caller must receive the 413.
                for await (const chunk of source.iterator({ destroyOnReturn: false })) {
                    if (count + chunk.length > expected) fail(413, 'locker.upload.part_size', 'The part is too large.');
                    let offset = 0;
                    while (offset < chunk.length) {
                        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, n * PART_SIZE + count + offset);
                        if (!bytesWritten) throw new Error('Could not write the upload part.');
                        offset += bytesWritten;
                    }
                    count += chunk.length;
                }
                if (count !== expected) fail(400, 'locker.upload.length', 'The part length does not match.');
                await file.sync();
                await t.exec('INSERT INTO locker_upload_parts(upload_id,part,bytes) VALUES ($1,$2,$3)', [id, n, count]);
                await t.exec('UPDATE locker_uploads SET due_at=$2 WHERE id=$1', [id, due()]);
            } finally { await file.close(); }
        });
        return { received: n };
    }
    async function complete(user, id, revision) {
        const done = await result(user, id);
        if (done) return done.result;
        await service.standing(user);
        const r = await db.tx(async (t) => {
            const held = await row(user, id, t, true);
            if (held.completing) fail(409, 'locker.upload.busy', 'The upload is completing.');
            if (held.target && held.revision !== revision) fail(412, 'locker.revision', 'Send the original If-Match revision.');
            const parts = await t.many('SELECT part,bytes FROM locker_upload_parts WHERE upload_id=$1 ORDER BY part', [id]);
            if (parts.length !== Math.ceil(held.total_bytes / PART_SIZE) || parts.some((p, n) => p.part !== n || p.bytes !== Math.min(PART_SIZE, held.total_bytes - n * PART_SIZE))) {
                fail(409, 'locker.upload.incomplete', 'Upload every part before completing.');
            }
            await t.exec('UPDATE locker_uploads SET completing=true,due_at=$2 WHERE id=$1', [id, due()]);
            return held;
        });
        const upload = { ...r, total: r.total_bytes, file: fileFor(id), resumable: true };
        try {
            const info = await inspectFile(upload.file, upload.total, service.maxPadded);
            const prepared = { upload, info };
            if (r.options.kind === 'reseal') return await sharing.stage(user, r.target, null, upload.total, r.revision, prepared);
            if (r.options.kind === 'replace') return await service.replace(user, r.target, null, upload.total, r.revision, prepared);
            return await service.create(user, null, upload.total, { kind: r.options.kind, parent: r.options.parent,
                expiresIn: r.options.expires_in, downloadLimit: r.options.download_limit }, prepared);
        } catch (e) { await service.release(upload); throw e; }
    }
    return { start, status, part, complete };
}
module.exports = { createUploads, PART_SIZE, SINGLE_LIMIT };
