import test from "node:test";
import assert from "node:assert/strict";
import { createMarketService, PURCHASE_LEASE_SECONDS } from "../src/market/app.mjs";
import { PRODUCTS, paymentRequirements } from "../src/market/config.mjs";
import { decodeBase64Json, encodeBase64Json } from "../src/market/core.mjs";
import { MemoryPurchaseStore } from "../src/market/store.mjs";

const ORIGIN = "https://market.example";
const NOW = 2_000_000_000;
const PAY_TO = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3";
const PAYER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;

function configuredProducts() {
  return Object.fromEntries(Object.entries(PRODUCTS).map(([id, product]) => [id, { ...product, requirements: paymentRequirements(PAY_TO, product.amount) }]));
}

function resource(product) {
  return { url: `${ORIGIN}${product.path}`, description: product.description, mimeType: "application/json" };
}

function paymentFor(product, overrides = {}) {
  const requirements = product.requirements;
  return {
    x402Version: 2,
    accepted: { ...requirements, ...(overrides.accepted ?? {}) },
    resource: resource(product),
    payload: {
      signature: `0x${"11".repeat(64)}1b`,
      authorization: {
        from: PAYER,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: String(NOW - 1),
        validBefore: String(NOW + 300),
        nonce: `0x${"22".repeat(32)}`,
        ...(overrides.authorization ?? {}),
      },
    },
  };
}

class FakeRail {
  constructor({ finalizes = true, settleThrows = false } = {}) {
    this.finalizes = finalizes;
    this.settleThrows = settleThrows;
    this.verifyCalls = 0;
    this.settleCalls = 0;
    this.settled = false;
  }
  async startBlock() { return 100; }
  async verify(payment) {
    this.verifyCalls += 1;
    return { isValid: true, payer: payment.payload.authorization.from };
  }
  async settle(payment) {
    this.settleCalls += 1;
    if (this.settleThrows) throw new Error("provider unavailable");
    this.settled = true;
    return { success: true, transaction: TX, network: payment.accepted.network, payer: payment.payload.authorization.from };
  }
  async reconcile(row) {
    if (!this.settled || !this.finalizes) return null;
    const authorization = row.payment_payload.payload.authorization;
    return {
      version: "WHP-X402-FINALIZED-SETTLEMENT-v1",
      network: row.requirements.network,
      asset: row.requirements.asset,
      amount: row.requirements.amount,
      payer: authorization.from.toLowerCase(),
      pay_to: authorization.to.toLowerCase(),
      nonce: authorization.nonce,
      transaction: TX,
      block_number: 101,
      block_hash: `0x${"cd".repeat(32)}`,
      finality: "finalized",
      finalized_head: { number: "0x66", hash: `0x${"ef".repeat(32)}` },
      observed_at: NOW,
    };
  }
}

function setup(options = {}) {
  const products = configuredProducts();
  const store = new MemoryPurchaseStore();
  const rail = new FakeRail(options);
  const engineCalls = { snapshot: 0, readiness: 0 };
  const engines = Object.fromEntries(Object.keys(engineCalls).map((id) => [id, async (url) => {
    engineCalls[id] += 1;
    return { version: id === "snapshot" ? "WHP-INTEGRITY-SNAPSHOT-v1" : "WHP-X402-READINESS-v1", target: { url }, markdown: `# ${id}\n`, limitations: ["Not WHP Standing or proof of truth."] };
  }]));
  let currentTime = NOW;
  const service = createMarketService({ origin: ORIGIN, products, store, rail, engines, clock: () => currentTime });
  return { service, products, store, rail, engineCalls, advance: (seconds) => { currentTime += seconds; } };
}

function body(url = "https://example.com/", reference = "33".repeat(32)) {
  return JSON.stringify({ url, client_reference: reference });
}

function post(service, path, requestBody, headers = {}) {
  return service.handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: requestBody }));
}

