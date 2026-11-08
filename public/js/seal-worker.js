'use strict';
importScripts('/shared/ov-locker-core.js', '/js/payload.js');
let rootDir, handle, name, sealedFile;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options,
        headers: { 'X-Requested-With': 'locker', ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.detail || 'Upload failed.'), { status: response.status, code: data.code });
    return data;
}
async function retry(action) {
    for (let attempt = 0; ; attempt++) {
        try { return await action(); }
        catch (e) {
            if (attempt >= 7 || (e.status && e.status < 500 && e.status !== 429 && e.code !== 'locker.upload.busy')) throw e;
            self.postMessage({ type: 'retry' });
            await pause(Math.min(1000 * 2 ** attempt, 15000));
        }
    }
}
async function upload(options, revision) {
    if (!sealedFile) throw new Error('Lock the file before uploading.');
    const headers = revision ? { 'If-Match': `"${revision}"` } : {};
    // Do not retry session creation: a lost POST response must not reserve quota repeatedly.
    // Parts and completion are idempotent; their status survives connection drops and server restarts.
    const session = await request('/api/v1/uploads', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, bytes: sealedFile.size }) });
    const base = `/api/v1/uploads/${session.id}`;
    for (let n = 0; n < Math.ceil(sealedFile.size / session.part_size); n++) {
        await retry(async () => {
            const state = await request(base);
            if (state.state === 'complete' || state.received_parts.includes(n)) return;
            await request(`${base}/parts/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
                body: sealedFile.slice(n * session.part_size, Math.min((n + 1) * session.part_size, sealedFile.size), 'application/octet-stream') });
        });
        self.postMessage({ type: 'upload-progress', bytes: Math.min((n + 1) * session.part_size, sealedFile.size) });
    }
    return retry(() => request(`${base}/complete`, { method: 'POST', headers }));
}
self.onmessage = async ({ data }) => {
    if (data.type === 'release') {
        if (rootDir && name) await rootDir.removeEntry(name).catch(() => {});
        self.close(); return;
    }
    try {
        if (data.type === 'upload') {
            self.postMessage({ type: 'uploaded', result: await upload(data.options, data.revision) });
            return;
        }
        const { meta, keys, lock } = data;
        const source = data.stream || data.file.stream();
        const packed = LockerPayload.pack(meta, source);
        const size = LockerPayload.prefix(meta).length + meta.size;
        // Platform CSPRNG, used only to retain the link key returned to this browser. All sealing is SDK code.
        const contentKey = lock === 'link' ? crypto.getRandomValues(new Uint8Array(32)) : undefined;
        const stream = OVLockerCore.sealStream(packed, { lock, keys, size, contentKey });
        const parts = [];
        let writer, written = 0;
        if (navigator.storage?.getDirectory) {
            rootDir = await navigator.storage.getDirectory();
            name = `locker-${crypto.randomUUID()}.ovlk`;
            handle = await rootDir.getFileHandle(name, { create: true });
            writer = await handle.createWritable();
        } else if (size > 32 * 1024 ** 2) throw new Error('This browser can lock files up to 32 MiB. Use a browser with private file storage for larger files.');
        const reader = stream.getReader();
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                if (writer) await writer.write(part.value); else parts.push(part.value);
                written += part.value.length;
                self.postMessage({ type: 'progress', bytes: written });
            }
            if (writer) await writer.close();
        } catch (e) { if (writer) await writer.abort().catch(() => {}); throw e; }
        const file = handle ? await handle.getFile() : new Blob(parts, { type: 'application/octet-stream' });
        sealedFile = file;
        self.postMessage({ type: 'sealed', key: contentKey || null });
    } catch (e) {
        if (rootDir && name) await rootDir.removeEntry(name).catch(() => {});
        self.postMessage({ type: 'error', message: e.message });
    }
};
