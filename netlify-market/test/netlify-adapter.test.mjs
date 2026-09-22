import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMarketService } from "../src/market/app.mjs";
import { runtimeConfiguration } from "../src/market/config.mjs";
import { MemoryPurchaseStore } from "../src/market/store.mjs";
import { createMarketHandler } from "../src/market-runtime.mjs";
import { databaseConnectionString, MARKET_ENV_NAMES, readNetlifyEnvironment } from "../src/netlify-env.mjs";
import { FREE_EPT, freeEptDiscovery } from "../src/ept.mjs";

const stripeEnv = {
  WHP_MARKET_ORIGIN: "https://market.example",
  DATABASE_URL: "postgresql://user:pass@db.example/market",
  STRIPE_WEBHOOK_SECRET: "whsec_live_secret_123",
  STRIPE_PAYMENT_LINK_ID: "plink_live_snapshot_123",
  STRIPE_CHECKOUT_URL: "https://buy.stripe.com/snapshot",
};

function serviceFor(config, { rail = null } = {}) {
  return createMarketService({
    origin: config.origin,
    products: config.products,
    store: new MemoryPurchaseStore(),
    rail,
    engines: {
      snapshot: async () => ({ version: "snapshot" }),
      readiness: async () => ({ version: "readiness" }),
    },
    stripe: config.stripe ? { ...config.stripe, client: { webhooks: {} } } : null,
    x402Enabled: config.x402Enabled,
  });
}

test("Netlify environment mapping is explicit and does not sweep unrelated secrets", () => {
  const source = Object.fromEntries(MARKET_ENV_NAMES.map((name) => [name, `value:${name}`]));
  source.UNRELATED_SECRET = "must-not-pass";
  const env = readNetlifyEnvironment((name) => source[name]);
  assert.equal(env.WHP_MARKET_ORIGIN, "value:WHP_MARKET_ORIGIN");
  assert.equal(Object.hasOwn(env, "UNRELATED_SECRET"), false);
  assert.deepEqual(Object.keys(env).sort(), [...MARKET_ENV_NAMES].sort());
});

test("Netlify Database connection strings are validated before use", () => {
  assert.equal(
    databaseConnectionString(() => "postgresql://user:pass@db.example/market"),
    "postgresql://user:pass@db.example/market",
  );
  assert.throws(() => databaseConnectionString(() => "https://db.example/market"), /invalid connection string/u);
  assert.throws(() => databaseConnectionString(() => "not a URL"), /invalid connection string/u);
});

