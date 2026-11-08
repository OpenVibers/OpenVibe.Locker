'use strict';
const { createAccountData } = require('openvibe-sdk/account-data');
function createAccountDataForLocker(service) {
    const { db } = service;
    return createAccountData({ db, service: 'locker',
        note: 'Content, filenames and types are encrypted. Download envelopes from /api/v1/files/:id/content while signed in, then open them with your keys. Deletion denies access immediately and queues encrypted Media copies for erasure.',
        tables: [
            { table: 'locker_items', subject: 'owner', file: 'items.json', columns: ['id', 'kind', 'parent', 'envelope_bytes', 'lock', 'created_at', 'expires_at', 'downloads', 'download_limit', 'deleted_at'], erase: { keep: 'Erased by extraErase after queuing ciphertext deletion.' } },
            { table: 'locker_reports', subject: 'reporter', file: 'reports.json', erase: { anonymize: {} } },
        ],
        extraExport: async (_db, subject) => {
            const members = await db.many('SELECT service,kind,resource_id,role,expires_at FROM share_members WHERE subject=$1::jsonb', [JSON.stringify({ type: 'user', id: subject })]);
            return [{ name: 'shared-with-me.json', content: members }];
        },
        extraErase: async (t, subjects, counts) => {
            for (const subject of subjects) {
                const a = await service.account(subject, t);
                await t.exec('UPDATE locker_accounts SET deleted=true,restricted=true WHERE subject=$1', [subject]);
                const rows = await t.many('SELECT * FROM locker_items WHERE owner=$1 AND deleted_at IS NULL FOR UPDATE', [subject]);
                for (const row of rows) await service.removeIn(t, row);
                counts.add(counts.erased, 'items', rows.length);
                const uploads = await t.many('SELECT * FROM locker_uploads WHERE owner=$1', [subject]);
                for (const u of uploads) await service.queue(t, u.media_id);
                // Keep the durable cleanup receipt until its temporary file and Media copy are erased.
                await t.exec('UPDATE locker_uploads SET bytes=0,due_at=$2 WHERE owner=$1', [subject, service.iso()]);
                await t.exec('UPDATE locker_accounts SET reserved_bytes=0 WHERE subject=$1', [subject]);
                await t.exec('DELETE FROM locker_upload_results WHERE owner=$1', [subject]);
                await t.exec('DELETE FROM locker_rates WHERE bucket=$1 OR bucket=$2', [`upload:${subject}`, `send:${subject}`]);
                const ref = JSON.stringify({ type: 'user', id: subject });
                await t.exec('DELETE FROM share_members WHERE subject=$1::jsonb OR (service=\'locker\' AND resource_id IN (SELECT id::text FROM locker_items WHERE owner=$2))', [ref, subject]);
                await t.exec('DELETE FROM share_access_requests WHERE subject=$1::jsonb OR (service=\'locker\' AND resource_id IN (SELECT id::text FROM locker_items WHERE owner=$2))', [ref, subject]);
                await t.exec('DELETE FROM share_transfers WHERE from_subject=$1::jsonb OR to_subject=$1::jsonb', [ref]);
                await t.exec('DELETE FROM share_deliveries WHERE delivered_at IS NULL AND (body::text LIKE $1)', [`%${subject}%`]);
                // share_log and staff actions are append-only security evidence; keep no content or keys in either.
                counts.add(counts.retained, 'deletion_marker', a ? 1 : 0);
            }
        },
    });
}
module.exports = { createAccountDataForLocker };
