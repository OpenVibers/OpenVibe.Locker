'use strict';
const path = require('node:path');
function load(env = process.env) {
    const int = (key, fallback) => {
        const n = env[key] === undefined ? fallback : Number(env[key]);
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
        return n;
    };
    const port = int('PORT', 5145);
    const production = env.NODE_ENV === 'production';
    return {
        port, production, host: env.HOST || '127.0.0.1', baseUrl: env.BASE_URL || `http://localhost:${port}`,
        trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),
        networkUrl: env.OV_NETWORK_URL || 'https://openvibe.network',
        networkInternalUrl: env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
        mediaUrl: env.OV_MEDIA_URL || 'https://openvibe.media',
        eventsUrl: env.OV_EVENTS_URL || 'https://openvibe.events',
        clientId: 'locker', clientSecret: env.OV_OAUTH_CLIENT_SECRET || '', eventsSecret: env.LOCKER_EVENTS_SECRET || '',
        dbUrl: env.DATABASE_URL, dbDirectUrl: env.DATABASE_DIRECT_URL,
        dataDir: path.resolve(env.LOCKER_DATA_DIR || 'data'),
        quotaBytes: int('LOCKER_QUOTA_BYTES', 5 * 1024 ** 3),
        maxFileBytes: int('LOCKER_MAX_FILE_BYTES', 2 * 1024 ** 3),
        minAgeDays: int('LOCKER_MIN_ACCOUNT_DAYS', 7),
        uploadsPerHour: int('LOCKER_UPLOADS_PER_HOUR', 60), sendsPerHour: int('LOCKER_SENDS_PER_HOUR', 20),
        allowlistOnly: env.LOCKER_ALLOWLIST_ONLY === 'true',
        allowlist: new Set((env.LOCKER_UPLOAD_ALLOWLIST || '').split(',').filter(Boolean)),
        secureCookies: production,
    };
}
module.exports = { load };
