'use strict';
const { createApp } = require('./app');
const { startJobs } = require('./jobs');
const { startSubscriptions } = require('openvibe-sdk/account-data');
(async () => {
    const ctx = await createApp();
    const { config, app, service, db } = ctx;
    if (config.production && (!config.clientSecret || !config.eventsSecret)) throw new Error('Locker service credentials and Events delivery must be configured.');
    const jobs = startJobs(service);
    const subscriptions = config.clientSecret && config.eventsSecret ? startSubscriptions({ eventsUrl: config.eventsUrl, endpoint: `http://127.0.0.1:${config.port}/internal/events`,
        secret: config.eventsSecret, networkInternalUrl: config.networkInternalUrl, clientId: config.clientId, clientSecret: config.clientSecret }) : null;
    const server = app.listen(config.port, config.host, () => console.log(`OpenVibe.Locker listening on ${config.host}:${config.port}`));
    server.requestTimeout = 30 * 60 * 1000;
    const stop = () => { jobs.stop(); subscriptions?.stop(); server.close(() => db.close().then(() => process.exit(0))); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
})().catch(() => { console.error('OpenVibe.Locker could not start. Check service configuration.'); process.exitCode = 1; });
