'use strict';
const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fail, wrap } = require('./errors');
const { userId, ID } = require('./service');

// Deliberately separate from the full Locker API: the scoped Companion token can only
// read its owner's wrapped keys and read/create that owner's encrypted login items.
function companionRouter({ network, service }) {
    const router = express.Router();
    router.use((req, res, next) => { (async () => {
        res.set('Cache-Control', 'private, no-store');
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
        if (!token) fail(401, 'locker.auth.required', 'Sign in to Companion.');
        const keys = await network.json({ path: '/api/v1/me/keys/companion', token, preserveProblem: true });
        req.companionKeys = keys;
        req.user = { subject_id: keys.subject };
        userId(req.user);
        next();
    })().catch(next); });
    router.get('/keys', (req, res) => res.json(req.companionKeys));
    router.get('/logins', wrap(async (req, res) => {
        // Paginate the underlying owner-only list, preserving its cursor even if this page has no logins.
        const page = await service.list(req.user, 'file', req.query);
        res.json({ ...page, items: page.items.filter((item) => item.kind === 'login') });
    }));
    router.get('/logins/:id/content', wrap(async (req, res) => {
        if (!ID.test(req.params.id)) fail(404, 'locker.not_found', 'Login not found.');
        const row = await service.owned(req.user, req.params.id);
        if (row.kind !== 'login') fail(404, 'locker.not_found', 'Login not found.');
        const { response } = await service.download(req.user, row.id);
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(row.envelope_bytes) });
        await pipeline(Readable.fromWeb(response.body), res);
    }));
    router.post('/logins', wrap(async (req, res) => {
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'locker.envelope.required', 'Send an encrypted envelope.');
        if (Object.keys(req.query).length) fail(400, 'locker.metadata.private', 'Keep login details encrypted.');
        const bytes = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > 2 * 1024 ** 2) fail(413, 'locker.length', 'Login envelope must be at most 2 MiB.');
        res.status(201).json(await service.create(req.user, req, bytes, { kind: 'login' }));
    }));
    return router;
}
module.exports = { companionRouter };
