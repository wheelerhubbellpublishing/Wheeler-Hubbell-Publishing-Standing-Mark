# WHP EPT Liquidity — signed offer/quote channel

Authorized 2026-09-23. Separate from Standing and from its authority, custody, databases, keys and products. Source lineage: `autonomous-market` at `ef585b8149c14051e30c2d6344ad06e138745fb6`. This isolated branch adds an offer-and-quote service; it does not change main or the earlier autonomous-market branch.

## Scope

Publishes the user-described USD 15,000 EPT bounded internal-use license payment right. Seller display name: Justin Bowen. Account debtor: Wheeler Hubbell Publishing, Inc. Both PURCHASE and SECURED_ADVANCE are supported without preference; partial funding is permitted. Upstream EPT, unrelated assets/IP, equity, guarantees, blanket liens and cross-collateralization are excluded.

The API receives cryptographically signed capital quotes without a human intake desk. It verifies the submitted signature and mechanical terms. A receipt does not accept a quote, attest the underlying account's enforceability, establish Article 12 control, identify a legal person, prove wallet control or capital availability, authorize collateral transfer, or settle funds. The service holds no wallet or Standing authority key. It does not impose a manual approval step. Quote solicitation and settlement are distinct operations; no settlement adapter or seller funding-acceptance mandate was supplied for this deployment.

## Routes

GET /liquidity/offers/ept-15000
POST /liquidity/offers/ept-15000/quote
POST /liquidity/offers/ept-15000/validate-quote
GET /liquidity/offers/ept-15000/activity
GET /liquidity/receipts/{opaque_token}
GET /.well-known/liquidity.json
GET /agents.json
GET /openapi.json
GET /schemas/quote.json
GET /llms.txt
GET /healthz
GET /readyz

Discovery is public and free. No POST sends funds, signs a financial commitment, or transfers rights. No URLs provided by a quote are fetched. No quote-list endpoint exposes lender submissions. Receipt URLs are private bearer capabilities: do not publish them.

## Signing

Fetch the offer. Remove the two response-only properties `offer_sha256` and `offer_hash_scope` to recover the hash input. Recursively sort object keys; emit JSON without whitespace, UTF-8, normal JSON escaping; arrays retain order. Only strings, booleans, null, arrays and objects are permitted: all monetary values are decimal strings, never floats. Hash canonical bytes with SHA-256. The quote binds origin, environment, offer ID/hash, nonce, every term and expiration.

Sign UTF-8 bytes of `WHP-EPT-LIQUIDITY-QUOTE/v1\n` followed by canonical JSON of `quote` using Ed25519. Submit `{quote, authorization: {scheme: 'Ed25519', public_key: {kty:'OKP', crv:'Ed25519', x:'base64url'}, signature:'128 lowercase hex characters'}}`. The public-key fingerprint is SHA-256 of the Ed25519 SPKI DER bytes. No private key is sent to the server. See test.mjs for a complete local signing fixture; its generated key and quotes are TEST FIXTURES, never capital.

Quote schema is at /schemas/quote.json; server.mjs additionally enforces arithmetic, face allocation, expiration, exclusions, chain/environment binding and signature checks. Direct borrower recourse is explicit and is not silently equated to a personal guarantee. A PURCHASE cannot conceal repayment fields. All withheld fees sum to the stated total, and gross minus withheld costs equals net. A secured advance states its own principal and total due; neither is automatically the USD 15,000 face amount.

## Durability and replay

Single replica. SQLite WAL with synchronous=FULL and an isolated persistent volume. Unique environment/key/nonce and environment/key/quote-ID bindings. Identical retries return the same receipt even after quote expiry; changed terms under the same nonce or ID return 409. TEST and LIVE do not share binding identity. Activity reports signed quotes separately from settlement; settlement count remains zero in this quote-only release.

For Railway, attach a volume at /data. `RAILWAY_VOLUME_MOUNT_PATH` must match `WHP_LIQUIDITY_DATA_DIR`. Production intake returns 503 rather than acknowledge a quote without durable storage. Discovery remains available. Use /readyz to verify intake, not merely /healthz. RAILWAY_PUBLIC_DOMAIN supplies the public origin; alternatively configure WHP_LIQUIDITY_ORIGIN explicitly. Do not supply Standing keys, custody credentials, existing databases, or seller wallet keys.

## Test/build

Node >=22.16; deployment image Node 24. No npm dependencies. `node --test test.mjs`. Tests run again inside the Docker build. Dockerfile copies only this isolated directory, never the rest of the repository. All test signatures are generated locally; no synthetic quote is posted as real capital.

Deployment target: existing Railway project WHP Autonomous Market (9ee08a8f-6a4c-4aec-b06d-c7232eaeab17), production environment d25e89de-e8e3-4e48-baa1-acc0c2076ee1. The separate protected Standing project is out of scope.

Publishing discovery does not attest registration in an external agent directory or prove any autonomous lender has fetched it. Report those later events only from actual evidence.
