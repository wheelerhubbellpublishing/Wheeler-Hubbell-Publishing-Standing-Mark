import {createHash, randomUUID} from 'node:crypto';
import {
  DATABASE_SCHEMA,
  LEGACY_CAMPAIGN,
  LEGACY_CONTACTS,
  MAX_INVITATIONS_PER_24_HOURS,
  RUN_FAILURES_BEFORE_BREAKER,
} from './constants.mjs';

const LEGACY_HOST_VALUES = LEGACY_CONTACTS.map(hostname => `('${hostname}')`).join(',\n  ');
const LEGACY_METADATA = JSON.stringify({
  evidence_version: LEGACY_CAMPAIGN.evidence_version,
  imported_unique_hosts: LEGACY_CAMPAIGN.unique_hosts,
}).replaceAll("'", "''");

export const MIGRATION_SQL = `
BEGIN;
SELECT pg_advisory_xact_lock(928441, 220925);

CREATE SCHEMA IF NOT EXISTS ${DATABASE_SCHEMA};

CREATE TABLE IF NOT EXISTS ${DATABASE_SCHEMA}.contacted_hosts (
  hostname text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL,
  campaign_id text NOT NULL,
  run_id uuid,
  endpoint text,
  request_sha256 char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT contacted_hostname_normalized CHECK (
    hostname = lower(hostname) AND length(hostname) BETWEEN 1 AND 253 AND hostname !~ '\\.$'
  ),
  CONSTRAINT contacted_source CHECK (source IN ('legacy_seed', 'daemon')),
  CONSTRAINT contacted_run_binding CHECK ((source = 'daemon') = (run_id IS NOT NULL)),
  CONSTRAINT contacted_endpoint_binding CHECK (source <> 'daemon' OR endpoint IS NOT NULL),
  CONSTRAINT contacted_request_sha256 CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS contacted_hosts_one_daemon_run
ON ${DATABASE_SCHEMA}.contacted_hosts (run_id)
WHERE source = 'daemon' AND run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${DATABASE_SCHEMA}.evidence_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  run_id uuid,
  kind text NOT NULL,
  hostname text,
  payload json NOT NULL,
  payload_sha256 char(64) NOT NULL,
  CONSTRAINT evidence_payload_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_payload_hash_matches CHECK (
    payload_sha256 = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex')
  )
);

CREATE TABLE IF NOT EXISTS ${DATABASE_SCHEMA}.service_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  breaker_open boolean NOT NULL DEFAULT false,
  breaker_reason text,
  breaker_opened_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO ${DATABASE_SCHEMA}.service_control (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'contacted_hosts_immutable'
      AND tgrelid = '${DATABASE_SCHEMA}.contacted_hosts'::regclass
  ) THEN
    CREATE TRIGGER contacted_hosts_immutable
      BEFORE UPDATE OR DELETE ON ${DATABASE_SCHEMA}.contacted_hosts
      FOR EACH ROW EXECUTE FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'contacted_hosts_no_truncate'
      AND tgrelid = '${DATABASE_SCHEMA}.contacted_hosts'::regclass
  ) THEN
    CREATE TRIGGER contacted_hosts_no_truncate
      BEFORE TRUNCATE ON ${DATABASE_SCHEMA}.contacted_hosts
      FOR EACH STATEMENT EXECUTE FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'evidence_events_immutable'
      AND tgrelid = '${DATABASE_SCHEMA}.evidence_events'::regclass
  ) THEN
    CREATE TRIGGER evidence_events_immutable
      BEFORE UPDATE OR DELETE ON ${DATABASE_SCHEMA}.evidence_events
      FOR EACH ROW EXECUTE FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'evidence_events_no_truncate'
      AND tgrelid = '${DATABASE_SCHEMA}.evidence_events'::regclass
  ) THEN
    CREATE TRIGGER evidence_events_no_truncate
      BEFORE TRUNCATE ON ${DATABASE_SCHEMA}.evidence_events
      FOR EACH STATEMENT EXECUTE FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation();
  END IF;
END;
$$;

INSERT INTO ${DATABASE_SCHEMA}.contacted_hosts
  (hostname, claimed_at, source, campaign_id, metadata)
SELECT hostname, '${LEGACY_CAMPAIGN.contacted_at}'::timestamptz, 'legacy_seed',
       '${LEGACY_CAMPAIGN.campaign_id}', '${LEGACY_METADATA}'::jsonb
FROM (VALUES
  ${LEGACY_HOST_VALUES}
) AS seed(hostname)
ON CONFLICT (hostname) DO NOTHING;
COMMIT;
`;

