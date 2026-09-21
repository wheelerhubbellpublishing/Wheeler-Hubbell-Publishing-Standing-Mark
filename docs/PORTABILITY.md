# Portability boundary

The canonical repository contains one application and no infrastructure-owned behavior.

`handleRequest(service, request)` accepts a standard `Request` and returns a standard `Response`. Every transport adapter must call it without changing route order, request bytes, headers, response bytes, authority, payment terms, or error behavior.

Infrastructure may supply only:

- the canonical public origin;
- the current signed trust bundle and independently admitted root pin;
- the authorized issuer signing key;
- durable database connectivity;
- a separately administered, append-only monotonic-witness database and out-of-band witness identity pin;
- payment facilitator and chain RPC connectivity;
- process-level port and lifecycle controls.

Infrastructure may not supply defaults for protocol meaning, issuer identity, payment recipient, asset, network, amount, profile, schema, verifier, or evaluation rules.

Origin-bearing discovery documents are generated at runtime from `WHP_ORIGIN`. Signed deployment or authority acts that name an origin are operational inputs, not source-code assumptions.

The server owns every required machine route and committed artifact. Static-file publishing, rewrites, implicit environment aliases, temporary storage, and provider-managed database discovery are not required for correct behavior.

The witness uses ordinary PostgreSQL semantics and carries no infrastructure-vendor API. Its deployment must still remain independent from the operational purchase database: separate database identity, runtime credentials limited to `SELECT`/`INSERT`, and separate administration and restore control. A second connection string without that operational separation does not establish the anti-rollback claim.
