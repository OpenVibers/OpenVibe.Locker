'use strict';
importScripts('/shared/ov-locker-core.js', '/js/payload.js');
let rootDir, handle, name;
self.onmessage = async ({ data }) => {
    if (data.type === 'release') {
        if (rootDir && name) await rootDir.removeEntry(name).catch(() => {});
        self.close(); return;
    }
    try {
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
        self.postMessage({ type: 'sealed', file, key: contentKey || null });
    } catch (e) {
        if (rootDir && name) await rootDir.removeEntry(name).catch(() => {});
        self.postMessage({ type: 'error', message: e.message });
    }
};
