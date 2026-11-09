'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { boot, SUBJECT, OTHER, STAFF, locker } = require('./helpers');
const payload = require('../public/js/payload');
let t;
before(async () => { t = await boot(); }); after(async () => t?.close());
const create = async (sealed, send = false, extra = '') => {
    const r = await t.request('POST', send ? `/api/v1/sends?expires_in=3600${extra}` : `/api/v1/files${extra}`, { body: sealed.bytes });
    const body = await r.json(); assert.equal(r.status, 201, JSON.stringify(body)); return body;
};

test('password login items use people locks and remain opaque in storage', async () => {
    const secret = JSON.stringify({ version: 1, site: 'https://example.test', username: 'alice', password: 'secret-password', totp: '', notes: '' });
    const encrypted = await locker.seal(secret, { lock: 'people', keys: [{ subject: { type: 'user', id: SUBJECT }, publicKey: t.people.get(SUBJECT).ecdhPublic }] });
    const item = await create(encrypted, false, '?kind=login');
    assert.equal(item.kind, 'login');
    const stored = await t.db.one('SELECT kind,lock FROM locker_items WHERE id=$1', [item.id]);
    assert.deepEqual(stored, { kind: 'login', lock: 'people' });
    const bytes = new Uint8Array(await (await t.request('GET', `/api/v1/files/${item.id}/content`)).arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes).includes('secret-password'), false);
    assert.equal(new TextDecoder().decode(await locker.open(bytes, { person: t.people.get(SUBJECT) })), secret);
    assert.equal((await t.request('GET', '/api/v1/files')).status, 200);
    const release = await t.request('GET', '/release.json');
    assert.equal(release.status, 200, 'the navbar release watch polls /release.json');
    assert.equal((await release.json()).service, 'locker');
});
test('WebCrypto stream → ciphertext API → download → authenticated opening, with private metadata', async () => {
    const file = new Blob([Buffer.alloc(2 * 1048576 + 93, 71)]);
    const meta = { name: 'private-name.pdf', type: 'application/pdf', size: file.size };
    const plain = payload.pack(meta, file.stream());
    const encrypted = await new Response(locker.sealStream(plain, { lock: 'people', keys: [{ subject: { type: 'user', id: SUBJECT }, publicKey: t.people.get(SUBJECT).ecdhPublic }], size: payload.prefix(meta).length + file.size })).arrayBuffer();
    const item = await create({ bytes: encrypted });
    const row = await t.db.one('SELECT * FROM locker_items WHERE id=$1', [item.id]);
    assert.ok(!JSON.stringify(row).includes(meta.name)); assert.ok(!JSON.stringify(row).includes(meta.type));
    assert.ok(!t.blobs.get(row.media_id).includes(Buffer.from(meta.name)));
    const r = await t.request('GET', `/api/v1/files/${item.id}/content`); assert.equal(r.status, 200);
    const opened = await payload.unpack(locker.openStream(r.body, { person: t.people.get(SUBJECT) }));
    assert.deepEqual(opened.meta, { version: 1, ...meta });
    assert.deepEqual(Buffer.from(await new Response(opened.stream).arrayBuffer()), Buffer.from(await file.arrayBuffer()));
    assert.equal((await t.request('GET', `/api/v1/files/${item.id}/content`, { user: OTHER })).status, 404);
    assert.equal((await t.request('GET', `/api/v1/files/${item.id}/content`, { user: null })).status, 404);
});
test('plaintext, JSON, malformed, truncated and trailing-byte envelopes are rejected without storage', async () => {
    const good = await t.envelope(); const original = t.blobs.size;
    for (const bytes of [Buffer.from('plaintext is never a file'), good.bytes.slice(0, -1), Buffer.concat([good.bytes, Buffer.from([0])])]) {
        assert.equal((await t.request('POST', '/api/v1/files', { body: bytes })).status, 400);
    }
    assert.equal((await t.request('POST', '/api/v1/files', { json: { name: 'plaintext', content: 'hello' } })).status, 415);
    assert.equal((await t.request('POST', '/api/v1/files?name=private', { body: good.bytes })).status, 400);
    assert.equal(t.blobs.size, original);
    assert.equal(await t.db.value('SELECT COUNT(*)::int FROM locker_uploads'), 0);
});
test('good standing uses current Network age and bans, local restrictions and optional allowlist', async () => {
    const env = await t.envelope();
    t.principals.set(SUBJECT, { trust: { account_age_days: 6 } });
    assert.equal((await t.request('POST', '/api/v1/files', { body: env.bytes })).status, 403);
    t.principals.set(SUBJECT, { banned: true });
    assert.equal((await t.request('POST', '/api/v1/files', { body: env.bytes })).status, 403);
    t.principals.delete(SUBJECT);
    await t.request('PUT', `/api/v1/staff/people/${SUBJECT}/restriction`, { user: STAFF, json: { restricted: true } });
    assert.equal((await t.request('POST', '/api/v1/files', { body: env.bytes })).status, 403);
    await t.request('PUT', `/api/v1/staff/people/${SUBJECT}/restriction`, { user: STAFF, json: { restricted: false } });
    t.config.allowlistOnly = true;
    assert.equal((await t.request('POST', '/api/v1/files', { body: env.bytes })).status, 403);
    t.config.allowlist.add(SUBJECT); await create(env); t.config.allowlistOnly = false;
});
test('quota reservations stop competing uploads and are released after failure', async () => {
    const env = await t.envelope(); const oldQuota = t.config.quotaBytes;
    const used = await t.db.value('SELECT used_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT]);
    t.config.quotaBytes = used + env.bytes.length;
    const results = await Promise.all([t.request('POST', '/api/v1/files', { body: env.bytes }), t.request('POST', '/api/v1/files', { body: env.bytes })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 413]);
    assert.equal(await t.db.value('SELECT reserved_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT]), 0);
    t.config.quotaBytes = oldQuota;
});
test('anonymous Sends enforce expiry bounds, atomic download limits, and due deletion', async () => {
    const env = await t.envelope('a private Send', { lock: 'link' });
    assert.equal((await t.request('POST', '/api/v1/sends?expires_in=3599', { body: env.bytes })).status, 400);
    assert.equal((await t.request('POST', '/api/v1/sends?expires_in=2592001', { body: env.bytes })).status, 400);
    const item = await create(env, true, '&download_limit=1');
    const r = await Promise.all([t.request('GET', `/api/v1/sends/${item.id}/content`, { user: null }), t.request('GET', `/api/v1/sends/${item.id}/content`, { user: null })]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 410]);
    const good = r.find((x) => x.status === 200);
    assert.equal(new TextDecoder().decode(await locker.open(new Uint8Array(await good.arrayBuffer()), { key: env.linkKey })), 'a private Send');
    const row = await t.db.one('SELECT * FROM locker_items WHERE id=$1', [item.id]);
    assert.ok(!JSON.stringify(row).includes(env.linkKey));
    t.advance(3600001);
    assert.equal((await t.request('GET', `/api/v1/sends/${item.id}/content`, { user: null })).status, 410);
    await t.service.sweep(); assert.ok(t.deleted.includes(row.media_id)); assert.ok(!t.blobs.has(row.media_id));
});
test('reports work without a Send account, only Network staff can disable and restrict', async () => {
    const item = await create(await t.envelope('report me', { lock: 'link' }), true);
    const headers = { Origin: t.base, 'X-Requested-With': 'locker' };
    assert.equal((await t.request('POST', `/api/v1/sends/${item.id}/report`, { user: null, json: { reason: 'abuse' }, headers })).status, 202);
    assert.equal((await t.request('POST', `/api/v1/staff/items/${item.id}/disable`)).status, 403);
    assert.equal((await t.request('POST', `/api/v1/staff/items/${item.id}/disable`, { user: STAFF })).status, 200);
    assert.equal((await t.request('GET', `/api/v1/sends/${item.id}/content`, { user: null })).status, 404);
    assert.equal((await t.request('GET', '/api/v1/staff/reports', { user: STAFF })).status, 200);
});
test('folders, ciphertext rename with revision and deletion maintain quota', async () => {
    const folder = await create(await t.envelope('folder'), false, '?kind=folder');
    const item = await create(await t.envelope('first name'), false, `?parent=${folder.id}`);
    const next = await t.envelope('renamed privately');
    const r = await t.request('PUT', `/api/v1/files/${item.id}`, { body: next.bytes, headers: { 'If-Match': '"1"' } }); assert.equal(r.status, 200, await r.text());
    assert.equal((await t.request('PUT', `/api/v1/files/${item.id}`, { body: next.bytes, headers: { 'If-Match': '"1"' } })).status, 412);
    assert.equal((await t.request('DELETE', `/api/v1/files/${folder.id}`)).status, 204);
    assert.equal(await t.db.value('SELECT parent FROM locker_items WHERE id=$1', [item.id]), null);
});
test('CSRF rejects foreign writes, rate limits Send creation', async () => {
    assert.equal((await t.request('POST', '/api/v1/sends', { user: null, headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
    const previous = t.config.sendsPerHour; t.config.sendsPerHour = 1;
    t.advance(3600001); const env = await t.envelope('limited', { lock: 'link' });
    await create(env, true);
    assert.equal((await t.request('POST', '/api/v1/sends?expires_in=3600', { body: env.bytes })).status, 429);
    t.config.sendsPerHour = previous;
});
test('same-origin key proxies use the authenticated user, without third-party cookies', async () => {
    const keys = await locker.exportPersonKeys(t.people.get(SUBJECT));
    const backup = await locker.seal('wrapped private key export', { lock: 'password', password: 'a local test passphrase' });
    const body = { ecdh_public: keys.ecdh, signing_public: keys.signing, fingerprint: keys.fingerprint,
        self_signature: keys.fingerprint_signature, backups: { passphrase: { format: 'locker.envelope.v1', envelope: Buffer.from(backup.bytes).toString('base64') } } };
    assert.equal((await t.request('PUT', '/api/v1/me/keys', { json: body })).status, 200);
    const own = await (await t.request('GET', '/api/v1/me/keys/backup')).json();
    assert.equal(own.subject, SUBJECT); assert.deepEqual(own.backups, body.backups);
    assert.deepEqual((await (await t.request('GET', '/api/v1/me/keys/backup', { user: OTHER })).json()).backups, {});
    assert.equal((await t.request('GET', '/api/v1/me/keys/backup', { user: null })).status, 401);
    assert.deepEqual((await (await t.request('GET', `/api/v1/people/${OTHER}/keys`)).json()).ecdh_public, (await locker.exportPersonKeys(t.people.get(OTHER))).ecdh);
});
test('ADR-033 export contains opaque items; deletion denies access, queues bytes and is idempotent', async () => {
    const item = await create(await t.envelope('account deletion'));
    const before = await t.accountData.exportPart(SUBJECT);
    assert.ok(before.files.find((x) => x.name === 'items.json').content.some((x) => x.id === item.id));
    assert.ok(!JSON.stringify(before).includes('account deletion'));
    const pending = await t.service.reserve({ subject_id: SUBJECT }, 100, 'file');
    const fs = require('node:fs/promises');
    await fs.mkdir(require('node:path').dirname(pending.file), { recursive: true });
    await fs.writeFile(pending.file, 'ciphertext awaiting transfer');
    const gone = await t.accountData.erase([SUBJECT]); assert.ok(gone.erased.items > 0);
    assert.equal((await t.request('GET', `/api/v1/files/${item.id}/content`)).status, 404);
    await t.accountData.erase([SUBJECT]); await t.service.sweep();
    assert.equal(await t.db.value('SELECT used_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT]), 0);
    await assert.rejects(fs.access(pending.file));
    assert.equal(await t.db.value('SELECT reserved_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT]), 0);
    assert.equal(await t.db.value('SELECT count(*) FROM locker_uploads WHERE owner=$1', [SUBJECT]), 0);
    assert.equal((await t.request('POST', '/api/v1/files', { body: (await t.envelope()).bytes })).status, 403);
});
