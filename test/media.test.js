'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMedia } = require('../server/media');
test('Media adapter streams multipart ciphertext, keeps signed URLs private and requests retryable erasure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'locker-media-client-'));
    const file = path.join(dir, 'ciphertext');
    const ciphertext = Buffer.alloc(2 * 1048576 + 29, 123); await fs.writeFile(file, ciphertext);
    const id = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const parts = [], calls = []; let recorded, tokenRequests = 0, retry = true;
    const json = (body, status = 200) => Response.json(body, { status });
    const fakeFetch = async (url, options) => {
        const u = new URL(url); calls.push([options?.method || 'GET', u.pathname, u.search]);
        if (u.pathname === '/oauth/token') { tokenRequests++; return json({ access_token: 'test-only', expires_in: 300 }); }
        if (u.pathname === '/signed-ciphertext') {
            assert.equal(options.redirect, 'follow'); assert.equal(options.headers, undefined);
            return new Response(ciphertext);
        }
        assert.equal(options.headers.Authorization, 'Bearer test-only');
        if (retry) { retry = false; return json({}, 401); }
        if (u.pathname.endsWith('/objects')) {
            assert.deepEqual(JSON.parse(options.body), { kind: 'file', namespace: 'locker', visibility: 'private', mime_type: 'application/octet-stream',
                size_bytes: ciphertext.length, filename: 'locked.ovlk', multipart: true, part_size: 8388608 });
            assert.equal(options.headers['X-OV-Subject'], 'usr_test');
            return json({ id, upload: { multipart: { upload_id: 'multipart-test', part_size: 1048576 } } });
        }
        if (u.pathname.includes('/parts/')) { assert.equal(recorded, id); parts.push(Buffer.from(options.body)); return json({}); }
        if (u.pathname.endsWith('/complete')) { assert.deepEqual(Buffer.concat(parts), ciphertext); return json({}); }
        if (u.pathname.endsWith('/download')) { assert.equal(u.search, '?format=json'); return json({ url: 'https://media.test/signed-ciphertext' }); }
        assert.equal(options.method, 'DELETE'); assert.equal(u.search, '?purge=1'); return json({});
    };
    try {
        const media = createMedia({ networkInternalUrl: 'https://network.test', mediaUrl: 'https://media.test', clientId: 'locker', clientSecret: '' }, fakeFetch);
        assert.equal(await media.upload(file, ciphertext.length, 'usr_test', async (value) => { recorded = value; }), id);
        assert.equal(tokenRequests, 2, 'a rejected token is refreshed once');
        assert.equal(parts.length, 3); assert.ok(calls.some((x) => x[1].endsWith('/multipart/multipart-test/parts/3')));
        assert.deepEqual(Buffer.from(await (await media.read(id)).arrayBuffer()), ciphertext);
        await media.delete(id);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Network key proxy preserves reauthentication errors without fetching service credentials', async () => {
    const { createNetwork } = require('../server/network');
    const network = createNetwork({ networkInternalUrl: 'https://network.test', clientId: 'locker', clientSecret: '' }, async (url, options) => {
        assert.equal(new URL(url).pathname, '/api/v1/me/keys');
        assert.equal(options.headers.Authorization, 'Bearer test-session');
        return Response.json({ error: 'locker.reauth_required', message: 'Sign in again.' }, { status: 403 });
    });
    await assert.rejects(network.json({ method: 'PUT', path: '/api/v1/me/keys', json: {}, token: 'test-session', preserveProblem: true }),
        (e) => e.status === 403 && e.code === 'locker.reauth_required');
});

test('a download signed on the public Media origin is fetched over the loopback origin; any other origin is refused', async () => {
    const seen = [];
    const json = (body) => Response.json(body);
    let signed = 'https://media.public/o/med_x?sig=abc';
    const fakeFetch = async (url, options) => {
        const u = new URL(url); seen.push(u.href);
        if (u.pathname === '/oauth/token') return json({ access_token: 'test-only', expires_in: 300 });
        if (u.pathname.endsWith('/download')) return json({ url: signed });
        assert.equal(options.headers, undefined, 'no service credentials follow a signed URL');
        return new Response(Buffer.from('ciphertext'));
    };
    const media = createMedia({ networkInternalUrl: 'https://network.test', mediaUrl: 'http://127.0.0.1:4100', mediaPublicUrl: 'https://media.public', clientId: 'locker', clientSecret: '' }, fakeFetch);
    assert.equal(Buffer.from(await (await media.read('med_x')).arrayBuffer()).toString(), 'ciphertext');
    assert.ok(seen.includes('http://127.0.0.1:4100/o/med_x?sig=abc'), 'the signed path went to loopback');
    signed = 'https://elsewhere.example/o/med_x?sig=abc';
    await assert.rejects(media.read('med_x'), (e) => e.code === 'locker.media.origin');
});
