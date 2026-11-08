'use strict';
const fs = require('node:fs/promises');
const { serviceAuth } = require('openvibe-contracts');
const { fail } = require('./errors');
function createMedia(config, fetchImpl = fetch) {
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.clientId,
        clientSecret: config.clientSecret, audience: 'openvibe.media', scope: 'media.object.upload media.object.read media.object.delete', fetchImpl });
    const base = `${config.mediaUrl}/api/v2/locker/objects`;
    async function call(method, path, { json, body, headers = {}, raw = false } = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetchImpl(base + path, { method, headers: { ...(await tokens.authHeaders()), ...headers,
                ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: json === undefined ? body : JSON.stringify(json), signal: AbortSignal.timeout(120000) });
            if (r.status === 401 && !attempt) { tokens.invalidate(); continue; }
            if (!r.ok) fail(502, 'locker.media.unavailable', 'Encrypted storage could not complete the request.');
            return raw ? r : r.json();
        }
    }
    return {
        async upload(file, bytes, owner, record) {
            const init = await call('POST', '', { json: { kind: 'file', namespace: 'locker', visibility: 'private', mime_type: 'application/octet-stream',
                size_bytes: bytes, filename: 'locked.ovlk', multipart: true, part_size: 8 * 1024 ** 2 }, headers: { 'X-OV-Subject': owner } });
            if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(init.id || '')) fail(502, 'locker.media.invalid', 'Encrypted storage returned an invalid reference.');
            await record(init.id); // Persist before sending bytes; a crashed upload is collected later.
            const session = init.upload?.multipart || {};
            const partSize = Number(session.part_size);
            const uploadId = session.upload_id;
            if (!uploadId || !Number.isSafeInteger(partSize) || partSize < 1 || partSize > 64 * 1024 ** 2) fail(502, 'locker.media.invalid', 'Encrypted storage returned an invalid upload session.');
            const fd = await fs.open(file, 'r');
            try {
                for (let offset = 0, n = 1; offset < bytes; n++) {
                    const b = Buffer.alloc(Math.min(partSize, bytes - offset));
                    let got = 0;
                    while (got < b.length) { const read = await fd.read(b, got, b.length - got, offset + got); if (!read.bytesRead) throw new Error('Incomplete ciphertext'); got += read.bytesRead; }
                    await call('PUT', `/${init.id}/multipart/${uploadId}/parts/${n}`, { body: b, headers: { 'Content-Type': 'application/octet-stream' } });
                    offset += got;
                }
            } finally { await fd.close(); }
            await call('POST', `/${init.id}/multipart/${uploadId}/complete`, { json: {} });
            return init.id;
        },
        async read(id) {
            // Keep private signed URLs on the server; never redirect a limited Send to Media.
            const { url } = await call('GET', `/${encodeURIComponent(id)}/download?format=json`);
            let target = new URL(url);
            const internal = new URL(config.mediaUrl);
            if (config.mediaPublicUrl && target.origin === new URL(config.mediaPublicUrl).origin && target.origin !== internal.origin) {
                target = new URL(`${target.pathname}${target.search}`, internal.origin);
            }
            if (target.origin !== internal.origin) fail(502, 'locker.media.origin', 'Unexpected encrypted storage origin.');
            // Media may redirect its private signed URL to a signed storage-provider URL; no service credentials follow.
            const r = await fetchImpl(target, { signal: AbortSignal.timeout(30 * 60 * 1000), redirect: 'follow' });
            if (!r.ok || !r.body) fail(502, 'locker.media.read', 'Encrypted storage is temporarily unavailable.');
            return r;
        },
        async delete(id) { await call('DELETE', `/${encodeURIComponent(id)}?purge=1`); },
    };
}
module.exports = { createMedia };
