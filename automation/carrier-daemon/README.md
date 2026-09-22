# WHP EPT carrier daemon

This isolated Node 22 service discovers healthy, conformant public A2A agents that advertise a relevant unauthenticated skill whose name and description pass the conservative side-effect filter. It can issue no more than one disclosed invitation in a run. It offers the locked complimentary EPT PDF by URL; it does not attach a file or request a subsequent task, reply, signature, registration, wallet, payment, or follow-up. The invitation truthfully discloses that the single A2A `SendMessage` call itself invokes message processing and may consume endpoint compute.

The original `outreach/send-ept-intern-fleet.mjs` is not imported or modified.

## Deployment modes

Railway Cron or a combined hourly automation runner should invoke:

```sh
npm run run:once
```

Run-once mode applies the database-backed six-hour minimum interval, performs one bounded pass, prints one JSON result, closes PostgreSQL, and exits. It is safe for an hourly combined runner because five of every six hourly invocations are normally suppressed by the durable gate.

The optional always-on process is:

```sh
npm start
```

It exposes `GET /healthz` and `GET /status` on `PORT`, runs once at startup by default, and then schedules a pass every six hours. There are no HTTP mutation or send-now routes.

## Required boundary

`CARRIER_DATABASE_URL` must identify a dedicated restricted PostgreSQL runtime role for the `carrier_automation` schema. Do not supply a raw WHP Standing production superuser URL. Before the first runtime invocation, a separate carrier-only schema owner applies the migration and grants through:

```sh
npm run migrate
```

That command requires `CARRIER_MIGRATION_DATABASE_URL`, `CARRIER_RUNTIME_ROLE`, and the runtime `CARRIER_DATABASE_URL`. The migration owner and runtime role must be distinct. The runtime receives schema usage, table reads, append rights on contacts/evidence, and control-row updates; it does not own the schema or receive update, delete, truncate, or DDL rights over the immutable tables. The migration-owner credential should be present only in the migration job, not the recurring runtime service.

The service never stores a wallet secret, payment credential, Standing signing key, or response body.

## Durable controls

Before a network transmission, the service inserts the normalized hostname into `carrier_automation.contacted_hosts`. Its primary key makes a second claim impossible across processes and restarts. The migration seeds the original 19 contacted hostnames. The separately owned contact and evidence tables reject update, delete, and truncate operations through database triggers; startup verifies the expected JSON storage type, one-run index, hash constraint, ownership boundary, and enabled trigger catalog before operating.

A PostgreSQL advisory lock permits one carrier run at a time. The database gate enforces one invitation per run, a six-hour minimum interval, no more than four automated claims in a rolling 24-hour period, and a configurable lifetime ceiling. A delivery is never retried, including after timeouts or crashes.

The persistent circuit breaker opens immediately for a policy or artifact-integrity fault and after three consecutive operational run failures. `CARRIER_DISABLED=true` is an independent fail-closed operator switch. Resetting a tripped persistent breaker is intentionally not exposed over HTTP.

## Environment

`CARRIER_DATABASE_URL` and `WHP_MARKET_ORIGIN` are required at runtime. Migration-only and optional variables are documented in `.env.example`. The safety interval, one-per-run maximum, four-per-day maximum, append-only evidence behavior, and legacy seed are not environment-overridable.

## Verification

```sh
npm install
npm test
npm run check
```
