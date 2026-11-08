(async function () {
    'use strict';
    const page = window.LockerPage;
    const L = window.OVLocker;
    const $ = (s) => document.querySelector(s);
    const make = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
    const notice = (message, bad = false) => { $('#notice').textContent = message || ''; $('#notice').classList.toggle('error', bad); };
    const progress = (message) => { if ($('#progress')) $('#progress').textContent = message; };
    const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
    const action = (text, fn) => { const b = make('button', text); b.type = 'button'; b.addEventListener('click', () => run(b, fn)); return b; };
    let me = null, items = [], currentFolder = new URL(location.href).searchParams.get('folder') || '', fileInfo;
    const names = new Map();
    async function api(url, options = {}) {
        const r = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'X-Requested-With': 'locker', ...(options.headers || {}) } });
        if (!r.ok) { const body = await r.json().catch(() => ({})); throw Object.assign(new Error(body.detail || body.error || `Request failed (${r.status}).`), { status: r.status }); }
        return r.status === 204 ? null : r.json();
    }
    async function run(control, fn) {
        control.disabled = true; notice('');
        try { await fn(); } catch (e) { if (e.name !== 'AbortError') notice(e.message, true); }
        finally { control.disabled = false; }
    }
    function signedIn() { if (!me) throw new Error('Sign in to OpenVibe to use your locker.'); }
    function uploadsAllowed() { signedIn(); if (!me.eligible) throw new Error(me.reason); }
    function state() {
        const unlocked = L.state().unlocked;
        if ($('#lock-state')) $('#lock-state').textContent = unlocked ? 'Your locker is unlocked' : 'Your locker is locked';
        if ($('#fingerprint')) $('#fingerprint').textContent = unlocked ? L.state().fingerprint : 'Unlock to open your files. Your keys stay here.';
        document.querySelectorAll('[data-action=lock]').forEach((b) => { b.disabled = !unlocked; });
    }
    async function ownKeys() {
        signedIn(); await L.ensure();
        const keys = await L.publicKeys();
        return [{ subject: { type: 'user', id: me.subject }, publicKey: keys.ecdh }];
    }
    async function recipients(header) {
        const keys = await ownKeys();
        for (const slot of header.slots.people) {
            if (slot.subject.id === me.subject) continue;
            const k = await L.keys(slot.subject);
            if (!k) throw new Error('Someone on this file’s list no longer has a locker. Update its sharing list first.');
            keys.push({ subject: slot.subject, publicKey: k.ecdh_public || k.ecdh });
        }
        return keys;
    }
    async function sealed(data) {
        const worker = new Worker('/js/seal-worker.js');
        const result = await new Promise((resolve, reject) => {
            worker.onerror = () => { worker.terminate(); reject(new Error('The file worker could not finish.')); };
            worker.onmessage = ({ data: out }) => {
                if (out.type === 'progress') progress(`Locking on this device · ${size(out.bytes)}`);
                if (out.type === 'error') { worker.terminate(); reject(new Error(out.message)); }
                if (out.type === 'sealed') resolve(out);
            };
            worker.postMessage(data, data.stream ? [data.stream] : []);
        });
        return { ...result,
            upload(options, revision) {
                return new Promise((resolve, reject) => {
                    worker.onerror = () => reject(new Error('The upload worker could not finish.'));
                    worker.onmessage = ({ data: out }) => {
                        if (out.type === 'upload-progress') progress(`Uploading encrypted bytes · ${size(out.bytes)}`);
                        if (out.type === 'retry') progress('Connection interrupted. Resuming encrypted upload…');
                        if (out.type === 'error') reject(new Error(out.message));
                        if (out.type === 'uploaded') resolve(out.result);
                    };
                    worker.postMessage({ type: 'upload', options, revision });
                });
            },
            release() { worker.postMessage({ type: 'release' }); },
        };
    }
    async function uploadFile(file, opts = {}) {
        uploadsAllowed();
        if (file.size > me.max_file_bytes) throw new Error(`Choose a file up to ${size(me.max_file_bytes)}.`);
        const send = opts.send;
        const meta = { name: file.name || opts.name || 'Private note', type: file.type || 'application/octet-stream', size: file.size, folder: !!opts.folder };
        const locked = await sealed({ file, meta, lock: send ? 'link' : 'people', keys: send ? undefined : await ownKeys() });
        try {
            progress('Uploading encrypted bytes…');
            const item = await locked.upload(send ? { kind: 'send', expires_in: Number(opts.expires),
                ...(opts.limit ? { download_limit: Number(opts.limit) } : {}) }
                : { kind: opts.login ? 'login' : opts.folder ? 'folder' : 'file', ...(opts.parent ? { parent: opts.parent } : {}) });
            names.set(item.id, meta.name);
            progress('Saved. Only encrypted bytes left this device.');
            if (send) {
                const key = btoa(String.fromCharCode(...locked.key)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
                const url = `${location.origin}/s/${item.id}#k=${key}`;
                const box = $('#send-result'); box.replaceChildren(make('h3', 'Your private link'));
                const input = make('input'); input.value = url; input.readOnly = true; input.setAttribute('aria-label', 'Private Send link');
                box.append(input, action('Copy full link', async () => { await navigator.clipboard.writeText(url); notice('Link copied.'); }),
                    make('p', 'Keep the full link now. We cannot recover its key for you.'));
            }
            await refresh();
        } finally { locked.release(); }
    }
    async function openFile(id, send = false) {
        const key = send ? L.keyFromLink() : null;
        if (send && !key) throw new Error('This link is missing its key. Ask the sender for the complete link, including the part after #.');
        if (!send) await L.ensure();
        const r = await fetch(`/api/v1/${send ? 'sends' : 'files'}/${id}/content`, { credentials: 'same-origin' });
        if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.detail || 'The locked item could not be opened.'); }
        return LockerPayload.unpack(await L.openStream(r.body, send ? { key } : undefined));
    }
    async function fileName(id) {
        const opened = await openFile(id);
        await opened.stream.cancel(); // Only the first authenticated chunk is needed for this encrypted label.
        return opened.meta;
    }
    async function download(send) {
        const info = await api(`/api/v1/${send ? 'sends' : 'files'}/${page.id}`);
        if (send && !L.keyFromLink()) throw new Error('The full link needs its key after #. Ask the sender for the complete link.');
        let handle;
        // Pick the destination before consuming a limited Send. The atomic writable is committed only after final verification.
        if (info.envelope_bytes > 32 * 1024 ** 2) {
            if (!window.showSaveFilePicker) throw new Error('For files over 32 MiB, open this page in a browser that supports saving a streamed file.');
            handle = await showSaveFilePicker({ suggestedName: names.get(page.id) || 'private-file' });
        }
        const { meta, stream } = await openFile(page.id, send);
        progress('Opening and checking this file on your device…');
        if (handle) {
            const writer = await handle.createWritable();
            try { await stream.pipeTo(writer); } catch (e) { await writer.abort().catch(() => {}); throw e; }
        } else {
            const reader = stream.getReader(); const chunks = []; let count = 0;
            for (;;) { const p = await reader.read(); if (p.done) break; count += p.value.length; if (count > 32 * 1024 ** 2) { await reader.cancel(); throw new Error('Use a browser with streamed file saving for this file.'); } chunks.push(p.value); }
            const blob = new Blob(chunks, { type: meta.type });
            if (meta.type === 'text/plain' && meta.size <= 1024 ** 2 && send) {
                const pre = make('pre', await blob.text()); $('#opened').replaceChildren(pre);
            }
            if (!meta.folder) {
                const url = URL.createObjectURL(blob); const a = make('a', `Save ${meta.name}`); a.className = 'button'; a.href = url; a.download = meta.name;
                $('#opened').append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.removeAttribute('href'); }, 120000);
            }
        }
        if ($('#file-name')) $('#file-name').textContent = meta.name;
        $('#item-description').textContent = `${meta.name} · ${size(meta.size)} · Opened on this device`;
        progress('Verified and opened.');
    }
    function showStorage() {
        if ($('#account') && me) $('#account').textContent = `${size(me.used_bytes)} of ${size(me.quota_bytes)} used${me.reserved_bytes ? ` · ${size(me.reserved_bytes)} uploading` : ''} · Up to ${size(me.max_file_bytes)} per file${me.eligible ? '' : ` · ${me.reason}`}`;
    }
    async function refresh() {
        if (!me) return;
        if ($('#account')) { me = await api('/api/v1/me'); showStorage(); }
        if (page.mode === 'file') {
            fileInfo = await api(`/api/v1/files/${page.id}`);
            document.querySelectorAll('[data-owner-only]').forEach((e) => { e.hidden = !fileInfo.can_edit; });
            return;
        }
        if (!['drive', 'sends', 'shared', 'passwords'].includes(page.mode)) return;
        if (page.mode === 'shared') {
            const result = await api('/api/v1/shared-with-me');
            items = result.items.map((r) => ({ id: r.ref.id, kind: 'file' }));
        } else {
            const result = await api(`/api/v1/${page.mode === 'sends' ? 'sends' : 'files'}`);
            items = result.items;
            // Follow the cursor so a full Drive is not silently hidden after the first page.
            let cursor = result.next_cursor;
            while (cursor) {
                const more = await api(`/api/v1/${page.mode === 'sends' ? 'sends' : 'files'}?before=${encodeURIComponent(cursor)}`);
                items.push(...more.items); cursor = more.items.length === 100 ? more.next_cursor : null;
            }
        }
        if (page.mode === 'passwords') {
            items = items.filter((i) => i.kind === 'login');
            if (L.state().unlocked) for (const item of items) { try { await readLogin(item.id); } catch (e) { notice(`Could not open a saved login: ${e.message}`, true); } }
            return drawLogins();
        }
        drawItems();
        if (['drive', 'shared'].includes(page.mode) && L.state().unlocked) {
            for (const item of items) {
                if (item.disabled || names.has(item.id)) continue;
                try { const meta = await fileName(item.id); names.set(item.id, meta.name); } catch { /* A lost key leaves a locked label. */ }
            }
            drawItems();
        }
    }
    function drawItems() {
        const box = $('#items'); if (!box) return;
        box.replaceChildren();
        const visible = page.mode === 'drive' ? items.filter((i) => i.kind !== 'login' && (i.parent || '') === currentFolder) : items;
        if (!visible.length) box.append(make('p', page.mode === 'sends' ? 'No Sends yet. Create one above when you have something to share.' : 'No locked items here yet.', 'empty'));
        for (const item of visible) {
            const row = make('div', null, 'item-row'); const description = make('div');
            const label = names.get(item.id) || (item.kind === 'send' ? 'A private Send' : item.kind === 'folder' ? 'Locked folder' : 'Locked file');
            const link = make('a', label, 'title');
            link.href = item.kind === 'folder' ? `/drive?folder=${item.id}` : item.kind === 'send' ? `/s/${item.id}` : `/files/${item.id}`;
            description.append(link);
            const details = item.kind === 'send' ? `Expires ${new Date(item.expires_at).toLocaleString()} · ${item.downloads}${item.download_limit ? ` of ${item.download_limit}` : ''} downloads` : item.envelope_bytes ? `${size(item.envelope_bytes)} encrypted` : 'Shared with you';
            description.append(make('p', item.disabled ? 'Disabled by staff' : details));
            const actions = make('div', null, 'actions');
            if (page.mode !== 'shared') actions.append(action('Delete', async () => {
                if (!confirm(`Delete ${label}?${item.kind === 'folder' ? ' Its files will return to Drive.' : ''}`)) return;
                await api(`/api/v1/${item.kind === 'send' ? 'sends' : 'files'}/${item.id}`, { method: 'DELETE' }); await refresh();
            }));
            row.append(description, actions); box.append(row);
        }
        if ($('#upload-parent')) {
            $('#upload-parent').replaceChildren(new Option('Drive', ''));
            for (const item of items.filter((i) => i.kind === 'folder' && !i.disabled)) $('#upload-parent').append(new Option(names.get(item.id) || `Locked folder · ${item.id.slice(0, 8)}`, item.id));
            $('#upload-parent').value = currentFolder;
            const home = make('a', currentFolder ? '← Back to Drive' : 'Drive'); home.href = '/drive'; $('#folders').replaceChildren(home);
        }
    }
    const loginRecords = new Map();
    async function readBytes(stream) { const response = new Response(stream); return response.arrayBuffer(); }
    async function readLogin(id) {
        if (loginRecords.has(id)) return loginRecords.get(id);
        const opened = await openFile(id); const data = JSON.parse(new TextDecoder().decode(await readBytes(opened.stream)));
        if (!data || data.version !== 1 || typeof data.site !== 'string' || typeof data.password !== 'string') throw new Error('This encrypted login has invalid contents.');
        loginRecords.set(id, data); return data;
    }
    function drawLogins() {
        const box = $('#items'); if (!box) return; box.replaceChildren();
        if (!L.state().unlocked) { box.append(make('p', 'Unlock your locker to view saved logins.')); return; }
        const search = ($('#login-search')?.value || '').toLocaleLowerCase();
        for (const item of items) {
            const data = loginRecords.get(item.id); if (!data || !`${data.site} ${data.username} ${data.notes}`.toLocaleLowerCase().includes(search)) continue;
            const row = make('article', null, 'item-row login-row'); const url = new URL(data.site);
            const mark = make('span', url.hostname.replace(/^www\./, '').slice(0, 1).toUpperCase(), 'login-mark'); mark.setAttribute('aria-hidden', 'true');
            const body = make('div', null, 'login-body'); const buttons = make('div', null, 'actions');
            body.append(make('h3', url.hostname), make('p', data.username || 'No username'));
            row.append(mark, body, buttons);
            buttons.append(action('Edit', async () => { const form = $('#login-form'); for (const key of ['site', 'username', 'password', 'totp', 'notes']) form.elements[key].value = key === 'site' ? data.site : data[key] || ''; form.dataset.edit = item.id; form.querySelector('button.primary').textContent = 'Update encrypted login'; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
            buttons.append(action('Copy password', async () => { await navigator.clipboard.writeText(data.password); notice('Password copied.'); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000); }));
            if (data.totp) {
                let period = 30; try { period = LockerPasswords.totpParams(data.totp).period; } catch { /* shown as invalid below */ }
                const timer = make('p', 'Code · …', 'login-code'); timer.dataset.totp = data.totp; timer.dataset.period = period; body.append(timer);
                const bar = make('progress'); bar.max = period; bar.value = period - Math.floor(Date.now() / 1000) % period; bar.setAttribute('aria-label', 'Seconds until the next code'); body.append(bar);
                buttons.append(action('Copy code', async () => { await navigator.clipboard.writeText(await LockerPasswords.totp(data.totp)); notice('Code copied.'); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000); }));
            }
            buttons.append(action('Check breach', async () => {
                if (!window.confirm('Send only the first five characters of this password’s SHA-1 hash to Have I Been Pwned?')) return;
                const { prefix, suffix } = await LockerPasswords.breachRange(data.password);
                const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
                if (!response.ok) throw new Error('Breach check is temporarily unavailable.');
                const found = (await response.text()).split(/\r?\n/).some((line) => line.split(':')[0] === suffix);
                notice(found ? 'This password appears in known breach data. Change it on that site.' : 'No match found in the breach data checked.');
            }));
            buttons.append(action('Delete', async () => { if (!window.confirm(`Delete the saved login for ${url.hostname}? This cannot be undone.`)) return; await api(`/api/v1/files/${item.id}`, { method: 'DELETE' }); loginRecords.delete(item.id); await refresh(); }));
            if (data.notes) body.append(make('p', data.notes, 'login-notes')); box.append(row);
        }
        if (!box.children.length) box.append(make('p', 'No matching saved logins.', 'empty'));
    }
    async function updateTotp() {
        for (const el of document.querySelectorAll('[data-totp]')) {
            const period = Number(el.dataset.period) || 30, seconds = period - Math.floor(Date.now() / 1000) % period;
            const code = await LockerPasswords.totp(el.dataset.totp).catch(() => null);
            el.textContent = code ? `Code · ${code} · ${seconds}s` : 'Code · this two-factor secret is not valid';
            if (el.nextElementSibling?.tagName === 'PROGRESS') el.nextElementSibling.value = seconds;
        }
    }
    if (page.mode === 'passwords') setInterval(() => updateTotp().catch(() => {}), 1000);
    document.addEventListener('ov-locker:change', () => {
        state();
        if (L.state().unlocked) refresh().catch((e) => notice(e.message, true));
        else {
            names.clear(); loginRecords.clear(); if ($('#opened')) $('#opened').replaceChildren();
            if ($('#file-name')) $('#file-name').textContent = 'A locked file.';
            if ($('#item-description')) $('#item-description').textContent = 'Its name and content are encrypted.';
            $('#rename-form')?.reset(); if (page.mode === 'passwords') drawLogins(); else drawItems();
        }
    });
    if (page.mode === 'passwords') {
        let autoLockTimer;
        const resetAutoLock = () => {
            clearTimeout(autoLockTimer);
            if (L.state().unlocked) autoLockTimer = setTimeout(() => { L.forget(); notice('Locker locked after 15 minutes of inactivity.'); }, 15 * 60 * 1000);
        };
        for (const event of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(event, resetAutoLock, { passive: true });
        document.addEventListener('ov-locker:change', resetAutoLock);
        resetAutoLock();
    }
    document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
        if (b.dataset.action === 'setup') { signedIn(); await L.setup(); }
        if (b.dataset.action === 'unlock') { signedIn(); await L.ensure(); }
        if (b.dataset.action === 'lock') L.forget();
        if (b.dataset.action === 'download') await download(false);
        if (b.dataset.action === 'open-send') await download(true);
        if (b.dataset.action === 'share') {
            signedIn(); await L.ensure();
            await OVShare.open({ kind: 'files', id: page.id, url: `${location.origin}/files/${page.id}`, title: 'A locked item', envelope_url: `/api/v1/files/${page.id}/content`, headers: { 'X-Requested-With': 'locker' },
                prepareEnvelope: async ({ keys }) => {
                    const info = await api(`/api/v1/files/${page.id}`);
                    const opened = await openFile(page.id);
                    const encrypted = await sealed({ stream: opened.stream, meta: opened.meta, lock: 'people', keys });
                    try {
                        return await encrypted.upload({ kind: 'reseal', item_id: page.id }, info.revision);
                    } finally { encrypted.release(); }
                },
            });
        }
    })));
    function form(id, fn) {
        const f = $(id); if (!f) return;
        f.addEventListener('submit', (e) => { e.preventDefault(); run(e.submitter || f.querySelector('button.primary,button[type=submit]'), () => fn(new FormData(f), f)); });
    }
    form('#upload-form', async (data, f) => { const file = data.get('file'); if (!file?.name) throw new Error('Choose a file.'); await uploadFile(file, { parent: data.get('parent') }); f.reset(); });
    form('#login-form', async (data, f) => {
        uploadsAllowed(); await L.ensure(); const site = LockerPasswords.normalizeOrigin(data.get('site'));
        const record = { version: 1, site, username: data.get('username').trim(), password: data.get('password'), totp: data.get('totp').trim(), notes: data.get('notes').trim() };
        if (f.dataset.edit) {
            const id = f.dataset.edit, info = await api(`/api/v1/files/${id}`); const blob = new Blob([JSON.stringify(record)]);
            const encrypted = await sealed({ file: new File([blob], 'login.json', { type: 'application/json' }), meta: { name: 'login.json', type: 'application/json', size: blob.size }, lock: 'people', keys: await ownKeys() });
            try { await encrypted.upload({ kind: 'replace', item_id: id }, info.revision); } finally { encrypted.release(); }
            loginRecords.delete(id);
        } else await uploadFile(new File([JSON.stringify(record)], 'login.json', { type: 'application/json' }), { login: true });
        f.reset(); delete f.dataset.edit; f.querySelector('button.primary').textContent = 'Save encrypted login'; await refresh();
    });
    $('#login-search')?.addEventListener('input', drawLogins);
    document.querySelector('#generate-password')?.addEventListener('click', async (e) => run(e.currentTarget, async () => {
        const bytes = crypto.getRandomValues(new Uint8Array(24)); const password = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
        $('#login-form [name=password]').value = password;
    }));
    $('#login-import')?.addEventListener('change', (e) => { const input = e.currentTarget; run(input, async () => {
        const file = input.files[0]; if (!file) return;
        const rows = LockerPasswords.parseCsv(await file.text()); const headers = rows.shift().map((x) => x.toLowerCase());
        const col = (...names) => headers.findIndex((h) => names.includes(h));
        const siteCol = col('url', 'login_uri', 'website', 'hostname'), userCol = col('username', 'login_username'), passCol = col('password', 'login_password'), totpCol = col('totp', 'login_totp', 'otpauth', 'one-time password', 'one_time_password'), noteCol = col('notes', 'note', 'extra');
        if (siteCol < 0 || passCol < 0) throw new Error('CSV needs URL and password columns.');
        uploadsAllowed(); await L.ensure(); let saved = 0, skipped = 0;
        for (const row of rows) {
            const site = LockerPasswords.importOrigin(row[siteCol]);
            if (!site || !row[passCol]) { skipped++; continue; }
            const record = { version: 1, site, username: row[userCol] || '', password: row[passCol], totp: row[totpCol] || '', notes: row[noteCol] || '' };
            await uploadFile(new File([JSON.stringify(record)], 'login.json', { type: 'application/json' }), { login: true }); saved++;
        }
        notice(`Imported ${saved} encrypted ${saved === 1 ? 'login' : 'logins'}.${skipped ? ` Skipped ${skipped} ${skipped === 1 ? 'row' : 'rows'} without a website address and password.` : ''}`);
    }).finally(() => { input.value = ''; }); });
    form('#folder-form', async (data, f) => { const name = data.get('name').trim(); if (!name) throw new Error('Give the folder a name.'); await uploadFile(new File([], name), { folder: true, parent: currentFolder }); f.reset(); });
    form('#send-form', async (data, f) => {
        const file = data.get('file'), text = data.get('text');
        if (!!file?.name === !!text) throw new Error('Choose one file or write one note.');
        await uploadFile(file?.name ? file : new File([text], 'Private note.txt', { type: 'text/plain' }), { send: true, expires: data.get('expires'), limit: data.get('limit') }); f.reset();
    });
    form('#rename-form', async (data) => {
        uploadsAllowed(); fileInfo = await api(`/api/v1/files/${page.id}`);
        const keys = await recipients(fileInfo.header);
        const opened = await openFile(page.id);
        const name = data.get('name').trim(); if (!name) throw new Error('Give this item a name.');
        const encrypted = await sealed({ stream: opened.stream, meta: { ...opened.meta, name }, lock: 'people', keys });
        try {
            await encrypted.upload({ kind: 'replace', item_id: page.id }, fileInfo.revision);
            $('#file-name').textContent = name; progress('Renamed inside the lock.');
        } finally { encrypted.release(); }
    });
    form('#report-form', async (data) => { await api(`/api/v1/${page.mode === 'send' ? 'sends' : 'files'}/${page.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: data.get('reason') }) }); notice('Report received. Thank you.'); });
    state();
    try {
        me = await api('/api/v1/me'); window.OpenVibeLockerConfig.subject = me.subject;
        showStorage();
        await refresh();
        if (page.mode === 'staff') {
            const out = await api('/api/v1/staff/reports'); const box = $('#reports');
            if (!out.reports.length) box.append(make('p', 'No reports.'));
            for (const report of out.reports) {
                const row = make('div', null, 'item-row'); row.append(make('p', `${report.reason} · ${report.item_id} · ${report.owner}`));
                row.append(action('Disable item', () => api(`/api/v1/staff/items/${report.item_id}/disable`, { method: 'POST' })),
                    action('Restrict uploads', () => api(`/api/v1/staff/people/${report.owner}/restriction`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"restricted":true}' })));
                box.append(row);
            }
        }
    } catch (e) {
        if (e.status === 401 && !['send', 'docs', 'home'].includes(page.mode)) {
            const a = make('a', 'Sign in to OpenVibe'); a.href = `/auth/login?next=${encodeURIComponent(location.pathname)}`;
            $('#notice').replaceChildren(a);
        } else if (e.status !== 401) notice(e.message, true);
    }
})();
