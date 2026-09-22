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
);

CREATE INDEX IF NOT EXISTS whp_market_state_idx
  ON whp_market_purchases (state, next_attempt_at);

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
);

CREATE TABLE IF NOT EXISTS whp_market_stripe_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  session_id TEXT NOT NULL REFERENCES whp_market_stripe_fulfillments(session_id),
  event_type TEXT NOT NULL CHECK (event_type IN ('checkout.session.completed', 'checkout.session.async_payment_succeeded')),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS whp_market_stripe_pending_idx
  ON whp_market_stripe_fulfillments (state, next_attempt_at, created_at);