test("Netlify automatic migration uses the supported directory layout", async () => {
  const migration = await readFile(
    new URL("../netlify/database/migrations/0001_market/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS whp_market_purchases/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS whp_market_stripe_fulfillments/u);
});

test("complimentary EPT discovery stays commit-locked, optional, and checkout-independent", () => {
  assert.equal(FREE_EPT.download_url, "https://raw.githubusercontent.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/0daf1eec3f13b053e648a54f8f1b91bc377a46e3/public/free/ept/N001_The_Elemental_Properties_of_True_First_Edition.pdf");
  assert.equal(FREE_EPT.manifest_url, "https://raw.githubusercontent.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/0daf1eec3f13b053e648a54f8f1b91bc377a46e3/public/free/ept/manifest.json");
  assert.equal(FREE_EPT.sha256, "b1d6297ab5bf1a0c2c3ee7e28531285fdfdb6b974513102700d2f24d43feb1ef");
  assert.equal(new URL(FREE_EPT.download_url).search, "");
  assert.equal(new URL(FREE_EPT.manifest_url).search, "");
  assert.deepEqual(
    Object.fromEntries(Object.entries(freeEptDiscovery()).filter(([key]) => ["free", "optional", "checkout_required", "engagement_required", "tracking_parameters_attached"].includes(key))),
    {
      free: true,
      optional: true,
      checkout_required: false,
      engagement_required: false,
      tracking_parameters_attached: false,
    },
  );
});

test("root page states the one-time purchase, delivery, contents, and limits without dark patterns", async () => {
  const service = serviceFor(runtimeConfiguration(stripeEnv));
  const response = await service.handle(new Request("https://market.example/"));
  const html = await response.text();
  assert.match(html, /One-time snapshot — \$25/u);
  assert.match(html, /Enter one public HTTPS URL in checkout/u);
  assert.match(html, /verified signed webhook/u);
  assert.match(html, /may briefly show <strong>pending<\/strong>/u);
  assert.match(html, /Reachability and redirect observations/u);
  assert.match(html, /Structured JSON and a readable Markdown report/u);
  assert.match(html, /Payment does not purchase a favorable finding/u);
  assert.match(html, /not WHP Standing, proof of truth, a security certification, legal advice, or an endorsement/u);
  assert.match(html, /Free optional EPT copy/u);
  assert.match(html, /href="\/market\.css"/u);
  assert.doesNotMatch(html, /<script|<form|<input|target="_blank"|countdown/iu);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'; style-src 'self'/u);
});

test("Stripe-only mode withholds every x402 route and claim but keeps card discovery", async () => {
  const config = runtimeConfiguration(stripeEnv);
  const service = serviceFor(config);

  const x402 = await service.handle(new Request("https://market.example/.well-known/x402"));
  assert.equal(x402.status, 404);
  const x402Preflight = await service.handle(new Request("https://market.example/.well-known/x402", { method: "OPTIONS" }));
  assert.equal(x402Preflight.status, 404);
  const paidRoute = await service.handle(new Request("https://market.example/v1/readiness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.org/", client_reference: "a".repeat(64) }),
  }));
  assert.equal(paidRoute.status, 404);
  const paidPreflight = await service.handle(new Request("https://market.example/v1/readiness", { method: "OPTIONS" }));
  assert.equal(paidPreflight.status, 404);

  const openapi = await (await service.handle(new Request("https://market.example/openapi.json"))).json();
  assert.equal(Object.hasOwn(openapi.paths, "/v1/readiness"), false);
  assert.equal(Object.hasOwn(openapi.paths, "/v1/snapshots"), false);
  assert.equal(Object.hasOwn(openapi.paths, "/v1/purchases/{purchase_id}/result"), false);
  assert.equal(Object.hasOwn(openapi.paths, "/webhooks/stripe"), true);

  const llms = await (await service.handle(new Request("https://market.example/llms.txt"))).text();
  assert.doesNotMatch(llms, /USDC|PAYMENT-SIGNATURE|facilitator|\/v1\/readiness/u);
  assert.match(llms, /25 USD card checkout/u);
  assert.match(llms, new RegExp(FREE_EPT.sha256, "u"));
  assert.match(llms, new RegExp(FREE_EPT.download_url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(llms, new RegExp(FREE_EPT.manifest_url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const card = await (await service.handle(new Request("https://market.example/.well-known/agent-card.json"))).json();
  assert.equal(card.name, "WHP Public Interface Integrity Market");
  assert.equal(card.skills.length, 1);
  assert.equal(card.skills[0].id, "whp-snapshot-card");
  assert.equal(card.skills[0].cardCheckoutUrl, stripeEnv.STRIPE_CHECKOUT_URL);
  assert.doesNotMatch(JSON.stringify(card), /x402/u);
  assert.equal(card.extensions["whp-free-ept"].download_url, FREE_EPT.download_url);
  assert.equal(card.extensions["whp-free-ept"].manifest_url, FREE_EPT.manifest_url);
  assert.equal(card.extensions["whp-free-ept"].sha256, FREE_EPT.sha256);
  assert.equal(card.extensions["whp-free-ept"].checkout_required, false);
  assert.equal(card.extensions["whp-free-ept"].engagement_required, false);

  const a2a = await (await service.handle(new Request("https://market.example/a2a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "one", method: "message/send" }),
  }))).json();
  assert.equal(a2a.result.parts[1].data.offers[0].price, "25.00 USD");
  assert.equal(Object.hasOwn(a2a.result.parts[1].data.offers[0], "paid_endpoint"), false);
  assert.doesNotMatch(JSON.stringify(a2a), /x402/u);
  assert.equal(a2a.result.parts[1].data.optional_free_resource.download_url, FREE_EPT.download_url);
  assert.equal(a2a.result.parts[1].data.optional_free_resource.optional, true);

  const root = await (await service.handle(new Request("https://market.example/"))).text();
  assert.match(root, new RegExp(FREE_EPT.sha256, "u"));
  assert.match(root, /Free and optional\. No checkout or engagement is required/u);
  assert.match(root, /referrerpolicy="no-referrer"/u);
  assert.equal(new URL(FREE_EPT.download_url).search, "");
  assert.equal(new URL(FREE_EPT.manifest_url).search, "");
});

test("x402 becomes discoverable only when facilitator and RPC are configured together", async () => {
  assert.throws(() => runtimeConfiguration({
    ...stripeEnv,
    WHP_FACILITATOR_URL: "https://facilitator.example/v2/x402",
  }), /CONFIG_X402_INCOMPLETE/u);
  assert.throws(() => runtimeConfiguration({
    ...stripeEnv,
    WHP_RPC_URL: "https://rpc.example/base",
  }), /CONFIG_X402_INCOMPLETE/u);

  const config = runtimeConfiguration({
    ...stripeEnv,
    WHP_FACILITATOR_URL: "https://facilitator.example/v2/x402",
    WHP_RPC_URL: "https://rpc.example/base",
  });
  const service = serviceFor(config, { rail: {} });
  assert.equal((await service.handle(new Request("https://market.example/.well-known/x402"))).status, 200);
  const challenge = await service.handle(new Request("https://market.example/v1/readiness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.org/", client_reference: "b".repeat(64) }),
  }));
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.has("payment-required"), true);
});

