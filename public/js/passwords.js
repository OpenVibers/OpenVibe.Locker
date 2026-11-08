(function (root) {
    'use strict';
    function parseCsv(text) {
        const rows = []; let row = [], field = '', quoted = false;
        for (let i = 0; i < text.length; i++) { const c = text[i]; if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
            else if (c === '"') quoted = true; else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; } else field += c; }
        if (quoted) throw new Error('CSV has an unclosed quoted field.'); if (field || row.length) { row.push(field); rows.push(row); } return rows.filter((r) => r.some(Boolean));
    }
    function normalizeOrigin(value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a valid website URL.'); return url.origin; }
    async function breachRange(password) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password)));
        const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
    }
    async function totp(secret, now = Date.now()) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '', bytes = [];
        for (const c of secret.toUpperCase().replace(/[\s=-]/g, '')) { const v = alphabet.indexOf(c); if (v < 0) throw new Error('The TOTP secret is not valid Base32.'); bits += v.toString(2).padStart(5, '0'); }
        for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
        const counter = BigInt(Math.floor(now / 30000)); const msg = new Uint8Array(8); new DataView(msg.buffer).setBigUint64(0, counter);
        const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']); const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
        const off = mac.at(-1) & 15; const code = ((mac[off] & 127) << 24 | mac[off + 1] << 16 | mac[off + 2] << 8 | mac[off + 3]) % 1000000; return String(code).padStart(6, '0');
    }
    const api = { parseCsv, normalizeOrigin, breachRange, totp };
    if (typeof module !== 'undefined') module.exports = api;
    else root.LockerPasswords = api;
})(globalThis);
