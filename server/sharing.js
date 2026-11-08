'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const { createShares } = require('openvibe-sdk/share');
const { userId, subjectRef, shareRef } = require('./service');
const { fail } = require('./errors');
function createSharing({ service, network }) {
    const { db, config } = service;
    const context = new AsyncLocalStorage();
    async function commitEnvelope(ref, _receipt, t) {
        const ctx = context.getStore();
        if (!ctx?.prepared || ctx.id !== ref.id) fail(409, 'locker.share.prepare', 'Upload the newly sealed envelope with this sharing change.');
        const { upload, info, old } = ctx.prepared;
        const current = await t.one('SELECT * FROM locker_items WHERE id=$1 FOR UPDATE', [ref.id]);
        if (current.revision !== old.revision || current.disabled || current.deleted_at || current.owner !== upload.owner) fail(412, 'locker.revision', 'The item changed. Open it again.');
        const held = await t.maybe('SELECT * FROM locker_uploads WHERE id=$1 FOR UPDATE', [upload.id]);
        if (!held || Date.parse(held.due_at) <= service.now() || (held.target && held.target !== ref.id)) fail(409, 'locker.upload.expired', 'The staged upload has expired.');
        const members = ctx.members || [];
        service.checkPeople(info.header, current.owner, members.map((m) => m.subject.id));
        await service.ready(t, upload, upload.total - current.envelope_bytes);
        await service.queue(t, current.media_id);
        await t.exec('UPDATE locker_items SET media_id=$2,envelope_bytes=$3,header=$4::jsonb,revision=revision+1,updated_at=$5 WHERE id=$1',
            [ref.id, upload.media_id, upload.total, JSON.stringify(info.header), service.iso()]);
    }
    const shares = createShares({ db, now: service.now,
        network: { async json(options) {
            const keys = /^\/api\/v1\/people\//.test(options.path);
            const out = await network.json({ ...options, token: keys ? context.getStore()?.token : undefined });
            return keys && out?.ecdh_public ? { ...out, ecdh: out.ecdh_public, signing: out.signing_public } : out;
        } },
        events: { publish: (event) => network.json({ path: '/api/v1/events', method: 'POST', json: event, audience: 'openvibe.events', base: config.eventsUrl }) },
        notify: (n) => network.json({ path: '/internal/notifications/push', method: 'POST', json: {
            subject: n.to.id, service: 'locker', type: 'GENERIC', category: 'social',
            title: 'Sharing on OpenVibe Locker', message: 'A locked item was shared or its access changed.',
            url: `${config.baseUrl}/files/${encodeURIComponent(n.ref.id)}`,
        } }),
        onAudienceChange: async (_ref, audience) => {
            if (!['people', 'private'].includes(audience)) fail(400, 'locker.share.private', 'Drive items can only be shared with specific people.');
        },
        onOwnerChange: async () => fail(409, 'locker.transfer.unavailable', 'Move a copy into your own locker; ownership transfer is not available.'),
        onReseal: commitEnvelope,
        resolveReseal: async (ref, viewer, receipt) => {
            const prepared = context.getStore()?.prepared;
            if (!prepared || prepared.upload.id !== receipt || prepared.old.id !== ref.id || prepared.upload.owner !== viewer.subject.id) fail(404, 'locker.upload.not_found', 'No staged envelope for this item.');
            return { prefix: prepared.info.prefix, byteLength: prepared.upload.total };
        },
        onResealReference: commitEnvelope,
    });
    service.setShares(shares);
    const viewer = (req) => req.user ? { subject: subjectRef(userId(req.user)) } : null;
    async function middleware(req, res, next) {
        const match = req.path.match(/^\/api\/v1\/files\/([^/]+)\/share(?:\/(.*))?$/);
        if (!match && !['/api/v1/share/people', '/api/v1/shared-with-me'].includes(req.path)) return next();
        const ctx = { token: req.token, id: match?.[1], prepared: null, members: req.body?.members };
        try {
            if (match) {
                // Disabled and deleted items cannot be changed through the generic share router.
                const row = await service.view(req.user, match[1]);
                if (row.kind === 'login') fail(409, 'locker.login.private', 'Password logins cannot be shared.');
                if (!['GET', 'HEAD'].includes(req.method) && match[2] !== 'requests') {
                    await service.owned(req.user, match[1]);
                    if (req.body?.members !== undefined && !Array.isArray(req.body.members)) fail(400, 'locker.share.members', 'Members must be a list.');
                    if (req.body?.members?.some((m) => !m || m.role !== 'viewer')) fail(400, 'locker.share.role', 'Locked files are shared with viewers.');
                    if ((req.body?.envelope !== undefined || req.body?.envelope_ref !== undefined) && !Array.isArray(req.body.members)) fail(400, 'locker.share.members', 'A reseal must include the complete members list.');
                    if (match[2]?.startsWith('transfer')) fail(409, 'locker.transfer.unavailable', 'Ownership transfer is not available.');
                    if (typeof req.body?.envelope === 'string') {
                        const bytes = Buffer.from(req.body.envelope, 'base64');
                        const info = service.inspect(bytes);
                        const upload = await service.reserve(req.user, bytes.length, row.kind);
                        ctx.prepared = { upload, info, old: row };
                        await service.receive(upload, Readable.from(bytes));
                        await service.putMedia(upload);
                    } else if (req.body?.envelope_ref) {
                        const receipt = req.body.envelope_ref;
                        if (!/^[0-9a-f-]{36}$/.test(receipt)) fail(400, 'locker.upload.reference', 'Invalid staged upload reference.');
                        const upload = await db.maybe('SELECT * FROM locker_uploads WHERE id=$1 AND owner=$2 AND target=$3', [receipt, userId(req.user), row.id]);
                        if (!upload || !upload.prefix || !upload.media_id || Date.parse(upload.due_at) <= service.now() || upload.revision !== row.revision) fail(409, 'locker.upload.expired', 'The item or staged upload changed. Upload it again.');
                        const prefix = Buffer.from(upload.prefix);
                        ctx.prepared = { upload: { ...upload, total: upload.total_bytes, file: '' }, info: { prefix, header: JSON.parse(prefix.subarray(8).toString()) }, old: row };
                    }
                }
            }
            await context.run(ctx, () => shares.router({ service: 'locker', authenticate: viewer,
                describe: async (ref) => {
                    await service.view(req.user, ref.id);
                    return { title: 'A locked item', link: `${config.baseUrl}/files/${ref.id}`, roles: ['viewer'], audiences: ['people', 'private'], transferable: false,
                        envelope_url: `/api/v1/files/${ref.id}/content` };
                }, csrf: false,
            })(req, res, next));
        } catch (e) { next(e); }
        finally { if (ctx.prepared) await service.release(ctx.prepared.upload); }
    }
    async function stage(user, id, source, bytes, revision, prepared = null) {
        const old = await service.owned(user, id);
        if (old.kind === 'send' || old.disabled || old.revision !== revision) fail(412, 'locker.revision', 'The item changed. Open it again.');
        const upload = prepared?.upload || await service.reserve(user, bytes, old.kind);
        let staged = false;
        try {
            const info = prepared?.info || await service.receive(upload, source);
            if (info.header.lock !== 'people') fail(400, 'locker.lock', 'Drive items use a people lock.');
            await service.putMedia(upload);
            await db.tx(async (t) => {
                const a = await service.account(upload.owner, t);
                if (a.deleted || a.restricted) fail(403, 'locker.upload.restricted', 'Uploads are restricted for this account.');
                const held = await t.maybe('SELECT * FROM locker_uploads WHERE id=$1 FOR UPDATE', [upload.id]);
                if (!held || Date.parse(held.due_at) <= service.now()) fail(409, 'locker.upload.expired', 'The upload expired.');
                await t.exec('UPDATE locker_uploads SET total_bytes=$2,target=$3,revision=$4,prefix=$5 WHERE id=$1', [upload.id, bytes, id, revision, info.prefix]);
                await service.remember(t, upload, { envelope_ref: upload.id, header: info.header });
            });
            staged = true;
            return { envelope_ref: upload.id, header: info.header };
        } finally {
            if (!staged) await service.release(upload);
            else await fs.rm(upload.file, { force: true });
        }
    }
    return { shares, middleware, viewer, shareRef, stage };
}
module.exports = { createSharing };