test("unpaid requests produce exact distinct x402 terms and Bazaar declarations", async () => {
  const { service } = setup();
  for (const [path, amount] of [["/v1/snapshots", "25000000"], ["/v1/readiness", "50000"]]) {
    const response = await post(service, path, body(undefined, path === "/v1/snapshots" ? "33".repeat(32) : "44".repeat(32)));
    assert.equal(response.status, 402);
    const terms = await response.json();
    assert.equal(terms.accepts[0].amount, amount);
    assert.equal(terms.extensions.bazaar.info.input.method, "POST");
    assert.equal(terms.extensions.bazaar.info.output.type, "json");
    assert.deepEqual(decodeBase64Json(response.headers.get("payment-required")), terms);
  }
});

test("a payment on the first sight of a request is challenged before facilitator use", async () => {
  const { service, products, rail } = setup();
  const response = await post(service, products.snapshot.path, body(), { "payment-signature": encodeBase64Json(paymentFor(products.snapshot)) });
  assert.equal(response.status, 402);
  assert.equal(rail.verifyCalls, 0);
  assert.equal(rail.settleCalls, 0);
});

test("finalized exact payment delivers once and replays the stored result without recharge", async () => {
  const { service, products, rail, engineCalls } = setup();
  const requestBody = body();
  assert.equal((await post(service, products.snapshot.path, requestBody)).status, 402);
  const signed = encodeBase64Json(paymentFor(products.snapshot));
  const paid = await post(service, products.snapshot.path, requestBody, { "payment-signature": signed });
  assert.equal(paid.status, 200, await paid.clone().text());
  const firstBytes = await paid.text();
  const result = JSON.parse(firstBytes);
  assert.equal(result.product, "snapshot");
  assert.equal(result.settlement.finality, "finalized");
  assert.equal(result.report.version, "WHP-INTEGRITY-SNAPSHOT-v1");
  assert.equal(decodeBase64Json(paid.headers.get("payment-response")).transaction, TX);
  assert.equal(rail.verifyCalls, 1);
  assert.equal(rail.settleCalls, 1);
  assert.equal(engineCalls.snapshot, 1);

  const replay = await post(service, products.snapshot.path, requestBody, { "payment-signature": signed });
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), firstBytes);
  assert.equal(rail.verifyCalls, 1);
  assert.equal(rail.settleCalls, 1);
  assert.equal(engineCalls.snapshot, 1);

  const purchaseId = result.purchase_id;
  const retrieved = await service.handle(new Request(`${ORIGIN}/v1/purchases/${purchaseId}/result`));
  assert.equal(retrieved.status, 200);
  assert.equal(await retrieved.text(), firstBytes);
});

test("facilitator success without finalized chain evidence never unlocks delivery", async () => {
  const { service, products, rail, engineCalls } = setup({ finalizes: false });
  const requestBody = body();
  const challenge = await post(service, products.snapshot.path, requestBody);
  const purchaseId = (await challenge.json()).extensions["whp-market"].info.purchase_id;
  const paid = await post(service, products.snapshot.path, requestBody, { "payment-signature": encodeBase64Json(paymentFor(products.snapshot)) });
  assert.equal(paid.status, 202);
  assert.equal((await paid.json()).additional_charge, false);
  assert.equal(engineCalls.snapshot, 0);
  assert.equal(rail.settleCalls, 1);
  const recovery = await service.handle(new Request(`${ORIGIN}/v1/purchases/${purchaseId}/recover`, { method: "POST", body: "" }));
  assert.equal(recovery.status, 202);
  assert.equal((await recovery.json()).additional_charge, false);
  assert.equal(rail.settleCalls, 1, "recovery must not create a second settlement attempt before the persisted retry time");
});

test("ordinary GET result polling advances a bound purchase after finality without another settle", async () => {
  const { service, products, rail, engineCalls } = setup({ finalizes: false });
  const requestBody = body();
  const challenge = await post(service, products.snapshot.path, requestBody);
  const purchaseId = (await challenge.json()).extensions["whp-market"].info.purchase_id;
  const paid = await post(service, products.snapshot.path, requestBody, { "payment-signature": encodeBase64Json(paymentFor(products.snapshot)) });
  assert.equal(paid.status, 202);
  rail.finalizes = true;
  const polled = await service.handle(new Request(`${ORIGIN}/v1/purchases/${purchaseId}/result`));
  assert.equal(polled.status, 200, await polled.clone().text());
  assert.equal((await polled.json()).settlement.finality, "finalized");
  assert.equal(rail.settleCalls, 1);
  assert.equal(engineCalls.snapshot, 1);
});

