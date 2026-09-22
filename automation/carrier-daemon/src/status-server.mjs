import http from 'node:http';
import {SERVICE_NAME, SERVICE_VERSION} from './constants.mjs';

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('status timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(response, status, body) {
  const wire = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(wire),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(wire);
}

export function createStatusServer({repository, runtimeState, config}) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'GET') {
      json(response, 405, {error: 'method_not_allowed'});
      return;
    }
    let path;
    try {
      path = new URL(request.url ?? '/', 'http://status.invalid').pathname;
    } catch {
      json(response, 400, {error: 'invalid_request_target'});
      return;
    }
    if (path !== '/' && path !== '/healthz' && path !== '/status') {
      json(response, 404, {error: 'not_found'});
      return;
    }
    try {
      const database = await withTimeout(async () => {
        await repository.ping();
        return repository.status();
      }, config.statusTimeoutMs);
      const circuitOpen = runtimeState.breakerOpen || database.breakerOpen;
      const state = config.disabled ? 'disabled' : circuitOpen ? 'circuit_open' : 'ready';
      const body = {
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        state,
        initialized: runtimeState.initialized,
        scheduler: {
          active: runtimeState.runActive,
          interval_seconds: config.intervalMs / 1000,
          last_result: runtimeState.lastResult,
          last_completed_at: runtimeState.lastCompletedAt,
        },
        circuit_breaker: {
          open: circuitOpen,
          reason: runtimeState.breakerReason ?? database.breakerReason,
          opened_at: database.breakerOpenedAt,
        },
        contacts: {
          total: database.contactedTotal,
          legacy_seeded: database.legacySeeded,
          automated_total: database.automatedTotal,
          automated_last_24h: database.automatedLast24h,
          latest_claim: database.latestClaim,
        },
        evidence: {
          rows: database.evidenceEvents,
          latest_delivery: database.latestDelivery,
        },
        uptime_seconds: Math.floor((Date.now() - runtimeState.startedAt) / 1000),
      };
      json(response, circuitOpen || !runtimeState.initialized ? 503 : 200, body);
    } catch (error) {
      json(response, 503, {
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        state: 'unavailable',
        error: String(error?.message ?? error).slice(0, 200),
      });
    }
  });
}

export function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

export function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
