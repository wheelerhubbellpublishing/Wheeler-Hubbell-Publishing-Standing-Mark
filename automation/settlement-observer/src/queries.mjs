import { formatTokenAmount } from "./events.mjs";

function integerString(value) {
  return value === null || value === undefined ? null : String(value);
}

export function toPublicEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_key,
    network: row.network,
    chainId: integerString(row.chain_id),
    token: {
      address: row.token_address,
      symbol: row.token_symbol,
      decimals: row.token_decimals,
    },
    payee: row.payee_address,
    from: row.from_address,
    amountAtomic: String(row.amount_atomic),
    amount: formatTokenAmount(row.amount_atomic, row.token_decimals),
    transactionHash: row.transaction_hash,
    logIndex: integerString(row.log_index),
    blockNumber: integerString(row.block_number),
    blockHash: row.block_hash,
    finality: row.finality,
    finalizedHead: integerString(row.finalized_head),
    observedAt: new Date(row.observed_at).toISOString(),
  };
}

export async function getObserverStatus(pool, scope) {
  const result = await pool.query(
    `SELECT
       s.scope_key,
       s.chain_id,
       s.token_address,
       s.payee_address,
       s.last_finalized_block,
       s.last_reported_finalized_block,
       s.last_reported_finalized_hash,
       s.updated_at,
       COUNT(e.event_key)::BIGINT AS event_count,
       MAX(e.block_number)::BIGINT AS latest_event_block,
       COUNT(*) FILTER (
         WHERE e.event_key IS NOT NULL AND e.webhook_delivered_at IS NULL
       )::BIGINT AS pending_webhook_count
     FROM settlement_observer_state s
     LEFT JOIN settlement_events e ON e.scope_key = s.scope_key
     WHERE s.scope_key = $1
     GROUP BY s.scope_key, s.chain_id, s.token_address, s.payee_address,
              s.last_finalized_block, s.last_reported_finalized_block,
              s.last_reported_finalized_hash, s.updated_at`,
    [scope],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    scope: row.scope_key,
    chainId: integerString(row.chain_id),
    tokenAddress: row.token_address,
    payeeAddress: row.payee_address,
    lastFinalizedBlock: integerString(row.last_finalized_block),
    lastReportedFinalizedBlock: integerString(row.last_reported_finalized_block),
    lastReportedFinalizedHash: row.last_reported_finalized_hash,
    eventCount: integerString(row.event_count),
    latestEventBlock: integerString(row.latest_event_block),
    pendingWebhookCount: integerString(row.pending_webhook_count),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listLatestSettlementEvents(pool, { scope, limit = 20 } = {}) {
  if (!scope) throw new Error("scope is required");
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const result = await pool.query(
    `SELECT * FROM settlement_events
     WHERE scope_key = $1
     ORDER BY block_number DESC, log_index DESC
     LIMIT $2`,
    [scope, safeLimit],
  );
  return result.rows.map(toPublicEvent);
}

export async function getLatestSettlementEvent(pool, scope) {
  const events = await listLatestSettlementEvents(pool, { scope, limit: 1 });
  return events[0] || null;
}
