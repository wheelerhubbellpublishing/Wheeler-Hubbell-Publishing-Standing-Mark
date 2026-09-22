import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPurchaseStore } from "../src/market/store.mjs";

const ID = "11".repeat(32);
const HASH = "22".repeat(32);

test("purchase store enforces quote identity, payment uniqueness, leases and durable state transitions", async () => {
  const store = new MemoryPurchaseStore();
  const quote = await store.createQuote({
    id: ID,
    product: "snapshot",
    request_hash: HASH,
    request_json: { url: "https://example.com/", client_reference: "33".repeat(32) },
    quote: { version: "quote" },
    requirements: { amount: "25000000" },
    bazaar: { info: {} },
    created_at: 100,
  });
  assert.equal(quote.state, "QUOTED");
  const bound = await store.bindPayment(ID, HASH, {
    payment_key: "44".repeat(32),
    payment_payload: { payload: true },
    facilitator_verification: { isValid: true },
    observed_block: 10,
  }, 101);
  assert.equal(bound.state, "PREPARED");
  assert.equal(await store.lease(ID, "owner", 102, 30), true);
  const settling = await store.mutate(ID, ["PREPARED"], { state: "SETTLING" }, 102, "owner");
  assert.equal(settling.state, "SETTLING");
  await assert.rejects(store.mutate(ID, ["PREPARED"], { state: "SETTLED" }, 102, "owner"), /PURCHASE_STATE_CONFLICT/u);
  await store.release(ID, "owner", 103);
  assert.equal((await store.get(ID)).lease_owner, null);
});
