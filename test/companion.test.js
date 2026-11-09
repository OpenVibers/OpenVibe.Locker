'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, SUBJECT, OTHER } = require('./helpers');

test('Companion is owner-only, login-only, ciphertext-only and checks live Network scope', async () => {
    const ctx = await boot();
    try {
        const json = ctx.network.json.bind(ctx.network);
        let calls = 0, revoked = false;
        ctx.network.json = async (opts) => {
            if (opts.path !== '/api/v1/me/keys/companion') return json(opts);
            calls++;
            if (opts.token !== 'scoped-companion' || revoked) throw Object.assign(new Error('Missing scope or revoked'), { status: 403, code: 'insufficient_scope' });
            return { subject: SUBJECT, backups: { passphrase: { envelope: 'ciphertext' } } };
        };
        const ask = (method, path, opts = {}) => ctx.request(method, '/api/v1/companion' + path, { user: 'scoped-companion', ...opts });
        assert.equal((await ask('GET', '/keys', { user: null })).status, 401);
        assert.equal((await ask('GET', '/keys', { user: 'dock-only' })).status, 403);
        assert.equal((await (await ask('GET', '/keys')).json()).subject, SUBJECT);
        const sealed = await ctx.envelope('encrypted login');
        const save = await ask('POST', '/logins', { body: sealed.bytes });
        assert.equal(save.status, 201);
        const item = await save.json(); assert.equal(item.kind, 'login');
        const plain = await ask('POST', '/logins', { json: { password: 'must not be accepted' } });
        assert.equal(plain.status, 415);
        const file = await (await ctx.request('POST', '/api/v1/files', { body: sealed.bytes })).json();
        const otherSealed = await ctx.envelope('other', { owner: OTHER });
        const other = await (await ctx.request('POST', '/api/v1/files?kind=login', { user: OTHER, body: otherSealed.bytes })).json();
        const list = await (await ask('GET', '/logins')).json();
        assert.deepEqual(list.items.map((r) => r.id), [item.id]);
        assert.equal((await ask('GET', `/logins/${file.id}/content`)).status, 404);
        assert.equal((await ask('GET', `/logins/${other.id}/content`)).status, 404);
        assert.deepEqual(new Uint8Array(await (await ask('GET', `/logins/${item.id}/content`)).arrayBuffer()), sealed.bytes);
        assert.equal((await ctx.request('GET', '/api/v1/files', { user: 'scoped-companion' })).status, 401);
        revoked = true;
        assert.equal((await ask('GET', `/logins/${item.id}/content`)).status, 403);
        assert.ok(calls >= 8);
    } finally { await ctx.close(); }
});
