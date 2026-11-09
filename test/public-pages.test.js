'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 11-09: every signed-out visit to the home page logged "401" from GET /api/v1/me in the visitor's console. Public pages
// now ask /auth/me first (200 with user null for a visitor) and stop there; a failed check still tries the API.
test('public pages ask the session before the account API', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const at = js.indexOf("me = await api('/api/v1/me'); window.OpenVibeLockerConfig.subject");
    assert.ok(at > 0, 'the account call is there');
    const before = js.slice(Math.max(0, at - 700), at);
    assert.match(before, /\['send', 'docs', 'home'\]\.includes\(page\.mode\)/);
    assert.match(before, /fetch\('\/auth\/me'/);
    assert.match(before, /if \(who && who\.user === null\) return;/, 'only an explicit "nobody" skips the account call');
});
