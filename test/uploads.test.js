'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { boot, SUBJECT, OTHER, locker } = require('./helpers');
const { PART_SIZE, SINGLE_LIMIT } = require('../server/uploads');
let t;
before(async () => { t = await boot({ config: { quotaBytes: 512 * 1024 ** 2, uploadsPerHour: 200 } }); });
after(async () => { await t.close(); });
async function start(bytes, options = {}, headers = {}) {
    const r = await t.request('POST', '/api/v1/uploads', { json: { kind: 'file', bytes, ...options }, headers });
    assert.equal(r.status, 201, await r.clone().text()); return r.json();
}
async function put(id, n, bytes) { return t.request('PUT', `/api/v1/uploads/${id}/parts/${n}`, { body: bytes }); }
async function complete(id, headers = {}) { return t.request('POST', `/api/v1/uploads/${id}/complete`, { headers }); }
async function small(options = {}, headers = {}) {
    const { bytes } = await t.envelope(); const u = await start(bytes.length, options, headers);
    assert.equal((await put(u.id, 0, bytes)).status, 200); return u;
}
test('three 32 MiB parts resume from durable receipts and complete exactly once', async () => {
    assert.equal(PART_SIZE, 33554432);
    const plain = new Uint8Array(2 * PART_SIZE + 7).fill(93);
    const { bytes } = await t.envelope(plain);
    const u = await start(bytes.length); assert.equal(u.part_size, PART_SIZE);
    assert.equal(Math.ceil(bytes.length / PART_SIZE), 3);
    assert.equal((await put(u.id, 0, bytes.subarray(0, PART_SIZE))).status, 200);
    assert.equal((await complete(u.id)).status, 409, 'missing parts cannot complete');
    const state = await (await t.request('GET', `/api/v1/uploads/${u.id}`)).json();
    assert.deepEqual(state.received_parts, [0]);
    assert.equal((await t.request('GET', `/api/v1/uploads/${u.id}`, { user: OTHER })).status, 404);
    assert.equal((await t.request('PUT', `/api/v1/uploads/${u.id}/parts/1`, { user: OTHER, body: bytes.subarray(PART_SIZE, 2 * PART_SIZE) })).status, 404);
    assert.equal((await t.request('POST', `/api/v1/uploads/${u.id}/complete`, { user: OTHER })).status, 404);
    assert.equal((await put(u.id, 0, bytes.subarray(0, PART_SIZE))).status, 200, 'lost part response can retry');
    assert.equal((await put(u.id, 2, bytes.subarray(2 * PART_SIZE))).status, 200, 'out of order parts');
    assert.equal((await put(u.id, 1, bytes.subarray(PART_SIZE, 2 * PART_SIZE))).status, 200);
    const response = await complete(u.id); assert.equal(response.status, 200, await response.clone().text());
    const item = await response.json();
    assert.deepEqual(await (await complete(u.id)).json(), item, 'lost completion response returns original item');
    assert.equal((await (await t.request('GET', `/api/v1/uploads/${u.id}`)).json()).state, 'complete');
    const downloaded = new Uint8Array(await (await t.request('GET', `/api/v1/files/${item.id}/content`)).arrayBuffer());
    assert.deepEqual(await locker.open(downloaded, { person: t.people.get(SUBJECT) }), plain);
    const a = await t.db.one('SELECT * FROM locker_accounts WHERE subject=$1', [SUBJECT]);
    assert.equal(a.reserved_bytes, 0); assert.equal(a.used_bytes, bytes.length);
    await t.request('DELETE', `/api/v1/files/${item.id}`); await t.service.sweep();
});
test('counts streamed parts, refuses oversized, short and out-of-range parts without receipts', async () => {
    const u = await start(PART_SIZE + 9);
    assert.equal((await put(u.id, 0, new Uint8Array(PART_SIZE + 1))).status, 413);
    assert.equal((await put(u.id, 0, new Uint8Array(9))).status, 400);
    assert.equal((await put(u.id, 2, new Uint8Array(9))).status, 400);
    // Chunked HTTP has no Content-Length: the stream counter must enforce the final part bound too.
    const status = await new Promise((resolve, reject) => {
        const req = http.request(`${t.base}/api/v1/uploads/${u.id}/parts/1`, { method: 'PUT', headers: {
            Authorization: `Bearer ${SUBJECT}`, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked',
        } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.write(Buffer.alloc(10)); req.end();
    });
    assert.equal(status, 413);
    assert.deepEqual((await (await t.request('GET', `/api/v1/uploads/${u.id}`)).json()).received_parts, []);
    assert.equal((await complete(u.id)).status, 409);
});
test('abandoned sessions release quota and remove staging files; progress renews the deadline', async () => {
    const u = await small();
    const file = path.join(t.config.dataDir, 'uploads', `${u.id}.ovlk`);
    await fs.access(file);
    t.advance(3600001); await t.service.sweep();
    assert.equal((await t.db.one('SELECT reserved_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT])).reserved_bytes, 0);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    assert.equal((await t.request('GET', `/api/v1/uploads/${u.id}`)).status, 404);
    const next = await start(PART_SIZE + 8);
    t.advance(3500000); assert.equal((await put(next.id, 1, new Uint8Array(8))).status, 200);
    t.advance(100001); await t.service.sweep();
    assert.equal((await t.request('GET', `/api/v1/uploads/${next.id}`)).status, 200);
    t.advance(3600001); await t.service.sweep();
});
test('completion enforces envelope, recipient and standing checks, and reserves quota at initiation', async () => {
    const bad = await start(8); await put(bad.id, 0, Buffer.from('not-lock'));
    assert.equal((await complete(bad.id)).status, 400);
    const wrong = await t.envelope('private', { owner: OTHER });
    const u = await start(wrong.bytes.length); await put(u.id, 0, wrong.bytes);
    assert.equal((await complete(u.id)).status, 400);
    const waiting = await small(); t.principals.set(SUBJECT, { banned: true });
    assert.equal((await complete(waiting.id)).status, 403);
    assert.equal((await t.request('POST', '/api/v1/uploads', { json: { kind: 'file', bytes: 8 } })).status, 403);
    t.principals.delete(SUBJECT);
    const oldQuota = t.config.quotaBytes; t.config.quotaBytes = 8;
    assert.equal((await t.request('POST', '/api/v1/uploads', { json: { kind: 'file', bytes: 8 } })).status, 413);
    t.config.quotaBytes = oldQuota;
    t.advance(3600001); await t.service.sweep();
});
test('resumable replacement and reseal bind the item revision and keep receipt semantics', async () => {
    const original = await small(); const item = await (await complete(original.id)).json();
    const headers = { 'If-Match': '"1"' };
    const replacement = await small({ kind: 'replace', item_id: item.id }, headers);
    assert.equal((await complete(replacement.id)).status, 412);
    const replaced = await (await complete(replacement.id, headers)).json(); assert.equal(replaced.revision, 2);
    const reseal = await small({ kind: 'reseal', item_id: item.id }, { 'If-Match': '"2"' });
    const staged = await (await complete(reseal.id, { 'If-Match': '"2"' })).json();
    assert.equal(staged.envelope_ref, reseal.id); assert.equal(staged.header.lock, 'people');
    assert.deepEqual(await (await complete(reseal.id, { 'If-Match': '"2"' })).json(), staged);
    const result = await t.request('PUT', `/api/v1/files/${item.id}/share`, { json: { envelope_ref: reseal.id, members: [] } });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await t.db.one('SELECT reserved_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT])).reserved_bytes, 0);
});
test('single-request uploads reject envelopes above 90 MiB before reading the body', async () => {
    const status = await new Promise((resolve, reject) => {
        const req = http.request(`${t.base}/api/v1/files`, { method: 'POST', headers: {
            Authorization: `Bearer ${SUBJECT}`, 'Content-Type': 'application/octet-stream', 'Content-Length': SINGLE_LIMIT + 1,
        } }, (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); }); });
        req.on('error', reject); req.flushHeaders();
    });
    assert.equal(status, 413);
});
