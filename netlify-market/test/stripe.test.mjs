import test from "node:test";
import assert from "node:assert/strict";
import { createMarketService } from "../src/market/app.mjs";
import { PRODUCTS, paymentRequirements } from "../src/market/config.mjs";
import { sha256 } from "../src/market/core.mjs";
import { MemoryPurchaseStore } from "../src/market/store.mjs";
import {
  createStripeClient,
  runStripeWorkerOnce,
} from "../src/market/stripe.mjs";

const ORIGIN = "https://market.example";
const NOW = 2_000_000_000;
const SECRET = "whsec_test_secret_1234567890";
const LINK = "plink_snapshot_live_123";
const CHECKOUT = "https://buy.stripe.com/snapshot";
const SESSION = "cs_live_snapshot_123";

function configuredProducts() {
  const payTo = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3";
  return Object.fromEntries(Object.entries(PRODUCTS).map(([id, product]) => [id, {
    ...product,
    requirements: paymentRequirements(payTo, product.amount),
  }]));
}

function stripeEvent({
  id = "evt_snapshot_123",
  type = "checkout.session.completed",
  session = {},
  event = {},
} = {}) {
  return {
    id,
    object: "event",
    type,
    livemode: true,
    data: {
      object: {
        id: SESSION,
        object: "checkout.session",
        livemode: true,
        mode: "payment",
        payment_status: "paid",
        currency: "usd",
        amount_total: 2500,
        payment_link: LINK,
        automatic_tax: { enabled: false },
        custom_fields: [{
          key: "targeturl",
          label: { type: "custom", custom: "Public HTTPS URL" },
          optional: false,
          type: "text",
          text: { value: "https://example.com/path" },
        }],
        ...session,
      },
    },
    ...event,
  };
}

function setup({ checkoutUrl = CHECKOUT } = {}) {
  const store = new MemoryPurchaseStore();
  const stripeClient = createStripeClient();
  let engineCalls = 0;
  const snapshot = async (url) => {
    engineCalls += 1;
    return {
      version: "WHP-INTEGRITY-SNAPSHOT-v1",
      target: { url },
      markdown: "# Snapshot\n",
      limitations: ["Not WHP Standing or proof of truth."],
    };
  };
  const service = createMarketService({
    origin: ORIGIN,
    products: configuredProducts(),
    store,
    rail: {},
    engines: { snapshot, readiness: async () => ({}) },
    stripe: {
      webhookSecret: SECRET,
      paymentLinkId: LINK,
      checkoutUrl,
      client: stripeClient,
    },
    clock: () => NOW,
  });
  return { service, store, stripeClient, snapshot, engineCalls: () => engineCalls };
}

