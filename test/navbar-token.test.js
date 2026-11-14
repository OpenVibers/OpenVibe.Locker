'use strict';
// The shared navbar's token (the owner, 11-14: the menu's Alerts said "Your notifications are on your account" on
// Locker): Locker's session cookie is HTTP-only, so the navbar asks /auth/navbar-token, same-origin and never cached, and
// the page tells it where (tokenUrl). Signed out is 401; another site is refused.
const assert = require('node:assert/strict');
const { boot, SUBJECT } = require('./helpers');
(async () => {
    const t = await boot();
    try {
        const ok = await t.request('GET', '/auth/navbar-token', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { token: SUBJECT }, 'the verified session token');
        assert.match(ok.headers.get('cache-control') || '', /no-store/, 'never cached');
        assert.equal((await t.request('GET', '/auth/navbar-token', { user: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 401, 'signed out');
        assert.equal((await t.request('GET', '/auth/navbar-token', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'another site is refused');
        const page = await (await t.request('GET', '/', { user: null })).text();
        assert.ok(page.includes('"tokenUrl":"/auth/navbar-token"'), 'the page tells the navbar where');
    } finally { await t.close(); }
    console.log('navbar-token: ok');
})().catch((e) => { console.error(e); process.exit(1); });
