# WHP Netlify Market Adapter

This directory is an isolated Netlify Functions adapter for the tested WHP market. It uses modern Fetch-style functions, Netlify Database, automatic SQL migrations, a fixed-price Stripe checkout fulfillment path, and an optional x402 rail.

## Published behavior

`netlify/functions/market.mjs` routes the existing health, OpenAPI, A2A, discovery, Stripe webhook/result, and optional x402 endpoints through the same `createMarketService().handle(Request)` implementation used by the standalone service. Stripe's raw webhook body reaches the unchanged signature verifier.

The default deployment is Stripe-only. In that mode, `/.well-known/x402`, `/v1/readiness`, `/v1/snapshots`, and x402 purchase recovery return `404`; OpenAPI, A2A, `llms.txt`, the agent card, health response, and homepage contain no x402 offer. Set both `WHP_FACILITATOR_URL` and `WHP_RPC_URL` to publish the x402 rail. Setting only one fails initialization with `CONFIG_X402_INCOMPLETE`.

After a verified paid Stripe event is durably enqueued, the public function calls `context.waitUntil()` to claim and fulfill at most one order immediately. A `202` response from either Stripe result route also schedules one worker, so buyer polling can self-heal a missed background attempt without creating an order or another charge. `stripe-recovery.mjs` runs once daily and also claims at most one order, providing sparse recovery without waking the managed database every five minutes.

Snapshot target and discovery requests run concurrently. Every request still uses the original DNS resolution, public-address validation, DNS pinning, TLS, redirect, response-size, and ten-second deadline controls. Duplicate target/discovery URLs are fetched once and reused.

The root page, `llms.txt`, and A2A discovery also expose the commit-locked complimentary EPT PDF, manifest, and SHA-256 as an optional inbound resource. The links carry no tracking parameters or checkout dependency and request no engagement.

The root page is a semantic, script-free explanation of the $25 one-time card flow, report contents, pending state, and explicit limitations. Its only client asset is a same-origin stylesheet; there are no analytics, popups, countdowns, email capture, or forms.

## Netlify Database

The schema is in `netlify/database/migrations/0001_market/migration.sql`. Netlify applies this migration before publishing a production or preview deploy. Runtime code obtains the branch-correct connection string with `@netlify/database` and calls the existing PostgreSQL store with runtime DDL disabled.

Enable Netlify Database for the site before publishing. Netlify Database is currently available on credit-based plans and can consume compute and bandwidth credits when awake.

## Function environment

Required:

- `WHP_MARKET_ORIGIN`: the exact public HTTPS origin, without a path.
- `STRIPE_WEBHOOK_SECRET`: the live endpoint signing secret.
- `STRIPE_PAYMENT_LINK_ID`: the one accepted live Payment Link ID.
- `STRIPE_CHECKOUT_URL`: the public URL for that Payment Link.

Optional:

- `WHP_MARKET_PAY_TO`: defaults to `0x1050eddd8282623b0c263ed6bdbd42370bbc28d3`.
- `WHP_FACILITATOR_URL` and `WHP_RPC_URL`: optional as a pair; both are required to enable x402.

Do not set `DATABASE_URL`. Netlify Database supplies the deploy-context connection through `getConnectionString()`.

## Deliberate exclusions

The settlement observer is not scheduled here. A five-minute observer would wake Netlify Database continuously even when there is no sale, and its catch-up/RPC path cannot be guaranteed inside the scheduled-function 30-second limit.

The carrier is not included. Its repository intentionally requires a migration owner distinct from a non-owner runtime role and verifies that separation at startup. A single Netlify managed database credential cannot preserve that boundary without role creation and grants. Moving it here would weaken the tested one-touch outreach safety model.

The existing long-lived Standing service and its x402 configuration remain separate.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run audit
```

The tests include the copied market behavior suite plus adapter tests for explicit environment mapping, connection-string validation, Stripe-only discovery, paired x402 activation, one-order background fulfillment, and parallel/deduplicated snapshots.
