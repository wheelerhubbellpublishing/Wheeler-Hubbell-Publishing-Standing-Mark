# Terminal object and claim boundary

WHP Standing is complete as a machine implementation when two isolated consumers can execute:

`A → paid evaluation → Mark A → B encounters and independently verifies Mark A → B resolves WHP Standing → paid evaluation → Mark B`

A valid execution preserves different A and B objects, authorities, tasks, payment authorizations, purchase identities, and issued results. B receives no authority from A’s Mark. B’s own task controls relevance, B independently admits authority, and WHP alone evaluates and issues B’s result.

The canonical gate also requires:

- an unpaid valid request returns HTTP 402 with complete standard payment requirements;
- unauthorized or malformed provenance cannot produce a Mark;
- payment replay and request mutation fail closed;
- a lost settlement response can recover using the same durable authorization;
- concurrent retries cause at most one settlement;
- retrieval returns the exact original bytes without another charge;
- issuance and every registry transition are committed to an independent append-only witness before becoming authoritative in the operational database;
- restoring a pre-issuance primary row recovers only the exact witnessed result, and deleting a registry tail can never be re-endorsed as ACTIVE;
- TEST and LIVE remain cryptographically and operationally distinct;
- the independent verifier rejects altered bytes, substituted roots, stale status, and authority outside its bounds;
- every discovery and acquisition route behaves identically through the canonical handler and the included HTTP server.

Passing local gates establishes implementation and TEST conformance only. Deployment, registration, LIVE settlement, sale, outside demand, issuance, and propagation are separate evidence states.

Current registry verification requires the active trust bundle to retain every REGISTRY certificate referenced by the event history for the record’s lifetime. Key rotation may add a successor, but removing historical certificates makes current status unavailable rather than allowing an older prefix to appear current.
