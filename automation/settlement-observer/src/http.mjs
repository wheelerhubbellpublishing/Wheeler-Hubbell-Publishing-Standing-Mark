import http from "node:http";

function json(response, statusCode, body) {
  const data = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  response.end(data);
}

export function createHttpServer({ observer, store, config }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });

      if (url.pathname === "/health" || url.pathname === "/health/live") {
        return json(response, 200, { ok: true, service: "whp-settlement-observer" });
      }
      if (url.pathname === "/health/ready") {
        const runtime = observer.snapshot();
        const ageMs = runtime.lastSuccessAt
          ? Date.now() - new Date(runtime.lastSuccessAt).getTime()
          : null;
        const staleAfterMs = Math.max(60000, config.pollIntervalMs * 3);
        const ready = runtime.initialized
          && runtime.lastSuccessAt !== null
          && runtime.lastError === null
          && ageMs <= staleAfterMs;
        return json(response, ready ? 200 : 503, {
          ok: ready,
          stale: ageMs === null || ageMs > staleAfterMs,
          runtime,
        });
      }
      if (url.pathname === "/status") {
        const [database, latestEvent] = await Promise.all([
          store.getStatus(config.scope),
          store.getLatestEvent(config.scope),
        ]);
        return json(response, 200, {
          service: "whp-settlement-observer",
          classification: "finalized inbound USDC transfer observer",
          attributionNotice: "An inbound transfer is not, by itself, proof that x402 caused it.",
          runtime: observer.snapshot(),
          database,
          latestEvent,
        });
      }
      if (url.pathname === "/events") {
        const requested = Number.parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 20;
        const events = await store.listLatestEvents(config.scope, limit);
        return json(response, 200, { events });
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", component: "http", message: error.message }));
      return json(response, 500, { error: "internal_error" });
    }
  });
}
