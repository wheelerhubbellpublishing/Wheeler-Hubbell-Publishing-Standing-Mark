import { Fault, canonical, demand, sha256 } from "./core.mjs";

const STATES = ["QUOTED", "PREPARED", "SETTLING", "SETTLED", "COMPLETED"];
const STRIPE_STATES = ["PENDING", "COMPLETED"];
const MUTABLE_COLUMNS = new Set([
  "state",
  "payment_key",
  "payment_payload",
  "facilitator_verification",
  "observed_block",
  "scan_from",
  "transaction_hint",
  "settlement_evidence",
  "result_bytes",
  "attempts",
  "next_attempt_at",
]);
const JSON_COLUMNS = new Set(["payment_payload", "facilitator_verification", "settlement_evidence"]);
const NUMBER_COLUMNS = new Set(["observed_block", "scan_from", "attempts", "next_attempt_at", "created_at", "updated_at", "lease_until"]);
const STRIPE_NUMBER_COLUMNS = new Set(["amount_total", "attempts", "next_attempt_at", "created_at", "updated_at", "lease_until"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizedRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const name of NUMBER_COLUMNS) if (out[name] !== null && out[name] !== undefined) out[name] = Number(out[name]);
  return out;
}

function normalizedStripeRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const name of STRIPE_NUMBER_COLUMNS) if (out[name] !== null && out[name] !== undefined) out[name] = Number(out[name]);
  return out;
}

function assertStripeIdentity(row, order) {
  demand(row.session_id === order.session_id
    && row.target_hash === order.target_hash
    && row.amount_total === order.amount_total
    && row.currency === order.currency
    && row.payment_link === order.payment_link
    && row.livemode === order.livemode, "STRIPE_SESSION_CONFLICT", 409);
  demand(/^[0-9a-f]{64}$/u.test(row.result_token)
    && sha256(row.result_token) === row.result_token_hash, "STRIPE_RESULT_IDENTITY_INVALID", 500);
}

function assertStripeEvent(prior, event) {
  demand(prior.session_id === event.session_id
    && prior.event_type === event.event_type, "STRIPE_EVENT_CONFLICT", 409);
}

export class MemoryPurchaseStore {
  constructor() {
    this.rows = new Map();
    this.stripeRows = new Map();
    this.stripeEvents = new Map();
  }

  async init() {}

  async close() {}

  async ping() { return true; }

  async createQuote(row) {
    const prior = this.rows.get(row.id);
    if (prior) return clone(prior);
    this.rows.set(row.id, clone({
      ...row,
      state: "QUOTED",
      payment_key: null,
      payment_payload: null,
      facilitator_verification: null,
      observed_block: null,
      scan_from: null,
      transaction_hint: null,
      settlement_evidence: null,
      result_bytes: null,
      attempts: 0,
      next_attempt_at: row.created_at,
      updated_at: row.created_at,
      lease_owner: null,
      lease_until: null,
    }));
    return clone(this.rows.get(row.id));
  }

  async get(id) {
    return clone(this.rows.get(id) ?? null);
  }

  async paymentOwner(paymentKey) {
    return clone([...this.rows.values()].find((row) => row.payment_key === paymentKey) ?? null);
  }

  async bindPayment(id, requestHash, fields, now) {
    const row = this.rows.get(id);
    demand(row && row.request_hash === requestHash, "PURCHASE_NOT_FOUND", 404);
    if (row.payment_key) return clone(row);
    const owner = [...this.rows.values()].find((candidate) => candidate.payment_key === fields.payment_key);
    demand(!owner || owner.id === id, "PAYMENT_REPLAY", 409);
    demand(row.state === "QUOTED", "PURCHASE_STATE_CONFLICT", 409);
    Object.assign(row, clone(fields), { state: "PREPARED", updated_at: now });
    return clone(row);
  }

  async mutate(id, expectedStates, fields, now, owner = null) {
    demand(Object.keys(fields).every((key) => MUTABLE_COLUMNS.has(key)), "STORE_FIELD_INVALID", 500);
    const row = this.rows.get(id);
    demand(row && expectedStates.includes(row.state), "PURCHASE_STATE_CONFLICT", 409);
    if (owner !== null) demand(row.lease_owner === owner && row.lease_until >= now, "PURCHASE_LEASE_LOST", 409);
    Object.assign(row, clone(fields), { updated_at: now });
    return clone(row);
  }

  async lease(id, owner, now, seconds = 30) {
    const row = this.rows.get(id);
    if (!row || row.state === "COMPLETED" || (row.lease_owner && row.lease_until >= now)) return false;
    row.lease_owner = owner;
    row.lease_until = now + seconds;
    row.updated_at = now;
    return true;
  }

