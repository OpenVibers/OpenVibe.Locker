'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, normalizeOrigin, breachRange, totp } = require('../public/js/passwords');

test('CSV parser preserves quoted commas, doubled quotes and newlines', () => {
    assert.deepEqual(parseCsv('url,username,password,notes\r\nhttps://example.com,"a,b",secret,"line 1\nline 2"\r\n'), [
        ['url', 'username', 'password', 'notes'], ['https://example.com', 'a,b', 'secret', 'line 1\nline 2'],
    ]);
    assert.deepEqual(parseCsv('site,password\n"https://example.com","a""b"'), [['site', 'password'], ['https://example.com', 'a"b']]);
    assert.throws(() => parseCsv('site,password\n"open'), /unclosed/);
});

test('site scope is reduced to a credential-free exact origin', () => {
    assert.equal(normalizeOrigin('https://example.com/login?q=x'), 'https://example.com');
    assert.throws(() => normalizeOrigin('https://user:pass@example.com'), /valid website/);
    assert.throws(() => normalizeOrigin('javascript:alert(1)'), /valid website/);
});

test('TOTP matches RFC 6238 SHA-1 test vector', async () => {
    assert.equal(await totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('breach lookup exposes only the five-character SHA-1 prefix', async () => {
    const { prefix, suffix } = await breachRange('password');
    assert.equal(prefix, '5BAA6'); assert.equal(prefix.length, 5); assert.equal(suffix.length, 35);
});
