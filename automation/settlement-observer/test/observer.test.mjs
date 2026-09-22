import assert from "node:assert/strict";
import test from "node:test";
import { SettlementObserver } from "../src/observer.mjs";
import { FakeStore, testConfig, transferLog } from "./helpers.mjs";

test("new observer without START_BLOCK scans the current finalized block once", async () => {
  const store = new FakeStore();
  const rpc = {
    getChainId: async () => 8453n,
    getFinalizedBlock: async () => ({ number: 100n, hash: `0x${"01".repeat(32)}` }),
    getLogs: async ({ fromBlock, toBlock }) => {
      assert.equal(fromBlock, 100n);
      assert.equal(toBlock, 100n);
      return [];
    },
  };
  const observer = new SettlementObserver({ config: testConfig(), rpc, store });
  const result = await observer.syncOnce();
  assert.equal(result.cursor, "100");
  assert.equal(result.batches, 1);
  assert.equal(store.cursor, 100n);
});

test("observer rejects an RPC endpoint on the wrong chain", async () => {
  const observer = new SettlementObserver({
    config: testConfig(),
    rpc: {
      getChainId: async () => 1n,
      getFinalizedBlock: async () => ({ number: 1n, hash: `0x${"01".repeat(32)}` }),
    },
    store: new FakeStore(),
  });
  await assert.rejects(observer.syncOnce(), /Wrong RPC chain/);
});

test("observer scans only through finalized and commits cursor with events atomically", async () => {
  const store = new FakeStore();
  const ranges = [];
  const rpc = {
    getChainId: async () => 8453n,
    getFinalizedBlock: async () => ({ number: 104n, hash: `0x${"01".repeat(32)}` }),
    getLogs: async ({ fromBlock, toBlock, topics }) => {
      ranges.push([fromBlock, toBlock, topics]);
      return fromBlock <= 101n && toBlock >= 101n ? [transferLog()] : [];
    },
  };
  const observer = new SettlementObserver({
    config: testConfig({ startBlock: 100n }),
    rpc,
    store,
  });
  const result = await observer.syncOnce();
  assert.deepEqual(ranges.map(([from, to]) => [from, to]), [[100n, 101n], [102n, 103n], [104n, 104n]]);
  assert.equal(store.cursor, 104n);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].amountAtomic, 1_000_000n);
  assert.equal(store.events[0].finality, "finalized");
  assert.equal(result.observedLogs, 1);
});

test("failed RPC batch does not advance that batch cursor", async () => {
  const store = new FakeStore();
  const rpc = {
    getChainId: async () => 8453n,
    getFinalizedBlock: async () => ({ number: 103n, hash: `0x${"01".repeat(32)}` }),
    getLogs: async ({ fromBlock }) => {
      if (fromBlock === 102n) throw new Error("mock RPC failure");
      return [];
    },
  };
  const observer = new SettlementObserver({
    config: testConfig({ startBlock: 100n }),
    rpc,
    store,
  });
  await assert.rejects(observer.syncOnce(), /mock RPC failure/);
  assert.equal(store.cursor, 101n);
});

test("a cold concurrent worker safely skips an RPC head older than the durable cursor", async () => {
  const store = new FakeStore();
  store.cursor = 105n;
  store.reportedFinalizedBlock = 105n;
  store.reportedFinalizedHash = `0x${"01".repeat(32)}`;
  const observer = new SettlementObserver({
    config: testConfig(),
    rpc: {
      getChainId: async () => 8453n,
      getFinalizedBlock: async () => ({ number: 104n, hash: `0x${"02".repeat(32)}` }),
    },
    store,
  });
  const result = await observer.syncOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "rpc-finalized-head-behind-durable-checkpoint");
  assert.equal(store.cursor, 105n);
});

test("observer fails closed if a finalized hash changes at the same height", async () => {
  const store = new FakeStore();
  store.cursor = 105n;
  store.reportedFinalizedBlock = 105n;
  store.reportedFinalizedHash = `0x${"01".repeat(32)}`;
  const observer = new SettlementObserver({
    config: testConfig(),
    rpc: {
      getChainId: async () => 8453n,
      getFinalizedBlock: async () => ({ number: 105n, hash: `0x${"02".repeat(32)}` }),
    },
    store,
  });
  await assert.rejects(observer.syncOnce(), /changed the finalized block hash/);
});

test("zero-value Transfer logs do not become settlement candidates", async () => {
  const store = new FakeStore();
  const rpc = {
    getChainId: async () => 8453n,
    getFinalizedBlock: async () => ({ number: 100n, hash: `0x${"01".repeat(32)}` }),
    getLogs: async () => [transferLog({ blockNumber: 100n, amount: 0n })],
  };
  const observer = new SettlementObserver({ config: testConfig(), rpc, store });
  const result = await observer.syncOnce();
  assert.equal(result.observedLogs, 0);
  assert.equal(store.events.length, 0);
  assert.equal(store.cursor, 100n);
});

test("observer verifies the prior durable finalized hash before accepting a higher head", async () => {
  const store = new FakeStore();
  store.cursor = 100n;
  store.reportedFinalizedBlock = 100n;
  store.reportedFinalizedHash = `0x${"01".repeat(32)}`;
  let checkedBlock;
  const observer = new SettlementObserver({
    config: testConfig(),
    rpc: {
      getChainId: async () => 8453n,
      getFinalizedBlock: async () => ({ number: 101n, hash: `0x${"02".repeat(32)}` }),
      getBlockByNumber: async (number) => {
        checkedBlock = number;
        return { number, hash: `0x${"01".repeat(32)}` };
      },
      getLogs: async () => [],
    },
    store,
  });
  await observer.syncOnce();
  assert.equal(checkedBlock, 100n);
  assert.equal(store.reportedFinalizedBlock, 101n);
  assert.equal(store.reportedFinalizedHash, `0x${"02".repeat(32)}`);
});

test("observer detects a provider chain switch after initialization", async () => {
  let chainCalls = 0;
  const observer = new SettlementObserver({
    config: testConfig(),
    rpc: {
      getChainId: async () => (++chainCalls === 1 ? 8453n : 1n),
      getFinalizedBlock: async () => ({ number: 100n, hash: `0x${"01".repeat(32)}` }),
    },
    store: new FakeStore(),
  });
  await assert.rejects(observer.syncOnce(), /Wrong RPC chain/);
});

test("a finalized-head regression within one running process fails closed", async () => {
  let finalized = 105n;
  const hashFor = (number) => `0x${number.toString(16).padStart(64, "0")}`;
  const rpc = {
    getChainId: async () => 8453n,
    getFinalizedBlock: async () => ({ number: finalized, hash: hashFor(finalized) }),
    getBlockByNumber: async (number) => ({ number, hash: hashFor(number) }),
    getLogs: async () => [],
  };
  const observer = new SettlementObserver({ config: testConfig(), rpc, store: new FakeStore() });
  await observer.syncOnce();
  finalized = 104n;
  await assert.rejects(observer.syncOnce(), /regressed during this process/);
});
