import { readFile } from "node:fs/promises";
import { getLatestSettlementEvent, getObserverStatus, listLatestSettlementEvents } from "./queries.mjs";

const migrationUrl = new URL("../migrations/001_init.sql", import.meta.url);

export class SettlementStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    const sql = await readFile(migrationUrl, "utf8");
    await this.pool.query(sql);
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async getCursor(scope) {
    const result = await this.pool.query(
      "SELECT last_finalized_block FROM settlement_observer_state WHERE scope_key = $1",
      [scope],
    );
    return result.rows[0] ? BigInt(result.rows[0].last_finalized_block) : null;
  }

  async getCheckpoint(scope) {
    const result = await this.pool.query(
      `SELECT last_finalized_block, last_reported_finalized_block,
              last_reported_finalized_hash
       FROM settlement_observer_state WHERE scope_key = $1`,
      [scope],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      cursor: BigInt(row.last_finalized_block),
      reportedFinalizedBlock: row.last_reported_finalized_block === null
        ? null
        : BigInt(row.last_reported_finalized_block),
      reportedFinalizedHash: row.last_reported_finalized_hash,
    };
  }

  async initializeCursor(config, cursor, finalized) {
    await this.pool.query(
      `INSERT INTO settlement_observer_state
         (scope_key, chain_id, token_address, payee_address, last_finalized_block,
          last_reported_finalized_block, last_reported_finalized_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scope_key) DO NOTHING`,
      [
        config.scope, config.chainId.toString(), config.tokenAddress, config.payeeAddress,
        cursor.toString(), finalized.number.toString(), finalized.hash,
      ],
    );
    return this.getCursor(config.scope);
  }

  async recordFinalizedHead(scope, blockNumber, blockHash) {
    const result = await this.pool.query(
      `UPDATE settlement_observer_state
       SET last_reported_finalized_block = $2,
           last_reported_finalized_hash = $3,
           updated_at = NOW()
       WHERE scope_key = $1
         AND (
           last_reported_finalized_block IS NULL
           OR last_reported_finalized_hash IS NULL
           OR last_reported_finalized_block < $2
           OR (
             last_reported_finalized_block = $2
             AND last_reported_finalized_hash = $3
           )
         )
       RETURNING scope_key`,
      [scope, blockNumber.toString(), blockHash],
    );
    if (result.rowCount !== 1) {
      const current = await this.getCheckpoint(scope);
      if (
        current
        && current.reportedFinalizedBlock !== null
        && current.reportedFinalizedBlock > blockNumber
      ) return;
      throw new Error("Refused to regress or replace the durable finalized checkpoint");
    }
  }

  async commitBatch(config, events, throughBlock, finalizedCheckpoint = null) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query(
        `SELECT last_finalized_block, last_reported_finalized_block,
                last_reported_finalized_hash
         FROM settlement_observer_state WHERE scope_key = $1 FOR UPDATE`,
        [config.scope],
      );
      if (!state.rows[0]) throw new Error("Observer cursor is not initialized");
      const current = BigInt(state.rows[0].last_finalized_block);
      const reportedBlock = state.rows[0].last_reported_finalized_block === null
        ? null
        : BigInt(state.rows[0].last_reported_finalized_block);
      const reportedHash = state.rows[0].last_reported_finalized_hash;

      if (
        finalizedCheckpoint
        && reportedBlock === finalizedCheckpoint.number
        && reportedHash
        && reportedHash !== finalizedCheckpoint.hash
      ) {
        throw new Error(`Refused finalized hash replacement at ${reportedBlock}`);
      }

      for (const event of events) {
        await client.query(
          `INSERT INTO settlement_events (
             event_key, scope_key, chain_id, network, token_address, token_symbol,
             token_decimals, payee_address, from_address, to_address, amount_atomic,
             transaction_hash, log_index, block_number, block_hash, finality, finalized_head
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
           ) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING`,
          [
            event.eventKey, event.scope, event.chainId.toString(), event.network,
            event.tokenAddress, event.tokenSymbol, event.tokenDecimals, event.payeeAddress,
            event.fromAddress, event.toAddress, event.amountAtomic.toString(),
            event.transactionHash, event.logIndex.toString(), event.blockNumber.toString(),
            event.blockHash, event.finality, event.finalizedHead.toString(),
          ],
        );
      }

      const nextCursor = throughBlock > current ? throughBlock : current;
      const advancesCheckpoint = finalizedCheckpoint
        && (
          reportedBlock === null
          || reportedBlock < finalizedCheckpoint.number
          || (reportedBlock === finalizedCheckpoint.number && !reportedHash)
        );
      await client.query(
        `UPDATE settlement_observer_state
         SET last_finalized_block = $2,
             last_reported_finalized_block = $3,
             last_reported_finalized_hash = $4,
             updated_at = NOW()
         WHERE scope_key = $1`,
        [
          config.scope,
          nextCursor.toString(),
          advancesCheckpoint ? finalizedCheckpoint.number.toString() : reportedBlock?.toString() ?? null,
          advancesCheckpoint ? finalizedCheckpoint.hash : reportedHash,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPendingWebhookEvents(scope, limit, leaseOwner, leaseMs) {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT event_key
         FROM settlement_events
         WHERE scope_key = $1
           AND webhook_delivered_at IS NULL
           AND webhook_next_attempt_at <= NOW()
           AND (webhook_lease_until IS NULL OR webhook_lease_until <= NOW())
         ORDER BY observed_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE settlement_events AS event
       SET webhook_lease_owner = $3,
           webhook_lease_until = NOW() + ($4 * INTERVAL '1 millisecond')
       FROM candidates
       WHERE event.event_key = candidates.event_key
       RETURNING event.*`,
      [scope, limit, leaseOwner, leaseMs],
    );
    return result.rows;
  }

  async markWebhookDelivered(eventKey, leaseOwner) {
    const result = await this.pool.query(
      `UPDATE settlement_events
       SET webhook_delivered_at = NOW(), webhook_attempts = webhook_attempts + 1,
           webhook_last_error = NULL, webhook_lease_owner = NULL,
           webhook_lease_until = NULL
       WHERE event_key = $1 AND webhook_delivered_at IS NULL
         AND webhook_lease_owner = $2`,
      [eventKey, leaseOwner],
    );
    if (result.rowCount !== 1) throw new Error("Webhook delivery lease was lost");
  }

  async markWebhookFailed(eventKey, leaseOwner, message) {
    const result = await this.pool.query(
      `UPDATE settlement_events
       SET webhook_attempts = webhook_attempts + 1,
           webhook_last_error = LEFT($2, 1000),
           webhook_next_attempt_at = NOW() +
             (LEAST(3600, POWER(2, LEAST(12, webhook_attempts))) * INTERVAL '1 second'),
           webhook_lease_owner = NULL,
           webhook_lease_until = NULL
       WHERE event_key = $1 AND webhook_delivered_at IS NULL
         AND webhook_lease_owner = $3`,
      [eventKey, message, leaseOwner],
    );
    if (result.rowCount !== 1) throw new Error("Webhook failure lease was lost");
  }

  getStatus(scope) {
    return getObserverStatus(this.pool, scope);
  }

  listLatestEvents(scope, limit) {
    return listLatestSettlementEvents(this.pool, { scope, limit });
  }

  getLatestEvent(scope) {
    return getLatestSettlementEvent(this.pool, scope);
  }
}
