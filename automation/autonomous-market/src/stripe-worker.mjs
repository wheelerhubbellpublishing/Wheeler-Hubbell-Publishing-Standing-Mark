import { canonical, demand } from "./core.mjs";
import { createSnapshotEngine } from "./snapshot.mjs";
import { createSafeFetcher } from "./ssrf.mjs";
import { createPostgresStore } from "./store.mjs";
import { runStripeWorkerOnce } from "./stripe.mjs";

function workerConfiguration(env = process.env) {
  const databaseUrl = env.MARKET_DATABASE_URL;
  demand(typeof databaseUrl === "string" && databaseUrl.length > 0, "CONFIG_MARKET_DATABASE_URL_REQUIRED", 503);
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    demand(false, "CONFIG_MARKET_DATABASE_URL_INVALID", 503);
  }
  demand(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname && parsed.pathname.length > 1, "CONFIG_MARKET_DATABASE_URL_INVALID", 503);
  const maxOrders = env.STRIPE_WORKER_MAX_ORDERS === undefined ? 25 : Number(env.STRIPE_WORKER_MAX_ORDERS);
  demand(Number.isSafeInteger(maxOrders) && maxOrders > 0 && maxOrders <= 1_000, "CONFIG_STRIPE_WORKER_MAX_ORDERS_INVALID", 503);
  return { databaseUrl, maxOrders };
}

export async function startStripeWorker(env = process.env) {
  const config = workerConfiguration(env);
  const store = await createPostgresStore(config.databaseUrl, { initialize: false });
  try {
    const engine = createSnapshotEngine({ fetcher: createSafeFetcher() });
    return await runStripeWorkerOnce({ store, engine, maxOrders: config.maxOrders });
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(canonical(await startStripeWorker()));
  } catch (error) {
    console.error(canonical({ error: { code: error?.code ?? "STRIPE_WORKER_FAILED" } }));
    process.exitCode = 1;
  }
}
