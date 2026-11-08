'use strict';
const { createDb } = require('openvibe-sdk/db');
const { migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { load } = require('../server/config');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const locker = require('openvibe-sdk/locker');
const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
const STAFF = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS';
async function boot(overrides = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'locker-test-'));
    const db = createDb({ pglite: true, service: 'locker-test' }); await migrate(db);
    const config = { ...load({ LOCKER_DATA_DIR: dir, BASE_URL: 'http://localhost', LOCKER_QUOTA_BYTES: String(30 * 1024 ** 2) }), ...overrides.config };
    let clock = Date.now(), seq = 0;
    const blobs = new Map(), deleted = [], principals = new Map();
    const people = new Map();
    people.set(SUBJECT, await locker.generatePersonKeys()); people.set(OTHER, await locker.generatePersonKeys());
    const backups = new Map();
    const network = {
        backups,
        async standing(subject) { return { subject: { type: 'user', id: subject }, trust: { account_age_days: 8 }, ...principals.get(subject) }; },
        async json(options) {
            if (options.path === '/api/v1/me/keys/backup') return { subject: options.token, backups: backups.get(options.token) || {} };
            if (options.path === '/api/v1/me/keys' && options.method === 'PUT') { backups.set(options.token, options.json.backups); return { saved: true }; }
            if (options.path.endsWith('/resolve-batch')) return { results: Object.fromEntries(options.json.subject_ids.map((subject) => [subject,
                { subject: { type: 'user', id: subject }, username: subject === OTHER ? 'friend' : 'owner', display_name: null, avatar_url: null }])) };
            if (options.path.startsWith('/api/v1/people/')) {
                const id = options.path.split('/')[4]; const keys = people.get(id);
                if (!keys) throw new Error('Unknown person');
                const pub = await locker.exportPersonKeys(keys);
                return { subject: id, ecdh_public: pub.ecdh, signing_public: pub.signing, fingerprint: pub.fingerprint };
            }
            if (options.path.includes('/identity/resolve')) {
                const subject = options.query.subject_id || (options.query.username === 'friend' ? OTHER : SUBJECT);
                return { subject: { type: 'user', id: subject }, username: subject === OTHER ? 'friend' : 'owner', display_name: null, avatar_url: null };
            }
            return {};
        },
    };
    const media = {
        async upload(file, bytes, _owner, record) {
            const id = `med_${String(++seq).padStart(26, '0')}`; await record(id);
            const contents = await fs.readFile(file); if (contents.length !== bytes) throw new Error('wrong size');
            blobs.set(id, contents); return id;
        },
        async read(id) { if (!blobs.has(id)) throw new Error('missing'); return new Response(blobs.get(id)); },
        async delete(id) { deleted.push(id); blobs.delete(id); },
    };
    const sso = {
        router(express) { const r = express.Router(); r.get('/me', (_req, res) => res.json({ user: null })); return r; },
        optionalAuth: () => (req, _res, next) => {
            const id = String(req.headers.authorization || '').replace(/^Bearer /, '');
            if ([SUBJECT, OTHER, STAFF].includes(id)) { req.user = { subject_id: id, role: id === STAFF ? 'global_mod' : 'user' }; req.token = id; }
            next();
        },
    };
    const ctx = await createApp({ ...overrides, config, db, sso, media, network, now: () => clock });
    const server = ctx.app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`; config.baseUrl = base;
    async function request(method, url, { user = SUBJECT, json, body, headers = {} } = {}) {
        const r = await fetch(base + url, { method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}),
            ...(json === undefined ? body ? { 'Content-Type': 'application/octet-stream' } : {} : { 'Content-Type': 'application/json' }), ...headers },
        body: json === undefined ? body : JSON.stringify(json) });
        return r;
    }
    async function envelope(value = 'private bytes', { lock = 'people', owner = SUBJECT, keys = people.get(owner) } = {}) {
        return locker.seal(value, lock === 'people' ? { lock, keys: [{ subject: { type: 'user', id: owner }, publicKey: keys.ecdhPublic }] } : { lock });
    }
    return { ...ctx, media, network, config, base, server, blobs, deleted, principals, people, request, envelope,
        advance(ms) { clock += ms; }, async close() { await new Promise((r) => server.close(r)); await db.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
module.exports = { boot, SUBJECT, OTHER, STAFF, locker };
