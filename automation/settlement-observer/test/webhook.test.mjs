import assert from "node:assert/strict";
import test from "node:test";
import { deliverPendingWebhooks, WebhookNotifier } from "../src/webhook.mjs";

test("webhook carries a stable idempotency key and finalized event", async () => {
  let request;
  const notifier = new WebhookNotifier({
    url: "https://example.test/hook",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });
  const row = {
    event_key: "8453:0xabc:0",
    network: "base-mainnet",
    chain_id: "8453",
    token_address: "0xtoken",
    token_symbol: "USDC",
    token_decimals: 6,
    payee_address: "0xpayee",
    from_address: "0xfrom",
    amount_atomic: "1000000",
    transaction_hash: "0xabc",
    log_index: "0",
    block_number: "100",
    block_hash: "0xdef",
    finality: "finalized",
    finalized_head: "100",
    observed_at: new Date("2026-09-22T00:00:00Z"),
  };
  await notifier.send(row);
  assert.equal(request.options.headers["idempotency-key"], row.event_key);
  const body = JSON.parse(request.options.body);
  assert.equal(body.type, "base.usdc.transfer.finalized");
  assert.equal(body.event.amount, "1");
});

test("delivery claims one row at a time and a notification failure does not abort the batch", async () => {
  const rows = [{ event_key: "one" }, { event_key: "two" }];
  const claimLimits = [];
  const delivered = [];
  const failed = [];
  const store = {
    claimPendingWebhookEvents: async (_scope, limit) => {
      claimLimits.push(limit);
      return rows.length ? [rows.shift()] : [];
    },
    markWebhookDelivered: async (eventKey) => delivered.push(eventKey),
    markWebhookFailed: async (eventKey) => failed.push(eventKey),
  };
  const notifier = {
    send: async (row) => {
      if (row.event_key === "one") throw new Error("receiver unavailable");
    },
  };

  const result = await deliverPendingWebhooks({ store, notifier, scope: "scope", limit: 2 });
  assert.deepEqual(result, { attempted: 2, delivered: 1, failed: 1 });
  assert.deepEqual(claimLimits, [1, 1]);
  assert.deepEqual(delivered, ["two"]);
  assert.deepEqual(failed, ["one"]);
});

test("an acknowledgement error is not mislabeled as a webhook-send failure", async () => {
  let claimed = false;
  let failureMarks = 0;
  const store = {
    claimPendingWebhookEvents: async () => {
      if (claimed) return [];
      claimed = true;
      return [{ event_key: "one" }];
    },
    markWebhookDelivered: async () => { throw new Error("acknowledgement failed"); },
    markWebhookFailed: async () => { failureMarks += 1; },
  };
  await assert.rejects(
    deliverPendingWebhooks({
      store,
      notifier: { send: async () => {} },
      scope: "scope",
      limit: 1,
    }),
    /acknowledgement failed/,
  );
  assert.equal(failureMarks, 0);
});
