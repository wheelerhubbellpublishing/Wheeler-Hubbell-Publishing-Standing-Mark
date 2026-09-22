import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAY_TO, paymentRequirements, runtimeConfiguration } from "../src/config.mjs";

test("the two products have exact Base USDC prices", () => {
  const config = runtimeConfiguration({
    WHP_MARKET_ORIGIN: "https://market.example",
    WHP_FACILITATOR_URL: "https://facilitator.example/v2/x402",
    WHP_RPC_URL: "https://rpc.example/base",
    DATABASE_URL: "postgresql://user:pass@db.example/market",
    PORT: "8080",
  });
  assert.equal(config.products.snapshot.requirements.amount, "25000000");
  assert.equal(config.products.readiness.requirements.amount, "50000");
  for (const product of Object.values(config.products)) {
    assert.equal(product.requirements.network, "eip155:8453");
    assert.equal(product.requirements.asset, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(product.requirements.payTo, DEFAULT_PAY_TO);
    assert.equal(product.requirements.extra.assetTransferMethod, "eip3009");
    assert.equal(product.requirements.extra.paymentFlow, "authorization");
  }
});

test("runtime configuration fails closed without facilitator, RPC, database, or origin", () => {
  assert.throws(() => runtimeConfiguration({}), /CONFIG_WHP_MARKET_ORIGIN_REQUIRED/u);
  assert.throws(() => runtimeConfiguration({ WHP_MARKET_ORIGIN: "https://market.example" }), /CONFIG_WHP_FACILITATOR_URL_REQUIRED/u);
  assert.throws(() => runtimeConfiguration({
    WHP_MARKET_ORIGIN: "https://market.example",
    WHP_FACILITATOR_URL: "https://facilitator.example",
  }), /CONFIG_WHP_RPC_URL_REQUIRED/u);
});

test("payment requirements reject malformed recipients", () => {
  assert.throws(() => paymentRequirements("not-an-address", "25000000"));
});

test("Stripe is optional but its webhook pair and checkout URL fail closed", () => {
  const base = {
    WHP_MARKET_ORIGIN: "https://market.example",
    WHP_FACILITATOR_URL: "https://facilitator.example/v2/x402",
    WHP_RPC_URL: "https://rpc.example/base",
    DATABASE_URL: "postgresql://user:pass@db.example/market",
  };
  assert.equal(runtimeConfiguration(base).stripe, null);
  assert.throws(() => runtimeConfiguration({ ...base, STRIPE_WEBHOOK_SECRET: "whsec_test_secret_123" }), /CONFIG_STRIPE_INCOMPLETE/u);
  assert.throws(() => runtimeConfiguration({ ...base, STRIPE_PAYMENT_LINK_ID: "plink_live_123" }), /CONFIG_STRIPE_INCOMPLETE/u);
  assert.throws(() => runtimeConfiguration({ ...base, STRIPE_CHECKOUT_URL: "https:\/\/buy.stripe.com\/snapshot" }), /CONFIG_STRIPE_CHECKOUT_WITHOUT_WEBHOOK/u);
  const configured = runtimeConfiguration({
    ...base,
    STRIPE_WEBHOOK_SECRET: "whsec_test_secret_123",
    STRIPE_PAYMENT_LINK_ID: "plink_live_snapshot_123",
    STRIPE_CHECKOUT_URL: "https://buy.stripe.com/snapshot",
  });
  assert.equal(configured.stripe.paymentLinkId, "plink_live_snapshot_123");
  assert.equal(configured.stripe.checkoutUrl, "https://buy.stripe.com/snapshot");
  assert.equal(Object.hasOwn(configured.stripe, "apiKey"), false);
});
