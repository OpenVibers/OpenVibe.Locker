'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, SUBJECT, OTHER, locker } = require('./helpers');
test('a large staged reseal changes ciphertext and people access together; removal rotates the key', async () => {
    const t = await boot({ config: { quotaBytes: 60 * 1024 ** 2 } });
    try {
        const original = await t.envelope(new Uint8Array(9 * 1024 ** 2));
        const created = await t.request('POST', '/api/v1/files', { body: original.bytes }); assert.equal(created.status, 201);
        const item = await created.json(); const path = `/api/v1/files/${item.id}`;
        const shared = await locker.rewrap(original.bytes, { credentials: { person: t.people.get(SUBJECT) }, add: [{ subject: { type: 'user', id: OTHER }, publicKey: t.people.get(OTHER).ecdhPublic }] });
        t.config.quotaBytes = original.bytes.length + shared.bytes.length;
        let stage = await t.request('POST', `${path}/reseals`, { body: shared.bytes, headers: { 'If-Match': '"1"' } }); assert.equal(stage.status, 201, await stage.clone().text());
        const receipt = await stage.json();
        assert.equal((await t.request('POST', `${path}/reseals`, { body: shared.bytes, headers: { 'If-Match': '"1"' } })).status, 413, 'uncommitted replacements reserve their full stored size');
        assert.equal(await t.db.value('SELECT reserved_bytes FROM locker_accounts WHERE subject=$1', [SUBJECT]), shared.bytes.length);
        assert.equal((await t.request('GET', `${path}/content`, { user: OTHER })).status, 404);
        const members = [{ subject: { type: 'user', id: OTHER }, role: 'viewer', key_slot: shared.header.slots.people[1] }];
        let save = await t.request('PUT', `${path}/share`, { json: { members, envelope_ref: receipt.envelope_ref } }); assert.equal(save.status, 200, await save.clone().text());
        let fetched = await t.request('GET', `${path}/content`, { user: OTHER }); assert.equal(fetched.status, 200);
        assert.equal((await locker.open(new Uint8Array(await fetched.arrayBuffer()), { person: t.people.get(OTHER) })).length, 9 * 1024 ** 2);
        assert.equal((await t.request('PUT', `${path}/share`, { json: { members, envelope_ref: receipt.envelope_ref } })).status, 409, 'a receipt is consumed once');
        const fresh = await locker.rewrap(shared.bytes, { credentials: { person: t.people.get(SUBJECT) }, remove: [{ type: 'user', id: OTHER }], keys: [{ subject: { type: 'user', id: SUBJECT }, publicKey: t.people.get(SUBJECT).ecdhPublic }] });
        stage = await t.request('POST', `${path}/reseals`, { body: fresh.bytes, headers: { 'If-Match': '"2"' } }); assert.equal(stage.status, 201);
        save = await t.request('PUT', `${path}/share`, { json: { members: [], envelope_ref: (await stage.json()).envelope_ref } }); assert.equal(save.status, 200, await save.clone().text());
        assert.equal((await t.request('GET', `${path}/content`, { user: OTHER })).status, 404);
        fetched = await t.request('GET', `${path}/content`);
        await assert.rejects(() => locker.open(new Uint8Array(fresh.bytes), { person: t.people.get(OTHER) }), (e) => e.code === 'locker.no_slot');
        await fetched.arrayBuffer(); await t.service.sweep();
        assert.equal(t.blobs.size, 1, 'replaced encrypted objects are collected');
    } finally { await t.close(); }
});
