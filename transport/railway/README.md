# WHP Standing Mark transport

A transport-only public gateway for the canonical WHP Standing Mark application.
It maps every incoming request to the same path under the canonical
`/__whp_transport` prefix and exposes `/mcp` without changing application
semantics or source records.

The service contains no canonical application source, credentials, keys,
database, settlement logic, or authority material.

## Run

```sh
npm start
```

Environment variables:

- `PORT` — listener port, default `8080`
- `UPSTREAM_ORIGIN` — canonical origin, defaults to the current Sites origin
- `UPSTREAM_PREFIX` — canonical transport prefix, default `/__whp_transport`

## Verify

```sh
npm test
```