export const CLAIM_LIMITS_SQL = `SELECT
  count(*) FILTER (WHERE source = 'daemon')::integer AS automated_total,
  count(*) FILTER (
    WHERE source = 'daemon' AND claimed_at > clock_timestamp() - interval '24 hours'
  )::integer AS automated_last_24h,
  count(*) FILTER (WHERE source = 'daemon' AND run_id = $1)::integer AS this_run,
  (max(claimed_at) IS NULL OR max(claimed_at) <= clock_timestamp() - interval '6 hours') AS interval_elapsed
FROM ${DATABASE_SCHEMA}.contacted_hosts`;

export function claimWithinLimits(limits, maxAutomatedContacts) {
  return limits.automated_total < maxAutomatedContacts
    && limits.automated_last_24h < MAX_INVITATIONS_PER_24_HOURS
    && limits.this_run < 1
    && limits.interval_elapsed === true;
}

function quotedRole(role) {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(String(role))) {
    throw new Error('runtimeRole must be a simple PostgreSQL role name');
  }
  return `"${role}"`;
}

export function runtimeGrantSql(runtimeRole) {
  const role = quotedRole(runtimeRole);
  return `
REVOKE ALL ON SCHEMA ${DATABASE_SCHEMA} FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ${DATABASE_SCHEMA} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${DATABASE_SCHEMA} FROM PUBLIC;
REVOKE ALL ON FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ${DATABASE_SCHEMA} FROM ${role};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${DATABASE_SCHEMA} FROM ${role};
GRANT USAGE ON SCHEMA ${DATABASE_SCHEMA} TO ${role};
GRANT SELECT ON ${DATABASE_SCHEMA}.contacted_hosts TO ${role};
GRANT INSERT (hostname, source, campaign_id, run_id, endpoint, request_sha256, metadata)
  ON ${DATABASE_SCHEMA}.contacted_hosts TO ${role};
GRANT SELECT ON ${DATABASE_SCHEMA}.evidence_events TO ${role};
GRANT INSERT (event_uuid, run_id, kind, hostname, payload, payload_sha256)
  ON ${DATABASE_SCHEMA}.evidence_events TO ${role};
GRANT SELECT, UPDATE ON ${DATABASE_SCHEMA}.service_control TO ${role};
GRANT USAGE, SELECT ON SEQUENCE ${DATABASE_SCHEMA}.evidence_events_event_id_seq TO ${role};
GRANT EXECUTE ON FUNCTION ${DATABASE_SCHEMA}.reject_immutable_mutation() TO ${role};
`;
}

export async function migrateDatabase({databaseUrl, runtimeRole}) {
  if (!databaseUrl) throw new Error('migration databaseUrl is required');
  const {Pool} = await import('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'whp-ept-carrier-migration',
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    query_timeout: 30000,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 30000,
  });
  try {
    await pool.query(MIGRATION_SQL);
    const ownership = await pool.query(
      `SELECT
         (SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          FROM pg_namespace WHERE nspname = $1) AS owns_schema,
         (SELECT count(*)::integer FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relname IN ('contacted_hosts', 'evidence_events', 'service_control')
            AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS foreign_owned_tables`,
      [DATABASE_SCHEMA],
    );
    if (!ownership.rows[0].owns_schema || ownership.rows[0].foreign_owned_tables !== 0) {
      throw new Error('migration credential must be the dedicated owner of the carrier schema and tables');
    }
    await pool.query(runtimeGrantSql(runtimeRole));
  } finally {
    await pool.end();
  }
}

function payloadHash(payloadText) {
  return createHash('sha256').update(payloadText).digest('hex');
}

function dateString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function appendEvent(client, {runId = null, kind, hostname = null, payload}) {
  const payloadText = JSON.stringify(payload);
  const eventUuid = randomUUID();
  const digest = payloadHash(payloadText);
  await client.query(
    `INSERT INTO ${DATABASE_SCHEMA}.evidence_events
      (event_uuid, run_id, kind, hostname, payload, payload_sha256)
     VALUES ($1, $2, $3, $4, $5::json, $6)`,
    [eventUuid, runId, kind, hostname, payloadText, digest],
  );
  return {eventUuid, payloadSha256: digest};
}

