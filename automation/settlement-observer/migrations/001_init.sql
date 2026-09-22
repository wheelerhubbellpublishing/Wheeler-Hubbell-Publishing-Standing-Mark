CREATE TABLE IF NOT EXISTS settlement_observer_state (
  scope_key TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  payee_address TEXT NOT NULL,
  last_finalized_block BIGINT NOT NULL CHECK (last_finalized_block >= -1),
  last_reported_finalized_block BIGINT CHECK (last_reported_finalized_block >= 0),
  last_reported_finalized_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE settlement_observer_state
  ADD COLUMN IF NOT EXISTS last_reported_finalized_block BIGINT;
ALTER TABLE settlement_observer_state
  ADD COLUMN IF NOT EXISTS last_reported_finalized_hash TEXT;

CREATE TABLE IF NOT EXISTS settlement_events (
  event_key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES settlement_observer_state(scope_key),
  chain_id BIGINT NOT NULL,
  network TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  payee_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic >= 0),
  transaction_hash TEXT NOT NULL,
  log_index BIGINT NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  finality TEXT NOT NULL CHECK (finality = 'finalized'),
  finalized_head BIGINT NOT NULL CHECK (finalized_head >= block_number),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  webhook_attempts INTEGER NOT NULL DEFAULT 0 CHECK (webhook_attempts >= 0),
  webhook_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  webhook_delivered_at TIMESTAMPTZ,
  webhook_last_error TEXT,
  webhook_lease_owner TEXT,
  webhook_lease_until TIMESTAMPTZ,
  UNIQUE (chain_id, transaction_hash, log_index)
);

ALTER TABLE settlement_events
  ADD COLUMN IF NOT EXISTS webhook_lease_owner TEXT;
ALTER TABLE settlement_events
  ADD COLUMN IF NOT EXISTS webhook_lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS settlement_events_latest_idx
  ON settlement_events (scope_key, block_number DESC, log_index DESC);

CREATE INDEX IF NOT EXISTS settlement_events_webhook_pending_idx
  ON settlement_events (webhook_next_attempt_at, observed_at)
  WHERE webhook_delivered_at IS NULL;