  async release(id, owner, now) {
    const row = this.rows.get(id);
    if (row?.lease_owner === owner) {
      row.lease_owner = null;
      row.lease_until = null;
      row.updated_at = now;
    }
  }

  async recordStripeEvent(order, event) {
    const priorOrder = this.stripeRows.get(order.session_id);
    if (priorOrder) assertStripeIdentity(priorOrder, order);
    const priorEvent = this.stripeEvents.get(event.id);
    if (priorEvent) assertStripeEvent(priorEvent, event);
    if (!priorOrder) this.stripeRows.set(order.session_id, clone({
      ...order,
      state: "PENDING",
      result_bytes: null,
      attempts: 0,
      next_attempt_at: order.created_at,
      updated_at: order.created_at,
      lease_owner: null,
      lease_until: null,
    }));
    if (!priorEvent) this.stripeEvents.set(event.id, clone(event));
    return { row: clone(this.stripeRows.get(order.session_id)), duplicate: Boolean(priorEvent) };
  }

  async getStripeBySession(sessionId) {
    return clone(this.stripeRows.get(sessionId) ?? null);
  }

  async getStripeByTokenHash(tokenHash) {
    return clone([...this.stripeRows.values()].find((row) => row.result_token_hash === tokenHash) ?? null);
  }

  async leaseStripe(sessionId, owner, now, seconds = 900) {
    const row = this.stripeRows.get(sessionId);
    if (!row || row.state !== "PENDING" || row.next_attempt_at > now || (row.lease_owner && row.lease_until >= now)) return null;
    Object.assign(row, { lease_owner: owner, lease_until: now + seconds, updated_at: now });
    return clone(row);
  }

  async claimNextStripe(owner, now, seconds = 900) {
    const row = [...this.stripeRows.values()]
      .filter((candidate) => candidate.state === "PENDING" && candidate.next_attempt_at <= now
        && (!candidate.lease_owner || candidate.lease_until < now))
      .sort((left, right) => left.created_at - right.created_at)[0];
    return row ? this.leaseStripe(row.session_id, owner, now, seconds) : null;
  }

  async completeStripe(sessionId, owner, resultBytes, now) {
    const row = this.stripeRows.get(sessionId);
    demand(row && STRIPE_STATES.includes(row.state), "STRIPE_ORDER_NOT_FOUND", 404);
    demand(row.state === "PENDING" && row.lease_owner === owner && row.lease_until >= now, "STRIPE_LEASE_LOST", 409);
    Object.assign(row, { state: "COMPLETED", result_bytes: resultBytes, updated_at: now, lease_owner: null, lease_until: null });
    return clone(row);
  }

  async failStripe(sessionId, owner, now, retrySeconds = 300) {
    const row = this.stripeRows.get(sessionId);
    if (row?.state === "PENDING" && row.lease_owner === owner) {
      Object.assign(row, {
        attempts: row.attempts + 1,
        next_attempt_at: now + retrySeconds,
        updated_at: now,
        lease_owner: null,
        lease_until: null,
      });
    }
  }
}

