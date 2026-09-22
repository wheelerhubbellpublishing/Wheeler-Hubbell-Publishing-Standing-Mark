import { randomBytes } from "node:crypto";
import { FREE_EPT, freeEptDiscovery } from "../ept.mjs";
import {
  canonical,
  decodeBase64Json,
  demand,
  encodeBase64Json,
  exactKeys,
  Fault,
  jsonResponse,
  NO_STORE_HEADERS,
  parseJson,
  readRequestBody,
  readRequestBytes,
  sha256,
} from "./core.mjs";
import { PRODUCTS } from "./config.mjs";
import { validatePayment, HEX32 } from "./payment.mjs";
import { normalizePublicHttpsUrl } from "./ssrf.mjs";
import {
  STRIPE_WEBHOOK_BODY_LIMIT,
  stripeOrderFromEvent,
  verifyStripeWebhook,
} from "./stripe.mjs";

const INPUT_BODY_LIMIT = 8_192;
export const PURCHASE_LEASE_SECONDS = 900;
const PURCHASE_ID = /^[0-9a-f]{64}$/u;
const CLIENT_REFERENCE = /^[0-9a-fA-F]{64}$/u;
const STRIPE_SESSION_ID = /^cs_live_[A-Za-z0-9_]+$/u;
const STRIPE_RESULT_TOKEN = /^[0-9a-f]{64}$/u;
const STRIPE_PRODUCT_NAME = "WHP Public Interface Integrity Snapshot";
const COMMON_HEADERS = Object.freeze({
  ...NO_STORE_HEADERS,
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, payment-signature",
  "access-control-expose-headers": "payment-required, payment-response, retry-after",
});

function resource(origin, product) {
  return {
    url: `${origin}${product.path}`,
    description: product.description,
    mimeType: "application/json",
  };
}

function reportExample(product) {
  if (product.id === "readiness") {
    return {
      version: "WHP-MARKET-DELIVERY-v1",
      product: "readiness",
      report: {
        version: "WHP-X402-READINESS-v1",
        readiness: { target_publicly_reachable: true, missing_interfaces: [], full_snapshot_may_be_useful: true },
        limitations: ["Not WHP Standing or proof of truth."],
      },
    };
  }
  return {
    version: "WHP-MARKET-DELIVERY-v1",
    product: "snapshot",
    report: {
      version: "WHP-INTEGRITY-SNAPSHOT-v1",
      findings: [{ id: "target-liveness", status: "OBSERVED", statement: "The submitted URL returned HTTP 200." }],
      limitations: ["Not WHP Standing or proof of truth."],
      markdown: "# WHP Agent/x402 Integrity Snapshot\n",
    },
  };
}

export function bazaarFor(product, input) {
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: input },
      output: { type: "json", example: reportExample(product) },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json"] },
            body: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri", pattern: "^https://" },
                client_reference: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
              },
              required: ["url", "client_reference"],
              additionalProperties: false,
            },
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { type: { type: "string", const: "json" }, example: {} },
          required: ["type"],
          additionalProperties: true,
        },
      },
      required: ["input", "output"],
      additionalProperties: false,
    },
  };
}

function normalizeInput(value) {
  exactKeys(value, ["url", "client_reference"]);
  demand(CLIENT_REFERENCE.test(value.client_reference), "CLIENT_REFERENCE_INVALID");
  return {
    url: normalizePublicHttpsUrl(value.url).href,
    client_reference: value.client_reference.toLowerCase(),
  };
}

function purchaseId(product, clientReference) {
  return sha256(canonical({ domain: "WHP-MARKET-PURCHASE-v1", product, client_reference: clientReference }));
}

function challengeFor(service, row, error = "PAYMENT-SIGNATURE header is required") {
  const product = service.products[row.product];
  const paymentRequired = {
    x402Version: 2,
    error,
    resource: resource(service.origin, product),
    accepts: [row.requirements],
    extensions: {
      "whp-market": {
        info: {
          purchase_id: row.id,
          product: row.product,
          display_price: product.display_price,
          result_url: `${service.origin}/v1/purchases/${row.id}/result`,
          recover_url: `${service.origin}/v1/purchases/${row.id}/recover`,
          additional_charge: false,
          standing_or_truth_claim: false,
        },
        schema: { type: "object" },
      },
      bazaar: row.bazaar,
    },
  };
  return jsonResponse(402, paymentRequired, { ...COMMON_HEADERS, "payment-required": encodeBase64Json(paymentRequired) });
}

