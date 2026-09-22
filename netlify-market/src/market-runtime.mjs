import { createMarketService } from "./market/app.mjs";
import { runtimeConfiguration } from "./market/config.mjs";
import { jsonResponse } from "./market/core.mjs";
import { PaymentRail } from "./market/payment.mjs";
import { createReadinessEngine, createSnapshotEngine } from "./market/snapshot.mjs";
import { createSafeFetcher } from "./market/ssrf.mjs";
import { createPostgresStore } from "./market/store.mjs";
import { createStripeClient, runStripeWorkerOnce } from "./market/stripe.mjs";
import { databaseConnectionString, readNetlifyEnvironment } from "./netlify-env.mjs";

export async function createMarketRuntime({ env, databaseUrl }) {
  const config = runtimeConfiguration({ ...env, DATABASE_URL: databaseUrl });
  const store = await createPostgresStore(config.databaseUrl, { initialize: false });
  try {
    const safeFetcher = createSafeFetcher();
    const snapshot = createSnapshotEngine({ fetcher: safeFetcher });
    const readiness = createReadinessEngine({ snapshotEngine: snapshot });
    const rail = config.x402Enabled
      ? new PaymentRail({ facilitatorUrl: config.facilitatorUrl, rpcUrl: config.rpcUrl })
      : null;
    const stripe = config.stripe ? { ...config.stripe, client: createStripeClient() } : null;
    const service = createMarketService({
      origin: config.origin,
      products: config.products,
      store,
      rail,
      engines: { snapshot, readiness },
      stripe,
      x402Enabled: config.x402Enabled,
    });
    return { config, service, close: () => store.close() };
  } catch (error) {
    await store.close();
    throw error;
  }
}

function unavailable() {
  return jsonResponse(503, { error: { code: "SERVICE_UNAVAILABLE", retryable: true } });
}

export function createMarketHandler({
  getEnv,
  getDatabaseUrl,
  runtimeFactory = createMarketRuntime,
  runWorker = runStripeWorkerOnce,
  logError = (code) => console.error(JSON.stringify({ level: "error", code })),
} = {}) {
  let runtimePromise = null;

  const runtime = async () => {
    if (!runtimePromise) {
      const env = readNetlifyEnvironment(getEnv);
      const databaseUrl = databaseConnectionString(getDatabaseUrl);
      runtimePromise = Promise.resolve(runtimeFactory({ env, databaseUrl }));
      runtimePromise.catch(() => { runtimePromise = null; });
    }
    return runtimePromise;
  };

  return async function marketHandler(request, context = {}) {
    let active;
    try {
      active = await runtime();
    } catch {
      return unavailable();
    }

    const response = await active.service.handle(request);
    const pathname = new URL(request.url).pathname;
    let shouldFulfill = response.status === 202
      && (pathname === "/stripe/result" || /^\/v1\/stripe\/results\/[0-9a-f]{64}$/u.test(pathname));
    if (pathname === "/webhooks/stripe" && response.status === 200) {
      try {
        const body = await response.clone().json();
        shouldFulfill = body?.enqueued === true;
      } catch {
        shouldFulfill = false;
      }
    }
    if (!shouldFulfill) return response;

    const fulfillment = Promise.resolve(runWorker({
      store: active.service.store,
      engine: active.service.engines.snapshot,
      maxOrders: 1,
    })).catch(() => logError("STRIPE_BACKGROUND_FULFILLMENT_FAILED"));
    if (typeof context.waitUntil === "function") context.waitUntil(fulfillment);
    else await fulfillment;
    return response;
  };
}

export async function recoverOneStripeOrder({ databaseUrl }) {
  const store = await createPostgresStore(databaseUrl, { initialize: false });
  try {
    return await runStripeWorkerOnce({
      store,
      engine: createSnapshotEngine({ fetcher: createSafeFetcher() }),
      maxOrders: 1,
    });
  } finally {
    await store.close();
  }
}
