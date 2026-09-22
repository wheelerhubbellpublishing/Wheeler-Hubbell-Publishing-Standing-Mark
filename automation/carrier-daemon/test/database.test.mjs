import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE_SCHEMA,
  LEGACY_CAMPAIGN,
  LEGACY_CONTACTS,
  MAX_CANDIDATE_VALIDATIONS_PER_RUN,
  MAX_INVITATIONS_PER_24_HOURS,
  MAX_INVITATIONS_PER_RUN,
  SCHEDULE_INTERVAL_MS,
} from '../src/constants.mjs';
import {MIGRATION_SQL, runtimeGrantSql} from '../src/database.mjs';

test('legacy seed contains exactly the 19 previously contacted unique normalized hosts', () => {
  assert.equal(LEGACY_CONTACTS.length, 19);
  assert.equal(new Set(LEGACY_CONTACTS).size, 19);
  assert.equal(LEGACY_CAMPAIGN.unique_hosts, 19);
  for (const hostname of LEGACY_CONTACTS) {
    assert.equal(hostname, hostname.toLowerCase());
    assert.doesNotMatch(hostname, /^https?:\/\//);
  }
});

test('migration creates permanent hostname uniqueness and immutable evidence/contact triggers', () => {
  assert.match(MIGRATION_SQL, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${DATABASE_SCHEMA}`));
  assert.match(MIGRATION_SQL, /hostname text PRIMARY KEY/);
  assert.match(MIGRATION_SQL, /contacted_hosts_one_daemon_run/);
  assert.match(MIGRATION_SQL, /contacted_hosts_immutable/);
  assert.match(MIGRATION_SQL, /evidence_events_immutable/);
  assert.match(MIGRATION_SQL, /BEFORE UPDATE OR DELETE/);
  assert.match(MIGRATION_SQL, /BEFORE TRUNCATE/);
  assert.match(MIGRATION_SQL, /evidence_payload_hash_matches/);
  assert.match(MIGRATION_SQL, /sha256\(convert_to\(payload::text/);
  assert.match(MIGRATION_SQL, /RAISE EXCEPTION/);
});

test('non-overridable bounds remain one per run, four per day, and six hours', () => {
  assert.equal(MAX_INVITATIONS_PER_RUN, 1);
  assert.equal(MAX_INVITATIONS_PER_24_HOURS, 4);
  assert.equal(MAX_CANDIDATE_VALIDATIONS_PER_RUN, 25);
  assert.equal(SCHEDULE_INTERVAL_MS, 21_600_000);
});

test('migration grants keep the recurring runtime role append-only and reject role injection', () => {
  const sql = runtimeGrantSql('carrier_runtime');
  assert.match(sql, /GRANT SELECT ON carrier_automation\.contacted_hosts/);
  assert.match(sql, /GRANT INSERT \(hostname, source, campaign_id, run_id, endpoint, request_sha256, metadata\)/);
  assert.match(sql, /GRANT SELECT ON carrier_automation\.evidence_events/);
  assert.match(sql, /GRANT INSERT \(event_uuid, run_id, kind, hostname, payload, payload_sha256\)/);
  assert.match(sql, /GRANT SELECT, UPDATE ON carrier_automation\.service_control/);
  assert.doesNotMatch(sql, /GRANT[^;]*(DELETE|TRUNCATE|CREATE|DROP)/i);
  assert.throws(() => runtimeGrantSql('carrier_runtime;DROP ROLE x'), /simple PostgreSQL role name/);
});
