'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright')); }
const { boot, SUBJECT, OTHER, locker } = require('./helpers');
(async () => {
    const t = await boot({ config: { networkUrl: 'https://openvibe.network' } });
    const out = path.resolve('artifacts'); await fs.mkdir(out, { recursive: true });
    const options = { headless: true };
    try { await fs.access('/usr/bin/google-chrome'); options.executablePath = '/usr/bin/google-chrome'; } catch { /* bundled Chromium in CI */ }
    const browser = await chromium.launch(options);
    const passphrase = 'violet lantern river cobalt';
    const privateKeys = await locker.exportPrivateKeys(t.people.get(SUBJECT));
    const backup = await locker.seal(JSON.stringify(privateKeys), { lock: 'password', password: passphrase });
    t.network.backups.set(SUBJECT, { passphrase: { envelope: Buffer.from(backup.bytes).toString('base64'), format: 'locker.envelope.v1' } });
    const pub = await locker.exportPersonKeys(t.people.get(SUBJECT));
    const errors = [], badRequests = [], traffic = [];
    async function pageFor(width, scheme, signed = false) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme,
            deviceScaleFactor: 1, ...(signed ? { extraHTTPHeaders: { Authorization: `Bearer ${SUBJECT}` } } : {}) });
        await context.addInitScript((mode) => { document.cookie = `ov_theme_id=${mode === "light" ? "cloud" : "vibe"};path=/`; }, scheme);
        await context.route('https://openvibe.network/**', async (route) => {
            const url = new URL(route.request().url());
            const request = route.request();
            let json = {};
            if (url.pathname.endsWith('/keys/backup')) json = { subject: SUBJECT, backups: { passphrase: { envelope: Buffer.from(backup.bytes).toString('base64'), format: 'locker.envelope.v1' } } };
            else if (url.pathname.endsWith('/keys')) { const subject = url.pathname.includes(OTHER) ? OTHER : SUBJECT; const keys = await locker.exportPersonKeys(t.people.get(subject)); json = { subject, ecdh_public: keys.ecdh, signing_public: keys.signing, fingerprint: keys.fingerprint }; }
            else if (url.pathname.includes('me') || url.pathname.includes('session')) json = { user: null };
            const type = request.resourceType();
            await route.fulfill({ status: 200, contentType: type === 'script' ? 'application/javascript' : 'application/json', body: type === 'script' ? '' : JSON.stringify(json),
                headers: { 'Access-Control-Allow-Origin': t.base, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'authorization,content-type,x-requested-with' } });
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
        page.on('request', (r) => {
            traffic.push(r.url() + '\n' + (r.postData() || '') + '\n' + (r.headers().referer || ''));
            if (r.url().startsWith(t.base) && /[?&]k=|#k=/.test(r.url())) badRequests.push(r.url());
        });
        return { page, context };
    }
    try {
        for (const width of (process.env.LOCKER_SKIP_SHOTS ? [] : [390, 1280])) for (const scheme of ['light', 'dark']) {
            const { page, context } = await pageFor(width, scheme);
            for (const route of ['/', '/drive', '/sends', '/recovery', '/docs']) {
                await page.goto(t.base + route, { waitUntil: 'networkidle' });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${route} ${width} ${scheme}: overflow`);
                const smallTargets = await page.locator('main button,main input,main select').evaluateAll((elements) => elements.filter((e) => e.getAttribute('aria-hidden') !== 'true' && e.getBoundingClientRect().height && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 90)));
                assert.deepEqual(smallTargets, [], 'touch controls are at least 44px');
                await page.screenshot({ animations: 'disabled', timeout: 60000, path: path.join(out, `${route === '/' ? 'home' : route.slice(1)}-${width}-${scheme}.png`), fullPage: true });
            }
            await context.close();
        }
        const { page, context } = await pageFor(1280, 'light', true);
        await page.goto(`${t.base}/drive`, { waitUntil: 'networkidle' });
        await page.locator('[data-action=unlock]').click();
        await page.locator('[data-k=pass]').fill(passphrase); await page.locator('[data-k=unlock]').click();
        await page.waitForFunction(() => OVLocker.state().unlocked);
        const content = Buffer.alloc(2 * 1048576 + 57, 77);
        await page.locator('#upload-form input[type=file]').setInputFiles({ name: 'browser-private.txt', mimeType: 'text/plain', buffer: content });
        await page.locator('#upload-form button.primary').click();
        await page.waitForFunction(() => document.querySelector('#notice.error')?.textContent || [...document.querySelectorAll('main a')].some(a => a.textContent === 'browser-private.txt'), { timeout: 60000 });
        assert.equal(await page.locator('#notice').textContent(), '', 'upload error');
        await page.getByRole('link', { name: 'browser-private.txt', exact: true }).waitFor({ timeout: 5000 });
        console.log('Browser worker upload passed.');
        const response = await t.request('GET', '/api/v1/files'); const { items } = await response.json(); assert.equal(items.length, 1);
        const encrypted = new Uint8Array(await (await t.request('GET', `/api/v1/files/${items[0].id}/content`)).arrayBuffer());
        const plain = await locker.open(encrypted, { person: t.people.get(SUBJECT) });
        assert.ok(Buffer.from(plain).includes(content));
        assert.ok(!JSON.stringify(await t.db.many('SELECT * FROM locker_items')).includes('browser-private.txt'));
        await page.goto(`${t.base}/files/${items[0].id}`, { waitUntil: 'networkidle' });
        await page.locator('[data-action=unlock]').click(); await page.locator('[data-k=pass]').fill(passphrase); await page.locator('[data-k=unlock]').click();
        await page.waitForFunction(() => OVLocker.state().unlocked);
        const saved = page.waitForEvent('download'); await page.locator('[data-action=download]').click();
        const download = await saved; const file = await download.path(); assert.deepEqual(await fs.readFile(file), content);
        console.log('Browser download passed.');
        await page.locator('#rename-form input').fill('renamed-privately.txt'); await page.locator('#rename-form button').click();
        await page.waitForFunction(() => document.querySelector('#file-name').textContent === 'renamed-privately.txt');
        console.log('Browser encrypted rename passed.');
        await page.locator('[data-action=share]').click();
        await page.locator('[data-k=add]').fill('friend'); await page.locator('[data-k=add-btn]').click();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.ov-share-note')?.textContent === 'Saved.' || document.querySelector('.ov-share-error')?.textContent, { timeout: 60000 });
        assert.equal((await t.request('GET', `/api/v1/files/${items[0].id}/content`, { user: OTHER })).status, 200, 'the real Share sheet saved its staged envelope receipt');
        const sharedBytes = new Uint8Array(await (await t.request('GET', `/api/v1/files/${items[0].id}/content`, { user: OTHER })).arrayBuffer());
        assert.ok(Buffer.from(await locker.open(sharedBytes, { person: t.people.get(OTHER) })).includes(content));
        console.log('Browser sharing passed.');
        await page.goto(`${t.base}/sends`, { waitUntil: 'networkidle' });
        await page.locator('#send-form textarea').fill('A browser round trip that stays private.');
        await page.locator('#send-form button.primary').click();
        await page.locator('#send-result input').waitFor({ timeout: 60000 }); const link = await page.locator('#send-result input').inputValue(); assert.match(link, /#k=[A-Za-z0-9_-]{43}$/);
        const anonymous = await pageFor(390, 'dark');
        await anonymous.page.goto(link, { waitUntil: 'networkidle' });
        await anonymous.page.locator('[data-action=open-send]').click();
        await anonymous.page.locator('#opened pre').waitFor({ timeout: 60000 });
        assert.equal(await anonymous.page.locator('#opened pre').textContent(), 'A browser round trip that stays private.');
        assert.deepEqual(badRequests, [], 'link keys never occur in HTTP requests');
        const linkKey = new URL(link).hash.slice(3);
        assert.equal(traffic.some((request) => request.includes(linkKey)), false, 'no request URL, body or referrer to any origin contains the link key');
        await anonymous.context.close(); await context.close();
        assert.deepEqual(errors, [], 'no browser exceptions or CSP refusals');
        console.log(`Browser: ${process.env.LOCKER_SKIP_SHOTS ? 'existing' : '20 local'} screenshots, no overflow/CSP errors; real worker upload, download, rename, sharing and anonymous Send round trips.`);
    } finally { await browser.close(); await t.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
