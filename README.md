# Wheeler Hubbell Publishing Standing Mark

This repository is the canonical, self-contained source for the WHP Standing machine.

Its runtime is deployment-agnostic. One fetch-native application boundary owns every machine route, and the included Node HTTP server is only a transport adapter around that boundary. Changing infrastructure does not change authority, evaluation, payment, issuance, verification, recovery, discovery, or propagation semantics.

## Finished object

The repository implements the full machine path:

`A → paid evaluation → Mark A → B verifies Mark A → B discovers WHP Standing → paid evaluation → Mark B`

The path is fail-closed and keeps these facts separate:

- payment authorizes one evaluation; it never buys a favorable result or creates authority;
- a Mark is issued only after bounded authority, deterministic evaluation, and settlement evidence all pass;
- a negative paid evaluation returns an assessment without a Mark;
- result retrieval and interrupted-settlement recovery reuse the original purchase and never create a second charge;
- an independently administered append-only witness prevents primary-database rollback from creating a second result or silently deleting a registry transition;
- each Mark carries machine-readable discovery data for independent verification and optional recursive discovery;
- recursion creates discovery and demand, never authority;
- TEST evidence never establishes LIVE operation, a sale, outside demand, or production completion.

## Canonical boundaries

- `src/app.mjs` — the only public request boundary
- `src/server.mjs` — generic Node HTTP transport
- `src/runtime.mjs` — fail-closed assembly from explicit neutral inputs
- `src/integrity.mjs` — replay, signature, settlement, result, registry, and witness validation
- `src/witness.mjs` — neutral monotonic-witness interface plus TEST and PostgreSQL adapters
- `src/` — protocol, authority, evaluator, payment, persistence, issuance, discovery, and carrier logic
- `profiles/`, `schemas/`, `public/` — committed protocol artifacts
- `verify/` — independent verifier, with no producer-module imports
- `legacy/v1/` — frozen v1 result recovery
- `test/` — conformance, recovery, propagation, payment, and portability gates

## Runtime inputs

Production startup requires explicit values for:

- `WHP_ORIGIN`
- `WHP_ROOT_PIN`
- one of `WHP_TRUST_BUNDLE_JSON` or `WHP_TRUST_BUNDLE_FILE`
- one of `WHP_ISSUER_PRIVATE_KEY_BASE64` or `WHP_ISSUER_PRIVATE_KEY_FILE`
- `DATABASE_URL`
- `WHP_WITNESS_DATABASE_URL` for a distinct PostgreSQL database reached with a SELECT/INSERT-only runtime role
- `WHP_WITNESS_ID`, a 256-bit lowercase hexadecimal identity pinned outside both databases
- `WHP_FACILITATOR_URL`
- `WHP_RPC_URL`

Optional values are `WHP_RESOLUTION_URL`, `WHP_CAPABILITY_CATALOG_URL`, and `PORT`.

No production authority, private key, database credential, or deployment identity is embedded in this repository. Startup validates the supplied signed trust bundle, LIVE environment, issuer identity, fixed payment terms, durable store, independent witness identity and append-only witness privileges, and rail configuration before listening.

Run the schema migration with a primary-database owner and a separately administered witness-database owner:

```sh
DATABASE_URL=postgresql://... \
WHP_WITNESS_ADMIN_DATABASE_URL=postgresql://... \
WHP_WITNESS_ID=<64-lowercase-hex> \
WHP_WITNESS_RUNTIME_ROLE=<existing-runtime-role> \
npm run migrate
```

The runtime witness role is deliberately granted only `SELECT` and `INSERT`; startup refuses `UPDATE`, `DELETE`, or `TRUNCATE` privileges. The witness database must have a different database identity and an independent administration, backup, and restore domain from `DATABASE_URL`. That operational separation is part of the security boundary: the code detects rollback of the primary database, but it does not claim protection against coordinated rollback or compromise of both stores, the issuer runtime, or its signing key.

Before a LIVE release, exercise the exact PostgreSQL runtime role against a dedicated database whose name contains `test` or `ci`:

```sh
WHP_TEST_POSTGRES_ADMIN_URL=postgresql://... \
WHP_TEST_POSTGRES_RUNTIME_URL=postgresql://... \
WHP_TEST_POSTGRES_RUNTIME_ROLE=whp_witness_runtime \
npm run check:postgres-witness
```

This integration gate proves that issuance and concurrent registry appends work with no `UPDATE` privilege. Per-purchase transaction advisory locks provide serialization; immutable uniqueness constraints and exact byte comparisons remain the conflict authority.

An existing issued database is never silently admitted into an empty witness during a request. Importing pre-existing production records requires an explicit offline audit and bootstrap procedure; this repository makes no claim that such a migration has occurred.

## Verification

Run:

```sh
python3 -m venv .runtime/verification
.runtime/verification/bin/pip install -r requirements-verification.txt
WHP_TEST_PYTHON=.runtime/verification/bin/python3 npm run check:canonical
```

The cold verifier uses the included no-network seccomp runner. Where an OCI runtime is preferred, build the equivalent pinned generic image first:

```sh
npm run prepare:cold-sandbox
WHP_TEST_PYTHON=.runtime/verification/bin/python3 npm run check:canonical
```

The shorter command below is sufficient when the pinned Python packages are already installed in the selected interpreter:

```sh
npm run check:canonical
```

This proves the repository’s TEST and conformance claims. The in-memory and separate-file SQLite TEST witnesses prove code paths and restart behavior only, not independent production administration. A LIVE completion claim additionally requires the external finalized A-to-B execution evidence checked by `npm run check:release`.