async function sendEvent(context, value, { signature, raw } = {}) {
  const payload = raw ?? JSON.stringify(value);
  const header = signature ?? context.stripeClient.webhooks.generateTestHeaderString({
    payload,
    secret: SECRET,
    timestamp: NOW,
  });
  return context.service.handle(new Request(`${ORIGIN}/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  }));
}

test("Stripe verifies the untouched raw body before parsing or enqueue", async () => {
  const context = setup();
  const invalid = await sendEvent(context, null, { raw: "{not-json", signature: "t=1,v1=bad" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "STRIPE_SIGNATURE_INVALID");
  assert.equal(context.store.stripeRows.size, 0);

  const oversized = await sendEvent(context, null, { raw: "x".repeat(262_145), signature: "t=1,v1=bad" });
  assert.equal(oversized.status, 413);
  assert.equal(context.store.stripeRows.size, 0);

  const payload = JSON.stringify(stripeEvent());
  const staleHeader = context.stripeClient.webhooks.generateTestHeaderString({
    payload,
    secret: SECRET,
    timestamp: NOW - 301,
  });
  const stale = await sendEvent(context, null, { raw: payload, signature: staleHeader });
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).error.code, "STRIPE_SIGNATURE_INVALID");
  assert.equal(context.store.stripeRows.size, 0);
});

test("Stripe fulfillment rejects wrong mode, amount, link, live mode, and unsafe targets", async () => {
  const cases = [
    [stripeEvent({ session: { mode: "subscription" } }), "STRIPE_MODE_INVALID", 422],
    [stripeEvent({ session: { amount_total: 2499 } }), "STRIPE_AMOUNT_INVALID", 422],
    [stripeEvent({ session: { payment_link: "plink_other" } }), "STRIPE_PAYMENT_LINK_INVALID", 422],
    [stripeEvent({ event: { livemode: false } }), "STRIPE_LIVEMODE_REQUIRED", 422],
    [stripeEvent({ session: { custom_fields: [{ key: "targeturl", optional: false, type: "text", text: { value: "https://localhost/" } }] } }), "TARGET_HOST_INVALID", 400],
  ];
  for (const [event, code, status] of cases) {
    const context = setup();
    const response = await sendEvent(context, event);
    assert.equal(response.status, status, `${code}: ${await response.clone().text()}`);
    assert.equal((await response.json()).error.code, code);
    assert.equal(context.store.stripeRows.size, 0);
  }
});

test("duplicate and out-of-order paid events enqueue one independent Stripe order", async () => {
  const context = setup();
  const asynchronous = stripeEvent({ type: "checkout.session.async_payment_succeeded" });
  const first = await sendEvent(context, asynchronous);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).duplicate_event, false);
  assert.equal(context.engineCalls(), 0, "the webhook must return without probing the target");

  const duplicate = await sendEvent(context, asynchronous);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate_event, true);

  const reserialized = await sendEvent(context, asynchronous, { raw: JSON.stringify(asynchronous, null, 2) });
  assert.equal(reserialized.status, 200);
  assert.equal((await reserialized.json()).duplicate_event, true);

  const laterType = stripeEvent({ id: "evt_snapshot_456", type: "checkout.session.completed" });
  const later = await sendEvent(context, laterType);
  assert.equal(later.status, 200);
  assert.equal((await later.json()).duplicate_event, false);
  assert.equal(context.store.stripeRows.size, 1);
  assert.equal(context.store.stripeEvents.size, 2);
  assert.equal(context.engineCalls(), 0);
});

test("a signed unrelated Stripe event is acknowledged without touching fulfillment", async () => {
  const context = setup();
  const unrelated = stripeEvent({ id: "evt_unrelated_123", type: "customer.created" });
  const response = await sendEvent(context, unrelated);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ignored: true, received: true });
  assert.equal(context.store.stripeRows.size, 0);
  assert.equal(context.store.stripeEvents.size, 0);
});

test("the run-once worker stores one deterministic snapshot and every result replay is free", async () => {
  const context = setup();
  const accepted = await sendEvent(context, stripeEvent());
  assert.equal(accepted.status, 200);
  const token = (await context.store.getStripeBySession(SESSION)).result_token;
  assert.equal((await context.service.handle(new Request(`${ORIGIN}/v1/stripe/results/${token}`))).status, 202);

  const stats = await runStripeWorkerOnce({ store: context.store, engine: context.snapshot, clock: () => NOW, maxOrders: 10 });
  assert.deepEqual(stats, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(context.engineCalls(), 1);
  assert.equal((await context.store.getStripeBySession(SESSION)).result_token_hash, sha256(token));

  const secondRun = await runStripeWorkerOnce({ store: context.store, engine: context.snapshot, clock: () => NOW, maxOrders: 10 });
  assert.deepEqual(secondRun, { claimed: 0, completed: 0, failed: 0 });
  assert.equal(context.engineCalls(), 1);

  const postCompletionEvent = stripeEvent({ id: "evt_snapshot_after_123", type: "checkout.session.async_payment_succeeded" });
  const postCompletion = await sendEvent(context, postCompletionEvent);
  assert.equal(postCompletion.status, 200);
  assert.equal((await postCompletion.json()).enqueued, false);
  assert.deepEqual(
    await runStripeWorkerOnce({ store: context.store, engine: context.snapshot, clock: () => NOW, maxOrders: 10 }),
    { claimed: 0, completed: 0, failed: 0 },
  );
  assert.equal(context.engineCalls(), 1);

  const result = await context.service.handle(new Request(`${ORIGIN}/v1/stripe/results/${token}`));
  assert.equal(result.status, 200);
  const exactBytes = await result.text();
  const delivery = JSON.parse(exactBytes);
  assert.equal(delivery.rail, "stripe");
  assert.equal(delivery.product, "snapshot");
  assert.equal(delivery.payment.amount_total, 2500);
  assert.equal(delivery.report.version, "WHP-INTEGRITY-SNAPSHOT-v1");
  assert.equal(Object.hasOwn(delivery, "purchase_id"), false, "Stripe and x402 identities must stay separate");

  const replay = await context.service.handle(new Request(`${ORIGIN}/v1/stripe/results/${token}`));
  assert.equal(await replay.text(), exactBytes);
  assert.equal(context.engineCalls(), 1);
});

test("concurrent workers cannot claim or generate the same Stripe order twice", async () => {
  const context = setup();
  await sendEvent(context, stripeEvent());
  let releaseEngine;
  let startedEngine;
  const started = new Promise((resolve) => { startedEngine = resolve; });
  const gate = new Promise((resolve) => { releaseEngine = resolve; });
  let calls = 0;
  const slowEngine = async (url) => {
    calls += 1;
    startedEngine();
    await gate;
    return { version: "WHP-INTEGRITY-SNAPSHOT-v1", target: { url }, markdown: "# Snapshot\n", limitations: ["Not Standing."] };
  };
  const first = runStripeWorkerOnce({ store: context.store, engine: slowEngine, clock: () => NOW, maxOrders: 1 });
  await started;
  const second = await runStripeWorkerOnce({ store: context.store, engine: slowEngine, clock: () => NOW, maxOrders: 1 });
  assert.deepEqual(second, { claimed: 0, completed: 0, failed: 0 });
  releaseEngine();
  assert.deepEqual(await first, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(calls, 1);
});

test("a failed worker attempt remains queued and completes after its retry boundary", async () => {
  const context = setup();
  await sendEvent(context, stripeEvent());
  let now = NOW;
  let fail = true;
  let calls = 0;
  const recoveringEngine = async (url) => {
    calls += 1;
    if (fail) throw new Error("temporary target failure");
    return { version: "WHP-INTEGRITY-SNAPSHOT-v1", target: { url }, markdown: "# Snapshot\n", limitations: ["Not Standing."] };
  };
  assert.deepEqual(
    await runStripeWorkerOnce({ store: context.store, engine: recoveringEngine, clock: () => now, maxOrders: 1 }),
    { claimed: 1, completed: 0, failed: 1 },
  );
  const pending = await context.store.getStripeBySession(SESSION);
  assert.equal(pending.state, "PENDING");
  assert.equal(pending.attempts, 1);
  assert.equal(pending.next_attempt_at, NOW + 300);
  assert.deepEqual(
    await runStripeWorkerOnce({ store: context.store, engine: recoveringEngine, clock: () => now, maxOrders: 1 }),
    { claimed: 0, completed: 0, failed: 0 },
  );
  fail = false;
  now += 301;
  assert.deepEqual(
    await runStripeWorkerOnce({ store: context.store, engine: recoveringEngine, clock: () => now, maxOrders: 1 }),
    { claimed: 1, completed: 1, failed: 0 },
  );
  assert.equal(calls, 2);
});

test("Checkout return tolerates webhook races and redirects only to an opaque result capability", async () => {
  const context = setup();
  const early = await context.service.handle(new Request(`${ORIGIN}/stripe/result?session_id=${SESSION}`));
  assert.equal(early.status, 202);
  assert.equal(early.headers.get("retry-after"), "60");
  assert.equal(early.headers.get("refresh"), "15");

  const webhook = await sendEvent(context, stripeEvent());
  const webhookBody = await webhook.json();
  const token = (await context.store.getStripeBySession(SESSION)).result_token;
  context.service.stripe.webhookSecret = "whsec_rotated_secret_1234567890";
  const resolved = await context.service.handle(new Request(`${ORIGIN}/stripe/result?session_id=${SESSION}`, { redirect: "manual" }));
  assert.equal(resolved.status, 303);
  const location = resolved.headers.get("location");
  assert.equal(location, `${ORIGIN}/v1/stripe/results/${token}`);
  assert.equal(webhookBody.result_url, location);
  assert.doesNotMatch(location, /cs_live/u);
});

test("Stripe checkout appears in discovery only when its public URL is configured", async () => {
  const configured = setup();
  const card = await (await configured.service.handle(new Request(`${ORIGIN}/.well-known/agent-card.json`))).json();
  assert.equal(card.skills.find((skill) => skill.id === "whp-snapshot").cardCheckoutUrl, CHECKOUT);
  assert.match(await (await configured.service.handle(new Request(`${ORIGIN}/llms.txt`))).text(), /buy\.stripe\.com/u);
  assert.match(await (await configured.service.handle(new Request(`${ORIGIN}/`))).text(), /Buy the 25 USD snapshot by card/u);

  const hidden = setup({ checkoutUrl: null });
  const hiddenCard = await (await hidden.service.handle(new Request(`${ORIGIN}/.well-known/agent-card.json`))).text();
  const hiddenLlms = await (await hidden.service.handle(new Request(`${ORIGIN}/llms.txt`))).text();
  const hiddenHome = await (await hidden.service.handle(new Request(`${ORIGIN}/`))).text();
  assert.doesNotMatch(`${hiddenCard}${hiddenLlms}${hiddenHome}`, /buy\.stripe\.com/u);
});
