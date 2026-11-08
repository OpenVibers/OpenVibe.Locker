'use strict';
const path = require('node:path');
const { createDb } = require('openvibe-sdk/db');
const { sharesSchema } = require('openvibe-sdk/share');
const { ACCOUNT_DATA_SCHEMA } = require('openvibe-sdk/account-data');
const migrations = path.join(__dirname, '..', 'migrations');
async function migrate(db) {
    await db.migrate({ dir: migrations });
    await db.exec(sharesSchema());
    await db.exec(ACCOUNT_DATA_SCHEMA);
}
async function openDb(config) {
    if (!config.dbUrl) {
        if (config.production) throw new Error('DATABASE_URL is required in production');
        const db = createDb({ pglite: path.join(config.dataDir, 'pglite'), service: 'locker' });
        await migrate(db);
        return db;
    }
    if (!config.dbDirectUrl) throw new Error('DATABASE_DIRECT_URL is required for migrations');
    const owner = createDb({ url: config.dbDirectUrl, service: 'locker-migrate', max: 1 });
    try { await migrate(owner); } finally { await owner.close(); }
    return createDb({ url: config.dbUrl, service: 'locker' });
}
module.exports = { openDb, migrate };