test("a caught settlement-provider failure stays bound and GET recovery reuses the same authorization", async () => {
  const { service, products, rail, engineCalls, advance } = setup({ settleThrows: true });
  const requestBody = body();
  const challenge = await post(service, products.snapshot.path, requestBody);
  const purchaseId = (await challenge.json()).extensions["whp-market"].info.purchase_id;
  const paid = await post(service, products.snapshot.path, requestBody, { "payment-signature": encodeBase64Json(paymentFor(products.snapshot)) });
  assert.equal(paid.status, 202);
  assert.equal((await paid.json()).additional_charge, false);
  assert.equal(rail.settleCalls, 1);
  assert.equal(engineCalls.snapshot, 0);
  rail.settleThrows = false;
  advance(31);
  const recovered = await service.handle(new Request(`${ORIGIN}/v1/purchases/${purchaseId}/result`));
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(rail.settleCalls, 2);
  assert.equal(engineCalls.snapshot, 1);
});

test("purchase lease covers the six sequential probe budgets and chain reconciliation", () => {
  assert(PURCHASE_LEASE_SECONDS >= 600);
});

test("wrong amount is rejected before verification or settlement", async () => {
  const { service, products, rail } = setup();
  const requestBody = body();
  await post(service, products.snapshot.path, requestBody);
  const wrong = paymentFor(products.snapshot, { authorization: { value: "1" } });
  const response = await post(service, products.snapshot.path, requestBody, { "payment-signature": encodeBase64Json(wrong) });
  assert.equal(response.status, 400);
  assert.equal(rail.verifyCalls, 0);
  assert.equal(rail.settleCalls, 0);
});

test("buyer reference reuse for a different target fails idempotently", async () => {
  const { service, products } = setup();
  const reference = "55".repeat(32);
  assert.equal((await post(service, products.snapshot.path, body("https://one.example.com/", reference))).status, 402);
  const conflict = await post(service, products.snapshot.path, body("https://two.example.com/", reference));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
});

test("A2A SendMessage returns both offers without performing analysis or requesting payment", async () => {
  const { service, engineCalls } = setup();
  const request = { jsonrpc: "2.0", id: "offer-1", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "What do you offer?" }] } } };
  const response = await post(service, "/a2a", JSON.stringify(request));
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.result.kind, "message");
  const data = message.result.parts.find((part) => part.kind === "data").data;
  assert.deepEqual(data.offers.map((offer) => offer.price), ["25.00 USDC", "0.05 USDC"]);
  assert.equal(data.analysis_performed, false);
  assert.equal(data.payment_requested, false);
  assert.deepEqual(engineCalls, { snapshot: 0, readiness: 0 });
});

test("discovery surfaces match the live A2A and paid routes", async () => {
  const { service } = setup();
  const card = await (await service.handle(new Request(`${ORIGIN}/.well-known/agent-card.json`))).json();
  assert.equal(card.url, `${ORIGIN}/a2a`);
  assert.equal(card.skills.length, 2);
  const x402 = await (await service.handle(new Request(`${ORIGIN}/.well-known/x402`))).json();
  assert.deepEqual(x402.resources.map((item) => item.accepts[0].amount), ["25000000", "50000"]);
  const api = await (await service.handle(new Request(`${ORIGIN}/openapi.json`))).json();
  assert(api.paths["/v1/snapshots"].post);
  assert(api.paths["/v1/readiness"].post);
  assert(api.paths["/v1/purchases/{purchase_id}/recover"].post);
  const llms = await (await service.handle(new Request(`${ORIGIN}/llms.txt`))).text();
  assert.match(llms, /finalized on-chain/u);
  assert.match(llms, /Neither product is WHP Standing/u);
});
