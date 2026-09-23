# WHP Standing — public carrier

This public repository is an artifact and transport carrier for WHP Standing. It is **not** the complete executable source tree and its default branch is **not** a deployment target.

## Canonical production boundary

- Service: https://whp-standing-live-production.up.railway.app
- Readiness: https://whp-standing-live-production.up.railway.app/readyz
- Machine discovery: https://whp-standing-live-production.up.railway.app/.well-known/whp-standing.json
- x402 discovery: https://whp-standing-live-production.up.railway.app/.well-known/x402
- MCP descriptor: https://whp-standing-live-production.up.railway.app/server.json
- MCP endpoint: https://whp-standing-live-production.up.railway.app/mcp

The canonical executable source is held in `wheelerhubbell/WheelerHubbellPublishingDecisionIntegrityProtocolsStandingMark`. Production uses branch `railway-production-source-1b2d9cb`; the signed authority base is commit `1b2d9cb172d2808c8e591f5b99649ee1b8dd3ae8`.

## Branch roles

- `railway-mcp-transport` supplies the live Railway transport adapter.
- `autonomous-market` contains the market engine pinned by the WHP Vending fulfillment worker.
- `main` preserves selected public protocol artifacts and the authorized complimentary EPT publication.

Do not delete or privatize this repository while either operational branch remains in use. Do not infer that `main` contains the full application, production credentials, signing keys, settlement state, or database state.

## Public artifact

The authorized complimentary edition of *The Elemental Properties of True* is published at:

- [Artifact manifest](public/free/ept/manifest.json)
- [First-edition PDF](public/free/ept/N001_The_Elemental_Properties_of_True_First_Edition.pdf)

The manifest governs identity, integrity, and permitted use of that artifact.

## Scope

Payment authorizes one evaluation. It does not supply authority, guarantee a favorable result, or turn discovery metadata into proof of standing. Current production status is determined by the live readiness and discovery endpoints above, not by repository visibility or this README.
