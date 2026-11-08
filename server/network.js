'use strict';
const { serviceAuth } = require('openvibe-contracts');
const { fail } = require('./errors');
function createNetwork(config, fetchImpl = fetch) {
    const clients = new Map();
    async function json({ path, query, method = 'GET', json: body, token, preserveProblem = false, audience = 'openvibe.network', base = config.networkInternalUrl }) {
        if (!clients.has(audience)) clients.set(audience, serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.clientId,
            clientSecret: config.clientSecret, audience, fetchImpl,
        }));
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
        for (let attempt = 0; attempt < 2; attempt++) {
            const headers = token ? { Authorization: `Bearer ${token}` } : await clients.get(audience).authHeaders();
            const r = await fetchImpl(url, { method, headers: { ...headers, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
            if (r.status === 401 && !token && !attempt) { clients.get(audience).invalidate(); continue; }
            if (!r.ok) {
                if (preserveProblem && r.status >= 400 && r.status < 500) {
                    const problem = await r.json().catch(() => ({}));
                    fail(r.status, problem.code || problem.error || 'locker.network.request', problem.detail || problem.message || problem.error || 'Network rejected this request.');
                }
                fail(r.status === 404 ? 404 : 503, 'locker.network.unavailable', 'Network could not complete this request.');
            }
            return r.json();
        }
    }
    return { json, standing: (subject) => json({ path: '/internal/identity/resolve', query: { subject_id: subject, trust: '1' } }) };
}
module.exports = { createNetwork };
