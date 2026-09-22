import assert from "node:assert/strict";
import test from "node:test";
import { SettlementStore } from "../src/store.mjs";
import { testConfig } from "./helpers.mjs";

function event(config) {
  return {
    eventKey: "8453:0xtx:0",
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
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: 0n,
    blockNumber: 100n,
    blockHash: `0x${"cd".repeat(32)}`,
    finality: "finalized",
    finalizedHead: 100n,
  };
}

function transactionPool({ state, failInsert = false }) {
  const calls = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT last_finalized_block")) return { rows: [state] };
      if (failInsert && sql.includes("INSERT INTO settlement_events")) {
        throw new Error("mock insert failure");
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { released = true; },
  };
  return {
    pool: { connect: async () => client },
    calls,
    wasReleased: () => released,
  };
}

test("event, cursor, and finalized checkpoint commit in one SQL transaction", async () => {
  const config = testConfig();
  const fake = transactionPool({
    state: {
      last_finalized_block: "99",
      last_reported_finalized_block: "99",
      last_reported_finalized_hash: `0x${"01".repeat(32)}`,
    },
  });
  const store = new SettlementStore(fake.pool);
  const finalized = { number: 100n, hash: `0x${"02".repeat(32)}` };
  await store.commitBatch(config, [event(config)], 100n, finalized);

  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.match(fake.calls[2].sql, /INSERT INTO settlement_events/);
  assert.match(fake.calls[3].sql, /UPDATE settlement_observer_state/);
  assert.deepEqual(fake.calls[3].params.slice(1), ["100", "100", finalized.hash]);
  assert.equal(fake.calls.at(-1).sql, "COMMIT");
  assert.equal(fake.wasReleased(), true);
});

test("a failed event insert rolls back cursor and checkpoint transaction", async () => {
  const config = testConfig();
  const fake = transactionPool({
    state: {
      last_finalized_block: "99",
      last_reported_finalized_block: "99",
      last_reported_finalized_hash: `0x${"01".repeat(32)}`,
    },
    failInsert: true,
  });
  const store = new SettlementStore(fake.pool);
  await assert.rejects(
    store.commitBatch(
      config,
      [event(config)],
      100n,
      { number: 100n, hash: `0x${"02".repeat(32)}` },
    ),
    /mock insert failure/,
  );
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(fake.wasReleased(), true);
});

test("same-height finalized hash replacement rolls the transaction back", async () => {
  const config = testConfig();
  const fake = transactionPool({
    state: {
      last_finalized_block: "100",
      last_reported_finalized_block: "100",
      last_reported_finalized_hash: `0x${"01".repeat(32)}`,
    },
  });
  const store = new SettlementStore(fake.pool);
  await assert.rejects(
    store.commitBatch(
      config,
      [],
      100n,
      { number: 100n, hash: `0x${"02".repeat(32)}` },
    ),
    /hash replacement/,
  );
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
});

test("an older concurrent finalized-head write accepts an already-newer durable checkpoint", async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      if (calls === 1) return { rowCount: 0, rows: [] };
      return {
        rows: [{
          last_finalized_block: "101",
          last_reported_finalized_block: "101",
          last_reported_finalized_hash: `0x${"03".repeat(32)}`,
        }],
      };
    },
  };
  const store = new SettlementStore(pool);
  await store.recordFinalizedHead("scope", 100n, `0x${"02".repeat(32)}`);
  assert.equal(calls, 2);
});
