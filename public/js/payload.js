/* The private file description is part of the plaintext given to the existing Locker SDK. */
(function (root) {
    'use strict';
    const encoder = new TextEncoder();
    function prefix(meta) {
        const json = encoder.encode(JSON.stringify({ version: 1, ...meta }));
        if (json.length > 65536) throw new Error('The file description is too long.');
        const bytes = new Uint8Array(4 + json.length);
        new DataView(bytes.buffer).setUint32(0, json.length);
        bytes.set(json, 4);
        return bytes;
    }
    function pack(meta, stream) {
        const first = prefix(meta);
        let sent = false, reader;
        return new ReadableStream({
            async pull(controller) {
                if (!sent) { sent = true; controller.enqueue(first); return; }
                reader ||= stream.getReader();
                const chunk = await reader.read();
                if (chunk.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(chunk.value);
            },
            async cancel(reason) { if (reader) await reader.cancel(reason); else await stream.cancel(reason); },
        });
    }
    async function unpack(stream) {
        const reader = stream.getReader();
        let buffer = new Uint8Array(0);
        async function take(n) {
            while (buffer.length < n) {
                const part = await reader.read();
                if (part.done) throw new Error('The locked file is incomplete.');
                const next = new Uint8Array(buffer.length + part.value.length); next.set(buffer); next.set(part.value, buffer.length); buffer = next;
            }
            const out = buffer.slice(0, n); buffer = buffer.slice(n); return out;
        }
        try {
            const len = new DataView((await take(4)).buffer).getUint32(0);
            if (len < 2 || len > 65536) throw new Error('The locked file description is invalid.');
            const meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await take(len)));
            if (meta.version !== 1 || typeof meta.name !== 'string' || meta.name.length > 1024 || typeof meta.type !== 'string'
                || !Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error('The locked file description is invalid.');
            let received = 0;
            const content = new ReadableStream({
                async pull(controller) {
                    const part = buffer.length ? { value: buffer, done: false } : await reader.read(); buffer = new Uint8Array(0);
                    if (part.done) {
                        reader.releaseLock();
                        if (received !== meta.size) throw new Error('The locked file size does not match.');
                        controller.close();
                    } else {
                        received += part.value.length;
                        if (received > meta.size) throw new Error('The locked file is longer than expected.');
                        controller.enqueue(part.value);
                    }
                },
                cancel: (reason) => reader.cancel(reason),
            });
            return { meta, stream: content };
        } catch (e) { await reader.cancel(e).catch(() => {}); throw e; }
    }
    const api = { prefix, pack, unpack };
    if (typeof module !== 'undefined') module.exports = api;
    else root.LockerPayload = api;
})(globalThis);
