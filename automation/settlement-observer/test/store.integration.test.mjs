import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { SettlementStore } from "../src/store.mjs";
import { testConfig } from "./helpers.mjs";

const connectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL migration, atomic cursor/event write, public query, and webhook lease", {
  skip: !connectionString,
}, async () => {
  const ssl = process.env.TEST_DATABASE_SSL_MODE === "require"
    ? { rejectUnauthorized: false }
    : false;
  const pool = new pg.Pool({ connectionString, ssl });
  const store = new SettlementStore(pool);
  const suffix = randomUUID().replaceAll("-", "");
  const config = testConfig({ scope: `integration-${suffix}` });
  const transactionHash = `0x${suffix.padEnd(64, "0").slice(0, 64)}`;
  const eventKey = `${config.chainId}:${transactionHash}:0`;

  try {
    await store.migrate();
    await store.initializeCursor(config, 99n, {
      number: 100n,
      hash: `0x${"01".repeat(32)}`,
    });
    await store.commitBatch(config, [{
      eventKey,
      scope: config.scope,
      chainId: config.chainId,
      network: config.network,
      tokenAddress: config.tokenAddress,
      tokenSymbol: config.tokenSymbol,
      tokenDecimals: config.tokenDecimals,
      payeeAddress: config.payeeAddress,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: config.payeeAddress,
      amountAtomic: 1_000_000n,
      transactionHash,
      logIndex: 0n,
      blockNumber: 100n,
      blockHash: `0x${"02".repeat(32)}`,
      finality: "finalized",
      finalizedHead: 100n,
    }], 100n);

    assert.equal(await store.getCursor(config.scope), 100n);
    const latest = await store.getLatestEvent(config.scope);
    assert.equal(latest.eventId, eventKey);
    assert.equal(latest.amount, "1");

    const [firstClaim, secondClaim] = await Promise.all([
      store.claimPendingWebhookEvents(config.scope, 1, "integration-lease", 60000),
      store.claimPendingWebhookEvents(config.scope, 1, "other-lease", 60000),
    ]);
    assert.equal(firstClaim.length + secondClaim.length, 1);
    const winningLease = firstClaim.length === 1 ? "integration-lease" : "other-lease";
    await store.markWebhookDelivered(eventKey, winningLease);
  } finally {
    await pool.query("DELETE FROM settlement_events WHERE scope_key = $1", [config.scope]);
    await pool.query("DELETE FROM settlement_observer_state WHERE scope_key = $1", [config.scope]);
    await pool.end();
  }
});