function pendingResponse(service, row, state = row.state) {
  return jsonResponse(202, {
    purchase_id: row.id,
    product: row.product,
    state,
    result_url: `${service.origin}/v1/purchases/${row.id}/result`,
    recover_url: `${service.origin}/v1/purchases/${row.id}/recover`,
    additional_charge: false,
    instruction: "Recover this purchase with its opaque purchase ID. Do not create or sign another payment.",
  }, { ...COMMON_HEADERS, "retry-after": "15" });
}

function paymentResponse(evidence) {
  return {
    success: true,
    transaction: evidence.transaction,
    network: evidence.network,
    payer: evidence.payer,
  };
}

function completedResponse(row) {
  demand(typeof row.result_bytes === "string", "RESULT_MISSING", 503);
  const settlement = row.settlement_evidence;
  demand(settlement?.finality === "finalized", "FINALIZED_SETTLEMENT_REQUIRED", 503);
  return new Response(`${row.result_bytes}\n`, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "payment-response": encodeBase64Json(paymentResponse(settlement)),
    },
  });
}

function stripePendingResponse(service, row = null) {
  return jsonResponse(202, {
    rail: "stripe",
    product: "snapshot",
    state: row?.state ?? "AWAITING_VERIFIED_WEBHOOK",
    additional_charge: false,
    instruction: "The paid snapshot is queued. Retry this URL; do not purchase again.",
  }, { ...COMMON_HEADERS, "retry-after": "60", refresh: "15" });
}

