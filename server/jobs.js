'use strict';
function startJobs(service, { log = console } = {}) {
    let timer = null, stopped = false, running = false;
    const arm = (ms) => { if (!stopped) { clearTimeout(timer); timer = setTimeout(run, Math.max(20, ms)); timer.unref(); } };
    async function run() {
        if (running || stopped) return;
        running = true;
        try { await service.sweep(); await service.flushShares(); }
        catch { log.warn('[Locker] cleanup will retry'); }
        finally {
            running = false;
            const due = await service.nextDue().catch(() => null);
            arm(due ? Math.min(60000, Math.max(20, Date.parse(due) - service.now())) : 60000);
        }
    }
    arm(20);
    return { kick() { arm(20); }, stop() { stopped = true; clearTimeout(timer); } };
}
module.exports = { startJobs };
