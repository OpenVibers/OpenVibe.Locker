'use strict';
const fs = require('node:fs/promises');
const { inspectEnvelopePrefix } = require('openvibe-sdk/locker/server');
const { fail } = require('./errors');
const CHUNK = 1048576, MAX_HEADER = 65536;
const fields = ['version', 'suite', 'chunk_size', 'padded_size', 'nonce_base', 'lock', 'slots'];
function headerInfo(prefix, totalBytes, maxBytes) {
    const bad = () => fail(400, 'locker.envelope.required', 'Upload a complete locker.envelope.v1 envelope.');
    if (prefix.length < 8 || prefix.toString('ascii', 0, 4) !== 'OVLK') bad();
    const length = prefix.readUInt32BE(4);
    if (!length || length > MAX_HEADER || prefix.length < 8 + length) bad();
    const info = inspectEnvelopePrefix(prefix, totalBytes);
    if (!info.valid) bad();
    const { header } = info;
    if (Object.keys(header).some((k) => !fields.includes(k)) || !Number.isSafeInteger(header.padded_size)) bad();
    const allowed = (o, keys) => o && Object.keys(o).every((k) => keys.includes(k));
    if (header.lock === 'people') for (const slot of header.slots.people) {
        if (!allowed(slot, ['subject','algorithm','recipient_key','ephemeral_public_key','salt','nonce','wrapped_key'])
            || !allowed(slot.subject, ['type','id']) || !allowed(slot.ephemeral_public_key, ['kty','crv','x','y'])) bad();
    }
    if (header.padded_size > maxBytes) fail(413, 'locker.file.too_large', 'This envelope exceeds the configured file limit.');
    return { header, offset: info.chunkOffset, expected: info.expectedBytes, prefix: prefix.subarray(0, info.chunkOffset) };
}
async function inspectFile(file, bytes, maxBytes) {
    const fd = await fs.open(file, 'r');
    try {
        const prefix = Buffer.alloc(Math.min(bytes, MAX_HEADER + 8));
        const { bytesRead } = await fd.read(prefix, 0, prefix.length, 0);
        return headerInfo(prefix.subarray(0, bytesRead), bytes, maxBytes);
    } finally { await fd.close(); }
}
module.exports = { inspectFile, headerInfo, MAX_HEADER, CHUNK };