function stripeCompletedResponse(row) {
  demand(row.state === "COMPLETED" && typeof row.result_bytes === "string", "STRIPE_RESULT_MISSING", 503);
  return new Response(`${row.result_bytes}\n`, {
    status: 200,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

async function progress(service, initial) {
  if (initial.state === "COMPLETED") return completedResponse(initial);
  const owner = randomBytes(16).toString("hex");
  // Covers worst-case finalized-chain RPC reconciliation plus all six bounded,
  // sequential HTTPS probes. A lost HTTP connection remains recoverable from
  // persisted state; the lease only prevents concurrent workers.
  const leased = await service.store.lease(initial.id, owner, service.clock(), PURCHASE_LEASE_SECONDS);
  if (!leased) return pendingResponse(service, initial, "IN_PROGRESS");
  try {
    let row = await service.store.get(initial.id);
    let now = service.clock();
    if (row.state === "PREPARED") row = await service.store.mutate(row.id, ["PREPARED"], { state: "SETTLING" }, now, owner);
    if (row.state === "SETTLING") {
      let proof = await service.rail.reconcile(row, now);
      if (proof?.scan_only) {
        row = await service.store.mutate(row.id, ["SETTLING"], { scan_from: proof.next_scan_from }, now, owner);
        proof = null;
      }
      const authorization = row.payment_payload.payload.authorization;
      if (!proof && !row.transaction_hint && now >= row.next_attempt_at && BigInt(now) < BigInt(authorization.validBefore)) {
        row = await service.store.mutate(row.id, ["SETTLING"], {
          attempts: row.attempts + 1,
          next_attempt_at: now + 30,
        }, now, owner);
        let settled = null;
        try {
          settled = await service.rail.settle(row.payment_payload, row.requirements, row.bazaar);
        } catch {}
        now = service.clock();
        if (settled?.success === true && HEX32.test(settled.transaction ?? "")
          && settled.network === row.requirements.network
          && (!settled.payer || settled.payer.toLowerCase() === authorization.from.toLowerCase())) {
          row = await service.store.mutate(row.id, ["SETTLING"], { transaction_hint: settled.transaction.toLowerCase() }, now, owner);
        }
        proof = await service.rail.reconcile(row, now);
        if (proof?.scan_only) {
          row = await service.store.mutate(row.id, ["SETTLING"], { scan_from: proof.next_scan_from }, now, owner);
          proof = null;
        }
      }
      if (!proof) return pendingResponse(service, row, "RECONCILING_FINALIZED_SETTLEMENT");
      demand(proof.finality === "finalized"
        && proof.network === row.requirements.network
        && proof.asset.toLowerCase() === row.requirements.asset.toLowerCase()
        && proof.amount === row.requirements.amount
        && proof.pay_to.toLowerCase() === row.requirements.payTo.toLowerCase(), "SETTLEMENT_EVIDENCE_MISMATCH", 503);
      row = await service.store.mutate(row.id, ["SETTLING"], { state: "SETTLED", settlement_evidence: proof }, service.clock(), owner);
    }
    if (row.state === "SETTLED") {
      const engine = service.engines[row.product];
      demand(typeof engine === "function", "PRODUCT_ENGINE_UNAVAILABLE", 503);
      const report = await engine(row.request_json.url);
      const result = {
        version: "WHP-MARKET-DELIVERY-v1",
        purchase_id: row.id,
        product: row.product,
        additional_charge: false,
        settlement: row.settlement_evidence,
        report,
      };
      row = await service.store.mutate(row.id, ["SETTLED"], { state: "COMPLETED", result_bytes: canonical(result) }, service.clock(), owner);
    }
    return completedResponse(row);
  } finally {
    await service.store.release(initial.id, owner, service.clock());
  }
}

async function productRoute(service, request, product) {
  demand(request.method === "POST", "METHOD_NOT_ALLOWED", 405);
  demand((request.headers.get("content-type") ?? "").split(";")[0].trim() === "application/json", "CONTENT_TYPE_REQUIRED", 415);
  const input = normalizeInput(parseJson(await readRequestBody(request, INPUT_BODY_LIMIT)));
  const id = purchaseId(product.id, input.client_reference);
  const requestHash = sha256(input);
  const existingBefore = await service.store.get(id);
  const row = await service.store.createQuote({
    id,
    product: product.id,
    request_hash: requestHash,
    request_json: input,
    quote: {
      version: "WHP-MARKET-QUOTE-v1",
      purchase_id: id,
      request_hash: requestHash,
      product: product.id,
      resource: resource(service.origin, product),
      payment_requirements: product.requirements,
      charge_policy: "One exact report. Recovery and retrieval never authorize another charge.",
    },
    requirements: product.requirements,
    bazaar: bazaarFor(product, input),
    created_at: service.clock(),
  });
  demand(row.request_hash === requestHash && row.product === product.id, "IDEMPOTENCY_CONFLICT", 409);
  if (row.state === "COMPLETED") return completedResponse(row);
  const paymentHeader = request.headers.get("payment-signature");
  if (row.state !== "QUOTED") {
    if (paymentHeader) {
      const payment = decodeBase64Json(paymentHeader);
      const key = validatePayment(payment, row.requirements, resource(service.origin, product), service.clock(), { allowExpired: true });
      demand(key === row.payment_key, "PURCHASE_ALREADY_BOUND", 409);
    }
    return progress(service, row);
  }
  if (!paymentHeader || !existingBefore) return challengeFor(service, row);
  const payment = decodeBase64Json(paymentHeader);
  const paymentKey = validatePayment(payment, row.requirements, resource(service.origin, product), service.clock());
  const paymentOwner = await service.store.paymentOwner(paymentKey);
  demand(!paymentOwner || paymentOwner.id === id, "PAYMENT_REPLAY", 409);
  const observedBlock = await service.rail.startBlock();
  let verified;
  try {
    verified = await service.rail.verify(payment, row.requirements, row.bazaar);
  } catch (error) {
    if (error instanceof Fault && error.status === 402) return challengeFor(service, row, error.code);
    throw error;
  }
  const bound = await service.store.bindPayment(id, requestHash, {
    payment_key: paymentKey,
    payment_payload: payment,
    facilitator_verification: { isValid: true, payer: verified.payer.toLowerCase() },
    observed_block: observedBlock,
  }, service.clock());
  demand(bound.payment_key === paymentKey, "PURCHASE_ALREADY_BOUND", 409);
  return progress(service, bound);
}

async function purchaseRoute(service, request, pathname) {
  const resultMatch = pathname.match(/^\/v1\/purchases\/([0-9a-f]{64})\/result$/u);
  if (resultMatch && request.method === "GET") {
    const row = await service.store.get(resultMatch[1]);
    demand(row, "PURCHASE_NOT_FOUND", 404);
    if (row.state === "COMPLETED") return completedResponse(row);
    if (row.state !== "QUOTED") return progress(service, row);
    return pendingResponse(service, row);
  }
  const recoverMatch = pathname.match(/^\/v1\/purchases\/([0-9a-f]{64})\/recover$/u);
  if (recoverMatch && request.method === "POST") {
    demand((await readRequestBody(request, 1)) === "", "RECOVERY_BODY_MUST_BE_EMPTY");
    const row = await service.store.get(recoverMatch[1]);
    demand(row, "PURCHASE_NOT_FOUND", 404);
    demand(row.state !== "QUOTED", "PAYMENT_NOT_AUTHORIZED", 409);
    return progress(service, row);
  }
  return null;
}

async function stripeWebhookRoute(service, request) {
  demand(service.stripe, "NOT_FOUND", 404);
  demand(request.method === "POST", "METHOD_NOT_ALLOWED", 405);
  demand((request.headers.get("content-type") ?? "").split(";")[0].trim() === "application/json", "CONTENT_TYPE_REQUIRED", 415);
  const rawBody = await readRequestBytes(request, STRIPE_WEBHOOK_BODY_LIMIT);
  const event = verifyStripeWebhook(
    service.stripe.client,
    rawBody,
    request.headers.get("stripe-signature"),
    service.stripe.webhookSecret,
    service.clock(),
  );
  const accepted = stripeOrderFromEvent(event, rawBody, service.stripe, service.clock());
  if (!accepted) return jsonResponse(200, { received: true, ignored: true }, COMMON_HEADERS);
  const recorded = await service.store.recordStripeEvent(accepted.order, accepted.event);
  return jsonResponse(200, {
    received: true,
    enqueued: recorded.row.state !== "COMPLETED",
    duplicate_event: recorded.duplicate,
    state: recorded.row.state,
    result_url: `${service.origin}/v1/stripe/results/${recorded.row.result_token}`,
    additional_charge: false,
  }, COMMON_HEADERS);
}

async function stripeResultRoute(service, request, url) {
  const tokenMatch = url.pathname.match(/^\/v1\/stripe\/results\/([0-9a-f]{64})$/u);
  if (tokenMatch) {
    demand(service.stripe, "NOT_FOUND", 404);
    demand(["GET", "HEAD"].includes(request.method), "METHOD_NOT_ALLOWED", 405);
    demand(!url.search, "QUERY_NOT_SUPPORTED");
    const row = await service.store.getStripeByTokenHash(sha256(tokenMatch[1]));
    demand(row, "STRIPE_RESULT_NOT_FOUND", 404);
    const response = row.state === "COMPLETED" ? stripeCompletedResponse(row) : stripePendingResponse(service, row);
    if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
    return response;
  }
  if (url.pathname === "/stripe/result") {
    demand(service.stripe, "NOT_FOUND", 404);
    demand(["GET", "HEAD"].includes(request.method), "METHOD_NOT_ALLOWED", 405);
    demand([...url.searchParams.keys()].length === 1 && url.searchParams.has("session_id"), "STRIPE_SESSION_INVALID");
    const sessionId = url.searchParams.get("session_id");
    demand(STRIPE_SESSION_ID.test(sessionId ?? ""), "STRIPE_SESSION_INVALID");
    const row = await service.store.getStripeBySession(sessionId);
    if (!row) {
      const pending = stripePendingResponse(service);
      return request.method === "HEAD" ? new Response(null, { status: pending.status, headers: pending.headers }) : pending;
    }
    const token = row.result_token;
    demand(STRIPE_RESULT_TOKEN.test(token) && sha256(token) === row.result_token_hash, "STRIPE_RESULT_IDENTITY_INVALID", 503);
    return new Response(null, {
      status: 303,
      headers: { ...COMMON_HEADERS, location: `${service.origin}/v1/stripe/results/${token}` },
    });
  }
  return null;
}

function agentCard(service) {
  const x402Skills = service.x402Enabled
    ? Object.values(service.products).map((product) => ({
      id: `whp-${product.id}`,
      name: product.name,
      description: `${product.description} Price: ${product.display_price}.`,
      tags: ["x402", "agent", "integrity", product.id],
      examples: [`Inspect one public HTTPS URL through ${product.path}`],
      inputModes: ["application/json"],
      outputModes: ["application/json", "text/markdown"],
      ...(product.id === "snapshot" && service.stripe?.checkoutUrl
        ? { cardCheckoutUrl: service.stripe.checkoutUrl }
        : {}),
    }))
    : [];
  const cardSkills = !service.x402Enabled && service.stripe?.checkoutUrl
    ? [{
      id: "whp-snapshot-card",
      name: STRIPE_PRODUCT_NAME,
      description: `${PRODUCTS.snapshot.description} Price: 25.00 USD by card.`,
      tags: ["stripe", "card", "agent", "integrity", "snapshot"],
      examples: ["Purchase one public HTTPS integrity snapshot by card"],
      inputModes: ["text/plain"],
      outputModes: ["application/json", "text/markdown"],
      cardCheckoutUrl: service.stripe.checkoutUrl,
    }]
    : [];
  return {
    name: service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market",
    description: "Self-service public-interface readiness and integrity observations. No output is WHP Standing or proof of truth.",
    url: `${service.origin}/a2a`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    provider: { organization: "Wheeler Hubbell Publishing", url: service.origin },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [...x402Skills, ...cardSkills],
    extensions: { "whp-free-ept": freeEptDiscovery() },
  };
}

function a2aMessage(service, requestBody) {
  demand(requestBody.jsonrpc === "2.0" && Object.hasOwn(requestBody, "id"), "A2A_REQUEST_INVALID");
  demand(["message/send", "SendMessage", "tasks/send"].includes(requestBody.method), "A2A_METHOD_NOT_FOUND", 404);
  const offers = service.x402Enabled ? Object.values(service.products).map((product) => ({
    id: product.id,
    name: product.name,
    price: product.display_price,
    paid_endpoint: `${service.origin}${product.path}`,
    openapi: `${service.origin}/openapi.json`,
    scope: product.description,
    ...(product.id === "snapshot" && service.stripe?.checkoutUrl
      ? { card_checkout_url: service.stripe.checkoutUrl }
      : {}),
  })) : service.stripe?.checkoutUrl ? [{
    id: "snapshot-card",
    name: STRIPE_PRODUCT_NAME,
    price: "25.00 USD",
    card_checkout_url: service.stripe.checkoutUrl,
    openapi: `${service.origin}/openapi.json`,
    scope: PRODUCTS.snapshot.description,
  }] : [];
  const messageId = sha256(canonical({ domain: "WHP-A2A-OFFER-v1", request: requestBody })).slice(0, 32);
  return {
    jsonrpc: "2.0",
    id: requestBody.id,
    result: {
      kind: "message",
      messageId,
      role: "agent",
      parts: [
        { kind: "text", text: service.x402Enabled
          ? "WHP offers a 0.05 USDC readiness check and a 25 USDC integrity snapshot for one public HTTPS URL. Neither is WHP Standing or proof of truth."
          : service.stripe?.checkoutUrl
            ? "WHP offers a 25 USD card-funded integrity snapshot for one public HTTPS URL. It is not WHP Standing or proof of truth."
            : "No paid product rail is currently published." },
        { kind: "data", data: {
          offers,
          optional_free_resource: freeEptDiscovery(),
          analysis_performed: false,
          payment_requested: false,
        } },
      ],
      metadata: { service: service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market", offer_only: true },
    },
  };
}

function openapi(service) {
  const inputSchema = {
    type: "object",
    properties: {
      url: { type: "string", format: "uri", pattern: "^https://" },
      client_reference: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "Buyer-generated cryptographically random 32-byte reference encoded as hex." },
    },
    required: ["url", "client_reference"],
    additionalProperties: false,
  };
  const paths = {};
  if (service.x402Enabled) for (const product of Object.values(service.products)) paths[product.path] = { post: {
    operationId: `purchase_${product.id}`,
    summary: product.name,
    description: `${product.description} Exact price: ${product.display_price}. Submit once for a 402, then resend unchanged with PAYMENT-SIGNATURE.`,
    requestBody: { required: true, content: { "application/json": { schema: inputSchema } } },
    responses: {
      200: { description: "Finalized on-chain settlement and deterministic report delivery." },
      202: { description: "The existing authorization is reconciling. Recover without another payment." },
      402: { description: `Exact ${product.display_price} x402 payment required.` },
    },
  } };
  if (service.x402Enabled) {
    paths["/v1/purchases/{purchase_id}/result"] = { get: { summary: "Retrieve completed delivery or pending state", parameters: [{ name: "purchase_id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }], responses: { 200: { description: "Stored exact delivery." }, 202: { description: "Pending." } } } };
    paths["/v1/purchases/{purchase_id}/recover"] = { post: { summary: "Progress an already authorized purchase without another charge", parameters: [{ name: "purchase_id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }], responses: { 200: { description: "Completed." }, 202: { description: "Still reconciling." } } } };
  }
  if (service.stripe) {
    paths["/webhooks/stripe"] = { post: {
      summary: "Verify and durably enqueue a Stripe snapshot payment",
      description: "Stripe snapshot events only. The signature is verified against the untouched raw request bytes before JSON parsing.",
      parameters: [{ name: "stripe-signature", in: "header", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      responses: { 200: { description: "Verified event enqueued, duplicated, or safely ignored." }, 400: { description: "Invalid signature." }, 422: { description: "Payment facts do not match the fixed product." } },
    } };
    paths["/stripe/result"] = { get: {
      summary: "Resolve a paid Stripe Checkout Session to its opaque result URL",
      parameters: [{ name: "session_id", in: "query", required: true, schema: { type: "string", pattern: "^cs_live_" } }],
      responses: { 202: { description: "Awaiting the verified webhook." }, 303: { description: "Opaque result URL." } },
    } };
    paths["/v1/stripe/results/{token}"] = { get: {
      summary: "Retrieve or poll a Stripe-funded snapshot",
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }],
      responses: { 200: { description: "Stored exact delivery." }, 202: { description: "Queued." } },
    } };
  }
  return {
    openapi: "3.1.0",
    info: { title: service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market", version: "1.0.0", description: "Paid deterministic public-interface observations. Not WHP Standing or proof of truth." },
    servers: [{ url: service.origin }],
    paths,
    ...(service.stripe?.checkoutUrl ? { externalDocs: { description: "Card checkout for the 25 USD snapshot", url: service.stripe.checkoutUrl } } : {}),
  };
}

function llms(service) {
  const cardCheckout = service.stripe?.checkoutUrl
    ? `- 25 USD card checkout: ${service.stripe.checkoutUrl}\n- Stripe return URL template: ${service.origin}/stripe/result?session_id={CHECKOUT_SESSION_ID}\n`
    : "";
  const x402Products = service.x402Enabled
    ? `- 0.05 USDC readiness: ${service.origin}/v1/readiness\n- 25 USDC snapshot: ${service.origin}/v1/snapshots\n`
    : "";
  const x402Instructions = service.x402Enabled
    ? `Submit {"url":"https://...","client_reference":"<64 random hex>"}. The first valid request returns x402 v2 payment terms. Resend the unchanged body with PAYMENT-SIGNATURE. A facilitator response alone does not unlock delivery: WHP waits for the exact Base USDC authorization and transfer to be finalized on-chain. Recover the same purchase by its opaque purchase ID without signing or paying again.\n\n`
    : "";
  const productDisclaimer = service.x402Enabled
    ? "Neither product is WHP Standing, a Standing Mark, proof of truth, authority, security certification, or legal advice."
    : "The product is not WHP Standing, a Standing Mark, proof of truth, authority, security certification, or legal advice.";
  return `# ${service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market"}

> Self-service readiness and integrity observations for one public HTTPS URL.

Publisher: Wheeler Hubbell Publishing

${x402Products}${cardCheckout}- OpenAPI: ${service.origin}/openapi.json
- A2A card: ${service.origin}/.well-known/agent-card.json
- A2A SendMessage: ${service.origin}/a2a

## Free optional reading

- ${FREE_EPT.title}, ${FREE_EPT.edition}: ${FREE_EPT.download_url}
- Manifest: ${FREE_EPT.manifest_url}
- SHA-256: ${FREE_EPT.sha256}
- Free and optional. No checkout or engagement is required, and no tracking parameters are attached to these links.

${x402Instructions}${productDisclaimer} Payment purchases the bounded output, not a favorable finding.
`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isX402OnlyPath(pathname) {
  return pathname === "/.well-known/x402"
    || pathname === PRODUCTS.readiness.path
    || pathname === PRODUCTS.snapshot.path
    || /^\/v1\/purchases\/[0-9a-f]{64}\/(?:result|recover)$/u.test(pathname);
}

async function discoveryRoute(service, request, pathname) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: COMMON_HEADERS });
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const head = request.method === "HEAD";
  let body;
  let type = "application/json; charset=utf-8";
  if (pathname === "/healthz") {
    demand(await service.store.ping(), "DATABASE_UNAVAILABLE", 503, { retryable: true });
    body = canonical({
      status: "ok",
      service: service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market",
      version: "1.0.0",
      database: "ready",
      payment_rails: [service.stripe && "stripe", service.x402Enabled && "x402-base-usdc"].filter(Boolean),
      ...(service.x402Enabled ? { settlement_gate: "finalized-on-chain" } : {}),
    });
  }
  else if (pathname === "/openapi.json" || pathname === "/v1/openapi.json") body = canonical(openapi(service));
  else if (pathname === "/.well-known/agent-card.json" || pathname === "/.well-known/agent.json") body = canonical(agentCard(service));
  else if (pathname === "/.well-known/x402" && service.x402Enabled) body = canonical({
    version: 1,
    name: "WHP Agent/x402 Integrity Market",
    description: "Two exact-price Base USDC products; no Standing or truth claim.",
    homepage: service.origin,
    resources: Object.values(service.products).map((product) => ({
      url: `${service.origin}${product.path}`,
      method: "POST",
      description: product.description,
      accepts: [product.requirements],
      bazaar: bazaarFor(product, { url: "https://example.org/", client_reference: "0".repeat(64) }),
    })),
  });
  else if (pathname === "/llms.txt") {
    body = llms(service);
    type = "text/plain; charset=utf-8";
  } else if (pathname === "/") {
    const name = service.x402Enabled ? "WHP Agent/x402 Integrity Market" : "WHP Public Interface Integrity Market";
    const checkout = service.stripe?.checkoutUrl
      ? `<a class="primary" rel="noopener noreferrer" referrerpolicy="no-referrer" href="${escapeHtml(service.stripe.checkoutUrl)}">Buy the 25 USD snapshot by card</a><p class="quiet">One-time Stripe-hosted card checkout. No subscription.</p>`
      : `<p class="quiet">Card checkout is not currently published.</p>`;
    const machineNote = service.x402Enabled
      ? `<p class="quiet">Machine-payment options are documented in <a href="/openapi.json">OpenAPI</a>.</p>`
      : "";
    const ept = `<section aria-labelledby="ept-title"><h2 id="ept-title">Free optional EPT copy</h2><p><a rel="noopener noreferrer" referrerpolicy="no-referrer" href="${escapeHtml(FREE_EPT.download_url)}">Download ${escapeHtml(FREE_EPT.title)}</a> <span aria-hidden="true">·</span> <a rel="noopener noreferrer" referrerpolicy="no-referrer" href="${escapeHtml(FREE_EPT.manifest_url)}">View manifest</a></p><p class="hash">SHA-256: <code>${FREE_EPT.sha256}</code></p><p class="quiet">Free and optional. No checkout or engagement is required, and no tracking parameters are attached to these links.</p></section>`;
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="A one-time public-interface integrity snapshot for one public HTTPS URL."><title>${name}</title><link rel="stylesheet" href="/market.css"></head><body><a class="skip" href="#main">Skip to content</a><header><p class="eyebrow">Wheeler Hubbell Publishing</p><h1>${name}</h1><p>One bounded, automated snapshot of one public HTTPS URL.</p></header><main id="main"><section aria-labelledby="buy-title"><h2 id="buy-title">One-time snapshot — $25</h2><p>Enter one public HTTPS URL in checkout. After Stripe confirms payment through a verified signed webhook, the URL is queued for one automated snapshot.</p>${checkout}${machineNote}</section><section aria-labelledby="receive-title"><h2 id="receive-title">What you receive</h2><ul><li>Reachability and redirect observations.</li><li>Public discovery and interface observations, including agent-card, OpenAPI, llms.txt, health, and x402 surfaces when present.</li><li>Structured JSON and a readable Markdown report.</li></ul><p>The return page may briefly show <strong>pending</strong> while the snapshot runs. Refreshing that result does not create another charge.</p></section><aside aria-labelledby="limits-title"><h2 id="limits-title">Scope and limits</h2><p>The snapshot records bounded, unauthenticated public observations. Payment does not purchase a favorable finding. The result is not WHP Standing, proof of truth, a security certification, legal advice, or an endorsement.</p></aside>${ept}</main><footer><nav aria-label="Technical resources"><a href="/openapi.json">OpenAPI</a> <span aria-hidden="true">·</span> <a href="/.well-known/agent-card.json">Agent card</a> <span aria-hidden="true">·</span> <a href="/llms.txt">llms.txt</a></nav><p>No analytics, email capture, or client-side scripts are used on this page.</p></footer></body></html>`;
    type = "text/html; charset=utf-8";
  } else return null;
  const pagePolicy = pathname === "/"
    ? "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    : COMMON_HEADERS["content-security-policy"];
  return new Response(head ? null : `${body}\n`, {
    status: 200,
    headers: { ...COMMON_HEADERS, "content-security-policy": pagePolicy, "content-type": type },
  });
}

export function createMarketService({ origin, products, store, rail = null, engines, stripe = null, x402Enabled = Boolean(rail), clock = () => Math.floor(Date.now() / 1_000) }) {
  demand(/^https:\/\//u.test(origin), "SERVICE_ORIGIN_INVALID", 503);
  for (const id of Object.keys(PRODUCTS)) demand(products[id]?.requirements, "PRODUCT_CONFIGURATION_INVALID", 503);
  if (stripe) demand(typeof stripe.webhookSecret === "string"
    && typeof stripe.paymentLinkId === "string"
    && stripe.client?.webhooks, "STRIPE_CONFIGURATION_INVALID", 503);
  demand(!x402Enabled || rail, "X402_RAIL_UNAVAILABLE", 503);
  return {
    origin: origin.replace(/\/$/u, ""),
    products,
    store,
    rail,
    engines,
    stripe,
    x402Enabled,
    clock,
    async handle(request) {
      try {
        const url = new URL(request.url);
        if (!this.x402Enabled && isX402OnlyPath(url.pathname)) {
          return jsonResponse(404, { error: { code: "NOT_FOUND" } }, COMMON_HEADERS);
        }
        if (url.pathname === "/webhooks/stripe") return await stripeWebhookRoute(this, request);
        const stripeResult = await stripeResultRoute(this, request, url);
        if (stripeResult) return stripeResult;
        const discovered = await discoveryRoute(this, request, url.pathname);
        if (discovered) return discovered;
        if (url.search) throw new Fault("QUERY_NOT_SUPPORTED");
        if (url.pathname === "/a2a") {
          demand(request.method === "POST", "METHOD_NOT_ALLOWED", 405);
          demand((request.headers.get("content-type") ?? "").startsWith("application/json"), "CONTENT_TYPE_REQUIRED", 415);
          const body = parseJson(await readRequestBody(request, 65_536), "A2A_REQUEST_INVALID");
          return jsonResponse(200, a2aMessage(this, body), COMMON_HEADERS);
        }
        if (this.x402Enabled) {
          for (const product of Object.values(this.products)) if (url.pathname === product.path) return await productRoute(this, request, product);
          const purchase = await purchaseRoute(this, request, url.pathname);
          if (purchase) return purchase;
        }
        return jsonResponse(404, { error: { code: "NOT_FOUND" } }, COMMON_HEADERS);
      } catch (error) {
        if (error instanceof Fault) return jsonResponse(error.status, { error: { code: error.code, ...(error.retryable ? { retryable: true } : {}) } }, COMMON_HEADERS);
        return jsonResponse(503, { error: { code: "SERVICE_UNAVAILABLE", retryable: true } }, COMMON_HEADERS);
      }
    },
  };
}