test("verified Stripe enqueue schedules exactly one immediate background fulfillment", async () => {
  let runtimeCalls = 0;
  let workerArguments;
  let background;
  const store = {};
  const snapshot = async () => ({});
  const handler = createMarketHandler({
    getEnv: (name) => name === "WHP_MARKET_ORIGIN" ? "https://market.example" : undefined,
    getDatabaseUrl: () => "postgresql://user:pass@db.example/market",
    runtimeFactory: async () => {
      runtimeCalls += 1;
      return {
        service: {
          store,
          engines: { snapshot },
          handle: async () => new Response(JSON.stringify({ received: true, enqueued: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        },
      };
    },
    runWorker: async (options) => {
      workerArguments = options;
      return { claimed: 1, completed: 1, failed: 0 };
    },
  });

  const response = await handler(new Request("https://market.example/webhooks/stripe", { method: "POST" }), {
    waitUntil(promise) { background = promise; },
  });
  await background;
  assert.equal(response.status, 200);
  assert.equal(runtimeCalls, 1);
  assert.equal(workerArguments.store, store);
  assert.equal(workerArguments.engine, snapshot);
  assert.equal(workerArguments.maxOrders, 1);

  await handler(new Request("https://market.example/healthz"));
  assert.equal(runtimeCalls, 1);
});

test("a pending Stripe result poll schedules one self-healing worker without creating an order", async () => {
  let workerCalls = 0;
  let background;
  const store = { existingOrdersOnly: true };
  const snapshot = async () => ({});
  const handler = createMarketHandler({
    getEnv: () => undefined,
    getDatabaseUrl: () => "postgresql://user:pass@db.example/market",
    runtimeFactory: async () => ({
      service: {
        store,
        engines: { snapshot },
        handle: async () => new Response(JSON.stringify({
          rail: "stripe",
          state: "PENDING",
          instruction: "Retry this URL; do not purchase again.",
        }), { status: 202, headers: { "content-type": "application/json" } }),
      },
    }),
    runWorker: async (options) => {
      workerCalls += 1;
      assert.equal(options.store, store);
      assert.equal(options.maxOrders, 1);
      return { claimed: 0, completed: 0, failed: 0 };
    },
  });
  const urls = [
    "https://market.example/stripe/result?session_id=cs_live_example",
    `https://market.example/v1/stripe/results/${"c".repeat(64)}`,
  ];
  for (const url of urls) {
    background = null;
    const response = await handler(new Request(url), {
      waitUntil(promise) { background = promise; },
    });
    assert.equal(response.status, 202);
    await background;
  }
  assert.equal(workerCalls, 2);
  assert.equal(store.existingOrdersOnly, true);
});

test("adapter initialization fails closed without exposing configuration detail", async () => {
  const handler = createMarketHandler({
    getEnv: () => undefined,
    getDatabaseUrl: () => "postgresql://user:pass@db.example/market",
    runtimeFactory: async () => { throw new Error("sensitive provider detail"); },
  });
  const response = await handler(new Request("https://market.example/healthz"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "SERVICE_UNAVAILABLE", retryable: true } });
});