export class PostgresPurchaseStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS whp_market_purchases (
        id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
        product TEXT NOT NULL CHECK (product IN ('snapshot', 'readiness')),
        request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        request_json JSONB NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('QUOTED', 'PREPARED', 'SETTLING', 'SETTLED', 'COMPLETED')),
        quote JSONB NOT NULL,
        requirements JSONB NOT NULL,
        bazaar JSONB NOT NULL,
        payment_key TEXT UNIQUE,
        payment_payload JSONB,
        facilitator_verification JSONB,
        observed_block BIGINT,
        scan_from BIGINT,
        transaction_hint TEXT,
        settlement_evidence JSONB,
        result_bytes TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        lease_owner TEXT,
        lease_until BIGINT
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS whp_market_state_idx ON whp_market_purchases (state, next_attempt_at)");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS whp_market_stripe_fulfillments (
        session_id TEXT PRIMARY KEY CHECK (session_id ~ '^cs_live_[A-Za-z0-9_]+$'),
        target_url TEXT NOT NULL,
        target_hash TEXT NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
        result_token TEXT NOT NULL UNIQUE CHECK (result_token ~ '^[0-9a-f]{64}$'),
        result_token_hash TEXT NOT NULL UNIQUE CHECK (result_token_hash ~ '^[0-9a-f]{64}$'),
        amount_total INTEGER NOT NULL CHECK (amount_total = 2500),
        currency TEXT NOT NULL CHECK (currency = 'usd'),
        payment_link TEXT NOT NULL CHECK (payment_link ~ '^plink_[A-Za-z0-9_]+$'),
        livemode BOOLEAN NOT NULL CHECK (livemode = TRUE),
        state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED')),
        result_bytes TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        lease_owner TEXT,
        lease_until BIGINT,
        CHECK ((state = 'COMPLETED') = (result_bytes IS NOT NULL))
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS whp_market_stripe_events (
        event_id TEXT PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]+$'),
        session_id TEXT NOT NULL REFERENCES whp_market_stripe_fulfillments(session_id),
        event_type TEXT NOT NULL CHECK (event_type IN ('checkout.session.completed', 'checkout.session.async_payment_succeeded')),
        payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        created_at BIGINT NOT NULL
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS whp_market_stripe_pending_idx ON whp_market_stripe_fulfillments (state, next_attempt_at, created_at)");
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async createQuote(row) {
    await this.pool.query(
      `INSERT INTO whp_market_purchases
        (id, product, request_hash, request_json, state, quote, requirements, bazaar, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,'QUOTED',$5::jsonb,$6::jsonb,$7::jsonb,0,$8,$8,$8)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.product, row.request_hash, canonical(row.request_json), canonical(row.quote), canonical(row.requirements), canonical(row.bazaar), row.created_at],
    );
    return this.get(row.id);
  }

  async get(id) {
    const result = await this.pool.query("SELECT * FROM whp_market_purchases WHERE id=$1", [id]);
    return normalizedRow(result.rows[0] ?? null);
  }

  async paymentOwner(paymentKey) {
    const result = await this.pool.query("SELECT * FROM whp_market_purchases WHERE payment_key=$1", [paymentKey]);
    return normalizedRow(result.rows[0] ?? null);
  }

  async bindPayment(id, requestHash, fields, now) {
    try {
      const result = await this.pool.query(
        `UPDATE whp_market_purchases SET
          state='PREPARED', payment_key=$3, payment_payload=$4::jsonb,
          facilitator_verification=$5::jsonb, observed_block=$6, scan_from=$6,
          attempts=0, next_attempt_at=$7, updated_at=$7
         WHERE id=$1 AND request_hash=$2 AND state='QUOTED' AND payment_key IS NULL
         RETURNING *`,
        [id, requestHash, fields.payment_key, canonical(fields.payment_payload), canonical(fields.facilitator_verification), fields.observed_block, now],
      );
      if (result.rows[0]) return normalizedRow(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505") throw new Fault("PAYMENT_REPLAY", 409);
      throw error;
    }
    const row = await this.get(id);
    demand(row, "PURCHASE_NOT_FOUND", 404);
    return row;
  }

  async mutate(id, expectedStates, fields, now, owner = null) {
    demand(expectedStates.length > 0 && expectedStates.every((state) => STATES.includes(state)), "STORE_STATE_INVALID", 500);
    demand(Object.keys(fields).length > 0 && Object.keys(fields).every((key) => MUTABLE_COLUMNS.has(key)), "STORE_FIELD_INVALID", 500);
    const values = [id, expectedStates, now];
    const assignments = Object.entries(fields).map(([key, value]) => {
      values.push(JSON_COLUMNS.has(key) && value !== null ? canonical(value) : value);
      return `${key}=$${values.length}${JSON_COLUMNS.has(key) ? "::jsonb" : ""}`;
    });
    let ownerClause = "";
    if (owner !== null) {
      values.push(owner);
      ownerClause = ` AND lease_owner=$${values.length} AND lease_until >= $3`;
    }
    const result = await this.pool.query(
      `UPDATE whp_market_purchases SET ${assignments.join(", ")}, updated_at=$3
       WHERE id=$1 AND state=ANY($2::text[])${ownerClause} RETURNING *`,
      values,
    );
    demand(result.rows[0], "PURCHASE_STATE_CONFLICT", 409);
    return normalizedRow(result.rows[0]);
  }

  async lease(id, owner, now, seconds = 30) {
    const result = await this.pool.query(
      `UPDATE whp_market_purchases SET lease_owner=$2, lease_until=$3, updated_at=$4
       WHERE id=$1 AND state <> 'COMPLETED' AND (lease_owner IS NULL OR lease_until < $4)
       RETURNING id`,
      [id, owner, now + seconds, now],
    );
    return result.rowCount === 1;
  }

  async release(id, owner, now) {
    await this.pool.query(
      "UPDATE whp_market_purchases SET lease_owner=NULL, lease_until=NULL, updated_at=$3 WHERE id=$1 AND lease_owner=$2",
      [id, owner, now],
    );
  }

  async recordStripeEvent(order, event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO whp_market_stripe_fulfillments
          (session_id,target_url,target_hash,result_token,result_token_hash,amount_total,currency,payment_link,livemode,state,result_bytes,attempts,next_attempt_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',NULL,0,$10,$10,$10)
         ON CONFLICT (session_id) DO NOTHING`,
        [order.session_id, order.target_url, order.target_hash, order.result_token, order.result_token_hash, order.amount_total,
          order.currency, order.payment_link, order.livemode, order.created_at],
      );
      const orderResult = await client.query("SELECT * FROM whp_market_stripe_fulfillments WHERE session_id=$1 FOR UPDATE", [order.session_id]);
      const row = normalizedStripeRow(orderResult.rows[0]);
      demand(row, "STRIPE_ORDER_NOT_FOUND", 500);
      assertStripeIdentity(row, order);
      const inserted = await client.query(
        `INSERT INTO whp_market_stripe_events (event_id,session_id,event_type,payload_hash,created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [event.id, event.session_id, event.event_type, event.payload_hash, event.created_at],
      );
      const eventResult = await client.query("SELECT event_id AS id,session_id,event_type,payload_hash,created_at FROM whp_market_stripe_events WHERE event_id=$1", [event.id]);
      const priorEvent = eventResult.rows[0];
      demand(priorEvent, "STRIPE_EVENT_PERSIST_FAILED", 500);
      assertStripeEvent(priorEvent, event);
      await client.query("COMMIT");
      return { row, duplicate: inserted.rowCount === 0 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getStripeBySession(sessionId) {
    const result = await this.pool.query("SELECT * FROM whp_market_stripe_fulfillments WHERE session_id=$1", [sessionId]);
    return normalizedStripeRow(result.rows[0] ?? null);
  }

  async getStripeByTokenHash(tokenHash) {
    const result = await this.pool.query("SELECT * FROM whp_market_stripe_fulfillments WHERE result_token_hash=$1", [tokenHash]);
    return normalizedStripeRow(result.rows[0] ?? null);
  }

  async leaseStripe(sessionId, owner, now, seconds = 900) {
    const result = await this.pool.query(
      `UPDATE whp_market_stripe_fulfillments
       SET lease_owner=$2,lease_until=$3,updated_at=$4
       WHERE session_id=$1 AND state='PENDING' AND next_attempt_at <= $4
         AND (lease_owner IS NULL OR lease_until < $4)
       RETURNING *`,
      [sessionId, owner, now + seconds, now],
    );
    return normalizedStripeRow(result.rows[0] ?? null);
  }

  async claimNextStripe(owner, now, seconds = 900) {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT session_id FROM whp_market_stripe_fulfillments
         WHERE state='PENDING' AND next_attempt_at <= $1
           AND (lease_owner IS NULL OR lease_until < $1)
         ORDER BY created_at,session_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE whp_market_stripe_fulfillments AS fulfillment
       SET lease_owner=$2,lease_until=$3,updated_at=$1
       FROM candidate WHERE fulfillment.session_id=candidate.session_id
       RETURNING fulfillment.*`,
      [now, owner, now + seconds],
    );
    return normalizedStripeRow(result.rows[0] ?? null);
  }

  async completeStripe(sessionId, owner, resultBytes, now) {
    const result = await this.pool.query(
      `UPDATE whp_market_stripe_fulfillments SET
         state='COMPLETED',result_bytes=$3,updated_at=$4,lease_owner=NULL,lease_until=NULL
       WHERE session_id=$1 AND state='PENDING' AND lease_owner=$2 AND lease_until >= $4
       RETURNING *`,
      [sessionId, owner, resultBytes, now],
    );
    demand(result.rows[0], "STRIPE_LEASE_LOST", 409);
    return normalizedStripeRow(result.rows[0]);
  }

  async failStripe(sessionId, owner, now, retrySeconds = 300) {
    await this.pool.query(
      `UPDATE whp_market_stripe_fulfillments SET
         attempts=attempts+1,next_attempt_at=$3,updated_at=$4,lease_owner=NULL,lease_until=NULL
       WHERE session_id=$1 AND state='PENDING' AND lease_owner=$2`,
      [sessionId, owner, now + retrySeconds, now],
    );
  }
}

export async function createPostgresStore(databaseUrl, { initialize = true } = {}) {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  const store = new PostgresPurchaseStore(pool);
  if (initialize) await store.init();
  return store;
}
