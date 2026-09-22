import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {
  CLAIM_LIMITS_SQL,
  MIGRATION_SQL,
  claimWithinLimits,
} from '../src/database.mjs';

async function loadPGlite() {
  try {
    return (await import('@electric-sql/pglite')).PGlite;
  } catch {
    try {
      const requireFromWorkspace = createRequire(new URL('../../settlement-observer/package.json', import.meta.url));
      const entry = requireFromWorkspace.resolve('@electric-sql/pglite');
      return (await import(pathToFileURL(entry))).PGlite;
    } catch {
      return null;
    }
  }
}

test('PostgreSQL-compatible migration enforces append-only rows and one daemon claim per run', async t => {
  const PGlite = await loadPGlite();
  if (!PGlite) {
    t.skip('@electric-sql/pglite is unavailable');
    return;
  }
  const database = new PGlite();
  const runId = '00000000-0000-4000-8000-000000000001';
  try {
    await database.exec(MIGRATION_SQL);
    const payload = '{"exact":"payload"}';
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');
    await database.query(
      `INSERT INTO carrier_automation.contacted_hosts
        (hostname, claimed_at, source, campaign_id, run_id, endpoint, request_sha256)
       VALUES ($1, clock_timestamp(), 'daemon', 'test', $2, $3, $4)`,
      ['one.example.org', runId, 'https://one.example.org/a2a', 'a'.repeat(64)],
    );
    await assert.rejects(
      database.query(
        `INSERT INTO carrier_automation.contacted_hosts
          (hostname, claimed_at, source, campaign_id, run_id, endpoint, request_sha256)
         VALUES ($1, clock_timestamp(), 'daemon', 'test', $2, $3, $4)`,
        ['two.example.org', runId, 'https://two.example.org/a2a', 'b'.repeat(64)],
      ),
      /contacted_hosts_one_daemon_run|unique/i,
    );

    const limits = (await database.query(CLAIM_LIMITS_SQL, [runId])).rows[0];
    assert.equal(limits.automated_total, 1);
    assert.equal(limits.this_run, 1);
    assert.equal(limits.interval_elapsed, false);
    assert.equal(claimWithinLimits(limits, 500), false);

    await database.query(
      `INSERT INTO carrier_automation.evidence_events
        (event_uuid, run_id, kind, hostname, payload, payload_sha256)
       VALUES ($1, $2, 'delivery_outcome', 'one.example.org', $3::json, $4)`,
      [
        '00000000-0000-4000-8000-000000000002',
        runId,
        payload,
        payloadSha256,
      ],
    );
    const stored = await database.query('SELECT payload::text AS payload FROM carrier_automation.evidence_events');
    assert.equal(stored.rows[0].payload, '{"exact":"payload"}');
    await assert.rejects(
      database.query(
        `INSERT INTO carrier_automation.evidence_events
          (event_uuid, run_id, kind, hostname, payload, payload_sha256)
         VALUES ($1, $2, 'run_failure', null, $3::json, $4)`,
        ['00000000-0000-4000-8000-000000000003', runId, '{"tampered":true}', 'd'.repeat(64)],
      ),
      /evidence_payload_hash_matches|check constraint/i,
    );

    await assert.rejects(
      database.exec("UPDATE carrier_automation.contacted_hosts SET endpoint = 'https://changed.example'"),
      /append-only/i,
    );
    await assert.rejects(
      database.exec('DELETE FROM carrier_automation.evidence_events'),
      /append-only/i,
    );
    await assert.rejects(
      database.exec('TRUNCATE carrier_automation.contacted_hosts'),
      /append-only/i,
    );
  } finally {
    await database.close();
  }
});
