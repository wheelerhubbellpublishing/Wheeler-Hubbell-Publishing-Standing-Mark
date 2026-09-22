# WHP Base USDC Settlement Observer

This is an isolated, read-only Node 22 observer for finalized Base mainnet USDC
`Transfer` events whose recipient is the fixed WHP payee:

- Network: Base mainnet (`eip155:8453`)
- USDC: `0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913`
- WHP payee: `0x1050eddd8282623b0c263ed6bdbd42370bbc28d3`

It never holds a wallet key, never submits a transaction, and never watches or
claims to watch the mempool. It asks the RPC endpoint for the `finalized` block,
scans only through that block, and atomically stores matching logs and the scan
cursor in PostgreSQL.

## Honest event classification

The observed fact is a finalized inbound Base USDC transfer. A matching transfer
can be produced by x402 or by an ordinary direct transfer, so the observer does
not label the event as proven x402 settlement without application-level
correlation data. The public API and webhook call it
`base.usdc.transfer.finalized`.

## Run

Copy `.env.example` values into the deployment environment, then:

```sh
npm install
npm test
npm start
```

The normal suite uses a mocked RPC. To exercise the real migration,
transactional cursor/event write, query surface, and webhook lease against a
disposable PostgreSQL database, set `TEST_DATABASE_URL` and run
`npm run test:postgres`.

For a Railway Cron job that scans once, retries due webhooks, and exits cleanly:

```sh
npm run run:once
```

On a new database, omitting `START_BLOCK` scans the current finalized block once,
then continues forward. This avoids an accidental full-chain scan without
creating a gap at the initialization head. Set `START_BLOCK` to a known block
number to request an intentional backfill from that block inclusive.

## HTTP routes

- `GET /health` or `GET /health/live` — process liveness
- `GET /health/ready` — initialized and at least one successful scan
- `GET /status` — runtime state, durable cursor, counts, and latest event
- `GET /events?limit=20` — newest public events, capped at 100

`src/queries.mjs` exports `getObserverStatus`, `getLatestSettlementEvent`, and
`listLatestSettlementEvents`. Another server can import those functions and pass
its existing `pg` pool without starting this observer's HTTP process.

## Webhook behavior

If `WEBHOOK_URL` is set, the observer POSTs only after the event and cursor have
committed to PostgreSQL. Delivery is at least once and uses the stable event key
as the `Idempotency-Key` header. Failed attempts remain durable and retry with
bounded exponential backoff. The receiver must deduplicate by that key.
Database leases prevent overlapping observer instances from intentionally
delivering the same row at the same time. As with every at-least-once system, a
process crash after a successful POST but before the acknowledgement commit can
still produce a retry.

No webhook is required for observation. `WEBHOOK_URL` must be HTTPS.
