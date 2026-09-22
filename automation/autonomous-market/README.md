# WHP Agent/x402 Integrity Market

This is a standalone Node 22 service. It does not import, modify, deploy, or issue anything from WHP Standing.

It exposes two exact-price Base mainnet USDC products and an independent card rail for the 25 USD snapshot:

| Product | Route | Atomic USDC amount | Output |
|---|---|---:|---|
| Agent/x402 Readiness Check | `POST /v1/readiness` | `50000` (0.05 USDC) | Bounded missing-interface/readiness findings |
| Agent/x402 Integrity Snapshot | `POST /v1/snapshots` | `25000000` (25 USDC) | Deterministic JSON plus embedded Markdown |

The card rail uses a Stripe-hosted Payment Link for exactly 25.00 USD. It cannot purchase the readiness product and never shares a charge or recovery identity with x402.

Both accept one public HTTPS URL. Neither product is WHP Standing, a Standing Mark, proof of truth, a security certification, or legal advice. Payment buys the bounded output and cannot buy a favorable finding.

## Runtime

```text
Node >= 22.16
npm install
npm test
npm start
```

Required environment:

```text
WHP_MARKET_ORIGIN=https://the-public-market-origin.example
DATABASE_URL=postgresql://least_privilege_market_role:...@.../...
WHP_FACILITATOR_URL=https://the-configured-cdp-compatible-facilitator.example/...
WHP_RPC_URL=https://a-trusted-base-mainnet-rpc.example/...
```

Optional environment:

```text
PORT=8080
WHP_MARKET_PAY_TO=0x1050eddd8282623b0c263ed6bdbd42370bbc28d3
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PAYMENT_LINK_ID=plink_...
STRIPE_CHECKOUT_URL=https://buy.stripe.com/...
```

`STRIPE_WEBHOOK_SECRET` and `STRIPE_PAYMENT_LINK_ID` must be supplied together. If both are absent, the Stripe webhook and result routes are disabled. `STRIPE_CHECKOUT_URL` is published in the home page, OpenAPI, agent card, A2A offer, and `llms.txt` only when explicitly configured. No Stripe API key is accepted or required: stripe-node is instantiated only for local raw-body webhook verification, and its API authenticator fails closed.

The facilitator and RPC URLs fail closed if absent. The default payment destination is the existing WHP Base address above. `DATABASE_URL` should use a separate, least-privilege role and schema/search path. The service creates x402 purchase state plus separate Stripe fulfillment and event ledgers.

The production start command is:

```text
node src/server.mjs
```

## Purchase and recovery

Create a cryptographically random 32-byte reference and submit it with the target URL:

```json
{
  "url": "https://agent.example/",
  "client_reference": "64 hexadecimal characters"
}
```

The first valid submission returns HTTP 402 and a standard Base64 `PAYMENT-REQUIRED` header. Resend the unchanged JSON with the signed x402 v2 envelope in `PAYMENT-SIGNATURE`.

The service verifies the exact network, token, amount, recipient, authorization window, resource, and nonce before calling the facilitator. It persists the authorization before settlement. A facilitator success response does not unlock the product. Delivery occurs only after a trusted Base RPC shows the exact EIP-3009 transaction, `AuthorizationUsed` log, and USDC `Transfer` log at finalized chain state.

If settlement or the HTTP response is uncertain, the service returns HTTP 202 with an opaque purchase ID. The buyer reuses either:

```text
GET  /v1/purchases/{purchase_id}/result
POST /v1/purchases/{purchase_id}/recover
```

Recovery uses the persisted authorization and never asks for a second payment. Completed response bytes are stored and replayed exactly.

## Stripe Payment Link and webhook

Provision the hosted Payment Link as a one-time, fixed-quantity product for exactly 25.00 USD. Disable automatic tax, Adaptive Pricing/local-currency conversion, discounts and promotion codes, optional items, adjustable quantity, and shipping collection. Add one required text custom field whose exact key is `targeturl`. The buyer puts the one public HTTPS target URL in that field.

Configure a full snapshot webhook destination, not a thin-event destination:

```text
POST https://the-public-market-origin.example/webhooks/stripe
checkout.session.completed
checkout.session.async_payment_succeeded
```

The webhook verifies Stripe's signature over the untouched bounded raw body before parsing. It then requires a live, paid, one-time Checkout Session from the configured Payment Link with `currency=usd` and `amount_total=2500`. It reuses the same URL/SSRF policy as x402, persists the Session and Event idempotently, and returns promptly without probing the target. Unsupported signed event types are acknowledged and ignored. Invalid payment facts never enqueue fulfillment.

Set the Payment Link post-payment redirect to:

```text
https://the-public-market-origin.example/stripe/result?session_id={CHECKOUT_SESSION_ID}
```

The redirect tolerates arriving before the webhook and returns retryable HTTP 202 until the Session is persisted. It then redirects to an opaque result capability. Pending results return HTTP 202 with `Retry-After`; completed response bytes are replayed exactly. A randomly generated result token is persisted with the order, so webhook-secret rotation does not strand an existing buyer.

The webhook only enqueues. Run the bounded worker on a durable schedule (for example, the isolated Railway hourly cron):

```text
MARKET_DATABASE_URL=postgresql://stripe_worker_role:...@.../...
npm run stripe:worker
```

The worker needs only the restricted `MARKET_DATABASE_URL`; do not pass the facilitator, RPC, Stripe signing secret, Stripe API credentials, or the server's broader `DATABASE_URL`. It atomically claims eligible pending rows using `FOR UPDATE SKIP LOCKED`, holds a 15-minute lease, stores one deterministic snapshot, and exits after `STRIPE_WORKER_MAX_ORDERS` (default 25). Failed probes remain recoverable after a bounded retry delay. Apply `sql/001_market.sql` with the migration owner first, then grant the worker only the required select/update permissions and sequence-free access to the two `whp_market_stripe_*` tables.

## Discovery and A2A

```text
GET  /healthz
GET  /openapi.json
GET  /.well-known/x402
GET  /.well-known/agent-card.json
GET  /llms.txt
POST /a2a
POST /webhooks/stripe                 (when enabled)
GET  /stripe/result?session_id=...    (when enabled)
GET  /v1/stripe/results/{token}       (when enabled)
```

`POST /a2a` implements JSON-RPC `message/send` (and accepts `SendMessage` and `tasks/send` aliases). It returns the two offers, scopes, prices, and paid endpoint URLs. It performs no unpaid analysis and requests no payment itself.

The two paid routes publish distinct Bazaar declarations in their 402 responses and in `/.well-known/x402`. Server-owned Bazaar metadata replaces any client-supplied extension before facilitator verification and settlement.

## Network boundary

Remote inspection is GET-only and unauthenticated. The URL boundary requires HTTPS on port 443, rejects credentials, fragments, IP literals, local/special-use hostnames, mixed public/private DNS answers, private/reserved IPv4, and non-global or special IPv6. Every redirect is revalidated. DNS is resolved once per hop, every answer is checked, and the selected public address is pinned into the TLS connection while the original hostname remains the Host/SNI identity.

Each response has fixed limits for DNS answers, redirect count, header bytes/count, body bytes, content encoding, idle time, and total time. No cookies, authorization headers, caller-selected methods, request bodies, proxies, or cloud credentials are forwarded to inspected hosts.