export async function createRepository({databaseUrl, onPoolError} = {}) {
  if (!databaseUrl) throw new Error('databaseUrl is required');
  const {Pool} = await import('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'whp-ept-carrier',
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    query_timeout: 15000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on('error', error => onPoolError?.(error));

  async function initialize() {
    const schema = await pool.query(
      `SELECT
         (SELECT data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'evidence_events' AND column_name = 'payload') AS payload_type,
         (SELECT count(*)::integer FROM pg_indexes
          WHERE schemaname = $1 AND tablename = 'contacted_hosts'
            AND indexname = 'contacted_hosts_one_daemon_run') AS run_index,
         (SELECT count(*)::integer FROM pg_trigger
          WHERE tgrelid IN (
            '${DATABASE_SCHEMA}.contacted_hosts'::regclass,
            '${DATABASE_SCHEMA}.evidence_events'::regclass
          )
            AND tgname IN (
              'contacted_hosts_immutable',
              'contacted_hosts_no_truncate',
              'evidence_events_immutable',
              'evidence_events_no_truncate'
            )
            AND tgenabled = 'O') AS immutable_triggers,
         (SELECT count(*)::integer FROM pg_constraint
          WHERE conrelid = '${DATABASE_SCHEMA}.evidence_events'::regclass
            AND conname = 'evidence_payload_hash_matches'
            AND convalidated) AS payload_hash_constraint,
         (SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          FROM pg_namespace WHERE nspname = $1) AS runtime_owns_schema,
         (SELECT count(*)::integer FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relname IN ('contacted_hosts', 'evidence_events', 'service_control')
            AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS runtime_owned_tables`,
      [DATABASE_SCHEMA],
    );
    const shape = schema.rows[0];
    if (
      shape.payload_type !== 'json'
      || shape.run_index !== 1
      || shape.immutable_triggers !== 4
      || shape.payload_hash_constraint !== 1
      || shape.runtime_owns_schema
      || shape.runtime_owned_tables !== 0
    ) {
      throw new Error('carrier database schema does not match the required append-only version; run the migration as its separate owner');
    }
    const result = await pool.query(
      `SELECT count(*)::integer AS count
       FROM ${DATABASE_SCHEMA}.contacted_hosts
       WHERE source = 'legacy_seed' AND campaign_id = $1`,
      [LEGACY_CAMPAIGN.campaign_id],
    );
    if (result.rows[0].count !== LEGACY_CONTACTS.length) {
      throw new Error('legacy contact seed is incomplete');
    }
  }

  async function withRunLock(operation) {
    const client = await pool.connect();
    let locked = false;
    let releaseError;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(928441, 220926) AS locked');
      locked = result.rows[0]?.locked === true;
      if (!locked) return {kind: 'suppressed', reason: 'another_run_active'};
      return await operation(client);
    } finally {
      if (locked) {
        try {
          const unlocked = await client.query('SELECT pg_advisory_unlock(928441, 220926) AS unlocked');
          if (unlocked.rows[0]?.unlocked !== true) releaseError = new Error('carrier advisory lock was not released');
        } catch (error) {
          releaseError = error;
        }
      }
      client.release(releaseError);
    }
  }

  async function gate(client, {maxAutomatedContacts}) {
    const controlResult = await client.query(
      `SELECT breaker_open, breaker_reason, breaker_opened_at, consecutive_failures
       FROM ${DATABASE_SCHEMA}.service_control WHERE singleton = true`,
    );
    const control = controlResult.rows[0];
    if (control.breaker_open) {
      return {
        allowed: false,
        reason: 'circuit_breaker_open',
        breakerReason: control.breaker_reason,
        breakerOpenedAt: dateString(control.breaker_opened_at),
      };
    }

    const countsResult = await client.query(
      `SELECT
         count(*) FILTER (WHERE source = 'daemon')::integer AS automated_total,
         count(*) FILTER (
           WHERE source = 'daemon' AND claimed_at > clock_timestamp() - interval '24 hours'
         )::integer AS automated_last_24h,
         max(claimed_at) AS latest_claim,
         (max(claimed_at) IS NULL OR max(claimed_at) <= clock_timestamp() - interval '6 hours') AS interval_elapsed,
         max(claimed_at) + interval '6 hours' AS next_eligible_at
       FROM ${DATABASE_SCHEMA}.contacted_hosts`,
    );
    const counts = countsResult.rows[0];
    if (counts.automated_total > maxAutomatedContacts || counts.automated_last_24h > MAX_INVITATIONS_PER_24_HOURS) {
      return {allowed: false, reason: 'safety_limit_exceeded', counts};
    }
    if (counts.automated_total >= maxAutomatedContacts) {
      return {allowed: false, reason: 'lifetime_cap_reached', counts};
    }
    if (counts.automated_last_24h >= MAX_INVITATIONS_PER_24_HOURS) {
      return {allowed: false, reason: 'daily_cap_reached', counts};
    }
    if (!counts.interval_elapsed) {
      return {
        allowed: false,
        reason: 'minimum_interval',
        nextEligibleAt: dateString(counts.next_eligible_at),
        counts,
      };
    }
    return {allowed: true, counts};
  }

  async function contactedHostnames(client, hostnames) {
    if (!hostnames.length) return new Set();
    const result = await client.query(
      `SELECT hostname FROM ${DATABASE_SCHEMA}.contacted_hosts WHERE hostname = ANY($1::text[])`,
      [hostnames],
    );
    return new Set(result.rows.map(row => row.hostname));
  }

  async function claimHost(client, {
    runId,
    candidate,
    requestSha256,
    requestBytes,
    requestBody,
    maxAutomatedContacts,
  }) {
    await client.query('BEGIN');
    try {
      const control = await client.query(
        `SELECT breaker_open FROM ${DATABASE_SCHEMA}.service_control
         WHERE singleton = true FOR UPDATE`,
      );
      if (control.rows[0].breaker_open) {
        await client.query('ROLLBACK');
        return false;
      }
      const limitsResult = await client.query(CLAIM_LIMITS_SQL, [runId]);
      const limits = limitsResult.rows[0];
      if (!claimWithinLimits(limits, maxAutomatedContacts)) {
        await client.query('ROLLBACK');
        return false;
      }
      const result = await client.query(
        `INSERT INTO ${DATABASE_SCHEMA}.contacted_hosts
          (hostname, source, campaign_id, run_id, endpoint, request_sha256, metadata)
         VALUES ($1, 'daemon', $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (hostname) DO NOTHING
         RETURNING hostname`,
        [
          candidate.hostname,
          'whp-ept-public-invitation-v2',
          runId,
          candidate.endpoint,
          requestSha256,
          JSON.stringify({
            registry_id: candidate.registryId,
            manifest_url: candidate.manifestUrl,
            name: candidate.name,
            protocol_version: candidate.protocolVersion,
            skill_id: candidate.skillId,
            skill_name: candidate.skillName,
            registry_task_checked_at: candidate.registryTaskCheckedAt,
            request_bytes: requestBytes,
          }),
        ],
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await appendEvent(client, {
        runId,
        kind: 'contact_claimed',
        hostname: candidate.hostname,
        payload: {
          endpoint: candidate.endpoint,
          registry_id: candidate.registryId,
          request_sha256: requestSha256,
          request_bytes: requestBytes,
          request_body: requestBody,
          policy: 'The hostname is permanently consumed before transmission; no retry or follow-up is permitted regardless of outcome.',
        },
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function recordEvent(client, event) {
    return appendEvent(client, event);
  }

  async function noteSuccess(client, {runId, kind, payload}) {
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE ${DATABASE_SCHEMA}.service_control
         SET consecutive_failures = 0, updated_at = clock_timestamp()
         WHERE singleton = true`,
      );
      await appendEvent(client, {runId, kind, payload});
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function noteFailureWithClient(client, {runId, reason, details, fatal = false}) {
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT breaker_open, consecutive_failures
         FROM ${DATABASE_SCHEMA}.service_control WHERE singleton = true FOR UPDATE`,
      );
      const failures = current.rows[0].consecutive_failures + 1;
      const trip = fatal || failures >= RUN_FAILURES_BEFORE_BREAKER;
      await client.query(
        `UPDATE ${DATABASE_SCHEMA}.service_control
         SET consecutive_failures = $1,
             breaker_open = breaker_open OR $2,
             breaker_reason = CASE WHEN $2 AND NOT breaker_open THEN $3 ELSE breaker_reason END,
             breaker_opened_at = CASE WHEN $2 AND NOT breaker_open THEN clock_timestamp() ELSE breaker_opened_at END,
             updated_at = clock_timestamp()
         WHERE singleton = true`,
        [failures, trip, reason],
      );
      await appendEvent(client, {
        runId,
        kind: 'run_failure',
        payload: {reason, details, fatal, consecutive_failures: failures, circuit_opened: trip},
      });
      if (trip && !current.rows[0].breaker_open) {
        await appendEvent(client, {
          runId,
          kind: 'circuit_breaker_opened',
          payload: {reason, fatal, consecutive_failures: failures},
        });
      }
      await client.query('COMMIT');
      return {failures, circuitOpened: trip || current.rows[0].breaker_open};
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function noteFailure(options) {
    const client = await pool.connect();
    try {
      return await noteFailureWithClient(client, options);
    } finally {
      client.release();
    }
  }

  async function openBreaker({runId = null, reason, details = {}}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT breaker_open FROM ${DATABASE_SCHEMA}.service_control
         WHERE singleton = true FOR UPDATE`,
      );
      await client.query(
        `UPDATE ${DATABASE_SCHEMA}.service_control
         SET breaker_open = true,
             breaker_reason = $1,
             breaker_opened_at = CASE WHEN breaker_open THEN breaker_opened_at ELSE clock_timestamp() END,
             updated_at = clock_timestamp()
         WHERE singleton = true`,
        [reason],
      );
      if (!current.rows[0].breaker_open) {
        await appendEvent(client, {
          runId,
          kind: 'circuit_breaker_opened',
          payload: {reason, details},
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function status() {
    const result = await pool.query(
      `SELECT
         c.breaker_open,
         c.breaker_reason,
         c.breaker_opened_at,
         c.consecutive_failures,
         (SELECT count(*)::integer FROM ${DATABASE_SCHEMA}.contacted_hosts) AS contacted_total,
         (SELECT count(*)::integer FROM ${DATABASE_SCHEMA}.contacted_hosts WHERE source = 'legacy_seed') AS legacy_seeded,
         (SELECT count(*)::integer FROM ${DATABASE_SCHEMA}.contacted_hosts WHERE source = 'daemon') AS automated_total,
         (SELECT count(*)::integer FROM ${DATABASE_SCHEMA}.contacted_hosts
           WHERE source = 'daemon' AND claimed_at > clock_timestamp() - interval '24 hours') AS automated_last_24h,
         (SELECT max(claimed_at) FROM ${DATABASE_SCHEMA}.contacted_hosts) AS latest_claim,
         (SELECT max(recorded_at) FROM ${DATABASE_SCHEMA}.evidence_events WHERE kind = 'delivery_outcome') AS latest_delivery,
         (SELECT count(*)::integer FROM ${DATABASE_SCHEMA}.evidence_events) AS evidence_events
       FROM ${DATABASE_SCHEMA}.service_control c
       WHERE singleton = true`,
    );
    const row = result.rows[0];
    return {
      breakerOpen: row.breaker_open,
      breakerReason: row.breaker_reason,
      breakerOpenedAt: dateString(row.breaker_opened_at),
      consecutiveFailures: row.consecutive_failures,
      contactedTotal: row.contacted_total,
      legacySeeded: row.legacy_seeded,
      automatedTotal: row.automated_total,
      automatedLast24h: row.automated_last_24h,
      latestClaim: dateString(row.latest_claim),
      latestDelivery: dateString(row.latest_delivery),
      evidenceEvents: row.evidence_events,
    };
  }

  async function ping() {
    await pool.query('SELECT 1');
    return true;
  }

  return Object.freeze({
    initialize,
    withRunLock,
    gate,
    contactedHostnames,
    claimHost,
    recordEvent,
    noteSuccess,
    noteFailure,
    noteFailureWithClient,
    openBreaker,
    status,
    ping,
    close: () => pool.end(),
  });
}
