'use strict';
const express = require('express');
const helmet = require('helmet');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { staff } = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { openDb } = require('./db');
const { createNetwork } = require('./network');
const { createMedia } = require('./media');
const { createService, userId, ID } = require('./service');
const { createSharing } = require('./sharing');
const { createUploads, SINGLE_LIMIT } = require('./uploads');
const { createAccountDataForLocker } = require('./account-data');
const { fail, wrap } = require('./errors');
async function createApp(options = {}) {
    const config = options.config || require('./config').load();
    const db = options.db || await openDb(config);
    const network = options.network || createNetwork(config);
    const media = options.media || createMedia(config);
    const service = createService({ db, config, network, media, now: options.now });
    const sharing = createSharing({ service, network });
    const uploads = createUploads({ service, sharing });
    const accountData = createAccountDataForLocker(service);
    const sso = options.sso || createSsoClient({ site: 'locker', baseUrl: config.baseUrl, clientId: config.clientId, clientSecret: config.clientSecret,
        networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl, secureCookies: config.secureCookies, httpOnlyAccess: true });
    const app = express();
    app.disable('x-powered-by'); app.set('trust proxy', config.trustProxy);
    app.use(helmet({ contentSecurityPolicy: { directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", config.networkUrl, 'https://static.cloudflareinsights.com'], styleSrc: ["'self'", "'unsafe-inline'", config.networkUrl, 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:', config.networkUrl, 'https://openvibe.media'],
        connectSrc: ["'self'", config.networkUrl, 'https://openvibe.chat', 'https://billing.openvibe.network', 'https://openvibe.events', 'https://cloudflareinsights.com', 'https://api.pwnedpasswords.com'],
        workerSrc: ["'self'"], frameSrc: [config.networkUrl], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"],
        formAction: ["'self'", config.networkUrl], upgradeInsecureRequests: config.production ? [] : null,
    } }, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'no-referrer' } }));
    app.use('/internal/events', accountData.consumer({ secrets: [config.eventsSecret].filter(Boolean),
        send: options.sendAccountData || (config.clientSecret ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.clientId, clientSecret: config.clientSecret })
            : async () => { throw new Error('Account delivery is not configured.'); }) }));
    app.use('/api/v1/companion', require('./companion').companionRouter({ network, service }));
    app.use('/auth', sso.router(express));
    app.use(sso.optionalAuth());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-locker', version: require('../package.json').version }));
    app.use('/api', (req, res, next) => {
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'X-Robots-Tag': 'noindex' });
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.authorization) {
            if (req.headers.origin !== config.baseUrl || !req.headers['x-requested-with']) return next(Object.assign(new Error('Use this site to make changes.'), { status: 403, code: 'locker.csrf' }));
        }
        next();
    });
    app.use('/api', express.json({ limit: '12mb' }));
    app.use(sharing.middleware);
    const auth = (req) => userId(req.user);
    const staffOnly = (req) => { auth(req); if (!staff.atLeast(req.user, 'global_mod')) fail(403, 'locker.staff.required', 'A Network staff role is required.'); };
    app.get('/api/v1/me', wrap(async (req, res) => {
        const subject = auth(req);
        const a = await db.maybe('SELECT used_bytes,reserved_bytes,restricted FROM locker_accounts WHERE subject=$1', [subject]);
        let eligible = true, reason = null;
        try { await service.standing(req.user); if (a?.restricted) fail(403, 'locker.upload.restricted', 'Uploads are restricted for this account.'); }
        catch (e) { eligible = false; reason = e.message; }
        res.json({ subject, used_bytes: a?.used_bytes || 0, reserved_bytes: a?.reserved_bytes || 0, quota_bytes: config.quotaBytes,
            max_file_bytes: config.maxFileBytes, eligible, reason, staff: staff.atLeast(req.user, 'global_mod') });
    }));
    // Keep SSO access tokens HTTP-only. Forward only these public-key / wrapped-backup endpoints,
    // so unlocking does not depend on a third-party Network cookie being accepted by the browser.
    const keys = (method, pathFor) => wrap(async (req, res) => {
        auth(req);
        res.json(await network.json({ method, path: pathFor(req), token: req.token, preserveProblem: true,
            ...(method === 'PUT' ? { json: req.body } : {}) }));
    });
    app.get('/api/v1/me/keys/backup', keys('GET', () => '/api/v1/me/keys/backup'));
    app.put('/api/v1/me/keys', keys('PUT', () => '/api/v1/me/keys'));
    app.get('/api/v1/people/:subject/keys', keys('GET', (req) => `/api/v1/people/${encodeURIComponent(req.params.subject)}/keys`));
    app.get('/reauth', (_req, res) => {
        const returnTo = `${config.baseUrl}/auth/login?next=${encodeURIComponent('/recovery')}`;
        res.redirect(`${config.networkUrl}/login?reauth=1&return=${encodeURIComponent(returnTo)}`);
    });
    const revisionOf = (req) => Number(String(req.headers['if-match'] || '').replaceAll('"', ''));
    const singleLength = (req) => {
        const bytes = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(bytes) || bytes < 8) fail(411, 'locker.length.required', 'Send Content-Length for the encrypted envelope.');
        if (bytes > SINGLE_LIMIT) fail(413, 'locker.upload.chunked_required', 'Use /api/v1/uploads for envelopes over 90 MiB.');
        return bytes;
    };
    app.post('/api/v1/uploads', wrap(async (req, res) => {
        auth(req); res.status(201).json(await uploads.start(req.user, req.body, revisionOf(req)));
    }));
    app.get('/api/v1/uploads/:id', wrap(async (req, res) => {
        auth(req); res.json(await uploads.status(req.user, req.params.id));
    }));
    app.put('/api/v1/uploads/:id/parts/:n', wrap(async (req, res) => {
        auth(req);
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'locker.envelope.required', 'Send encrypted bytes.');
        const length = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
        res.json(await uploads.part(req.user, req.params.id, req.params.n, req, length));
    }));
    app.post('/api/v1/uploads/:id/complete', wrap(async (req, res) => {
        auth(req); res.json(await uploads.complete(req.user, req.params.id, revisionOf(req)));
    }));
    for (const [plural, kind] of [['files', 'file'], ['sends', 'send']]) {
        const send = kind === 'send';
        app.get(`/api/v1/${plural}`, wrap(async (req, res) => { auth(req); res.json(await service.list(req.user, kind, req.query)); }));
        app.post(`/api/v1/${plural}`, wrap(async (req, res) => {
            auth(req);
            if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'locker.envelope.required', 'Send an application/octet-stream envelope.');
            const allowed = send ? ['expires_in', 'download_limit'] : ['kind', 'parent'];
            if (Object.keys(req.query).some((k) => !allowed.includes(k))) fail(400, 'locker.metadata.private', 'Filenames and content details belong inside the encrypted envelope.');
            const out = await service.create(req.user, req, singleLength(req), { kind: send ? 'send' : req.query.kind || 'file', parent: req.query.parent || null,
                expiresIn: Number(req.query.expires_in), downloadLimit: req.query.download_limit === undefined ? null : Number(req.query.download_limit) });
            res.status(201).json(out);
        }));
        app.get(`/api/v1/${plural}/:id`, wrap(async (req, res) => {
            const row = await service.view(req.user, req.params.id, send);
            res.json({ ...service.wire(row), ...(send ? {} : { header: row.header, can_edit: row.owner === userId(req.user) }) });
        }));
        app.get(`/api/v1/${plural}/:id/content`, wrap(async (req, res) => {
            if (req.method === 'HEAD') return res.status(405).end();
            const { row, response } = await service.download(req.user, req.params.id, send);
            res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="locked.ovlk"', 'Content-Length': String(row.envelope_bytes) });
            await pipeline(Readable.fromWeb(response.body), res);
        }));
        app.delete(`/api/v1/${plural}/:id`, wrap(async (req, res) => { auth(req); const r = await service.owned(req.user, req.params.id); if ((r.kind === 'send') !== send) fail(404, 'locker.not_found', 'Item not found.'); await service.remove(req.user, req.params.id); res.status(204).end(); }));
        app.post(`/api/v1/${plural}/:id/report`, wrap(async (req, res) => {
            const id = req.params.id;
            if (!ID.test(id)) fail(404, 'locker.not_found', 'Item not found.');
            // Reports remain available for a spent Send. There is no key or free-text content in a report.
            const r = await db.maybe('SELECT id,kind FROM locker_items WHERE id=$1', [id]);
            if (!r || (r.kind === 'send') !== send) fail(404, 'locker.not_found', 'Item not found.');
            if (!send) await service.view(req.user, id);
            await service.rate(`report:${req.ip}`, 10);
            if (!['abuse', 'illegal', 'malware', 'other'].includes(req.body?.reason) || Object.keys(req.body).some((k) => k !== 'reason')) fail(400, 'locker.report.reason', 'Choose a report reason.');
            await db.exec('INSERT INTO locker_reports(id,item_id,reporter,reason,created_at) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), id, req.user ? auth(req) : null, req.body.reason, service.iso()]);
            res.status(202).json({ reported: true });
        }));
    }
    app.put('/api/v1/files/:id', wrap(async (req, res) => {
        auth(req);
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'locker.envelope.required', 'Send an encrypted envelope.');
        const revision = Number(String(req.headers['if-match'] || '').replaceAll('"', ''));
        if (!Number.isSafeInteger(revision) || revision < 1) fail(428, 'locker.revision.required', 'Send the item revision in If-Match.');
        res.json(await service.replace(req.user, req.params.id, req, singleLength(req), revision));
    }));
    app.post('/api/v1/files/:id/reseals', wrap(async (req, res) => {
        auth(req);
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'locker.envelope.required', 'Send an encrypted envelope.');
        const revision = Number(String(req.headers['if-match'] || '').replaceAll('"', ''));
        if (!Number.isSafeInteger(revision) || revision < 1) fail(428, 'locker.revision.required', 'Send the item revision in If-Match.');
        res.status(201).json(await sharing.stage(req.user, req.params.id, req, singleLength(req), revision));
    }));
    app.get('/api/v1/account/export', wrap(async (req, res) => res.json(await accountData.exportPart(auth(req)))));
    app.delete('/api/v1/account', wrap(async (req, res) => {
        const subject = auth(req);
        if (req.body?.confirmation !== 'delete my locker') fail(400, 'locker.delete.confirm', 'Type delete my locker to confirm.');
        res.json(await accountData.erase([subject]));
    }));
    app.get('/api/v1/staff/reports', wrap(async (req, res) => { staffOnly(req); res.json({ reports: await db.many('SELECT r.*,i.owner,i.disabled FROM locker_reports r JOIN locker_items i ON i.id=r.item_id ORDER BY r.created_at DESC LIMIT 100') }); }));
    app.post('/api/v1/staff/items/:id/disable', wrap(async (req, res) => {
        staffOnly(req);
        if (!ID.test(req.params.id)) fail(404, 'locker.not_found', 'Item not found.');
        await db.tx(async (t) => {
            const item = await t.maybe('UPDATE locker_items SET disabled=true WHERE id=$1 RETURNING id', [req.params.id]);
            if (!item) fail(404, 'locker.not_found', 'Item not found.');
            await t.exec('UPDATE locker_reports SET resolved_at=$2 WHERE item_id=$1', [req.params.id, service.iso()]);
            await t.exec('INSERT INTO locker_moderation VALUES ($1,$2,$3,$4,$5)', [randomUUID(), auth(req), req.params.id, 'disable', service.iso()]);
        });
        res.json({ disabled: true });
    }));
    app.put('/api/v1/staff/people/:subject/restriction', wrap(async (req, res) => {
        staffOnly(req);
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(req.params.subject) || typeof req.body?.restricted !== 'boolean') fail(400, 'locker.restriction', 'Choose the account and restriction.');
        await db.tx(async (t) => {
            await service.account(req.params.subject, t);
            await t.exec('UPDATE locker_accounts SET restricted=$2 WHERE subject=$1', [req.params.subject, req.body.restricted]);
            await t.exec('INSERT INTO locker_moderation VALUES ($1,$2,$3,$4,$5)', [randomUUID(), auth(req), req.params.subject, req.body.restricted ? 'restrict' : 'unrestrict', service.iso()]);
        });
        res.json({ restricted: req.body.restricted });
    }));
    // GET /release.json (ADR-016): the navbar's release watch polls it so open tabs learn of a new release (the 11-09
    // browser sweep found it answering 404 here).
    require('openvibe-shared/release').createRelease({ service: 'locker', root: path.join(__dirname, '..') }).mount(app);
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: '1h' }));
    app.use(require('./pages').createPages({ config }));
    app.use((err, _req, res, _next) => {
        if (res.headersSent) return res.destroy();
        const status = Number(err.status) || 500;
        res.status(status).type('application/problem+json').json({ type: 'about:blank', status, code: err.code || 'locker.request.failed',
            detail: status < 500 ? err.message : 'Locker could not complete this request. Please try again.' });
    });
    return { app, db, config, service, sharing, accountData };
}
module.exports = { createApp };
