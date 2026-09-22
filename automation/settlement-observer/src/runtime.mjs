import pg from "pg";
import { loadConfig } from "./config.mjs";
import { createHttpServer } from "./http.mjs";
import { SettlementObserver } from "./observer.mjs";
import { JsonRpcClient } from "./rpc.mjs";
import { SettlementStore } from "./store.mjs";
import { WebhookNotifier } from "./webhook.mjs";

export async function createRuntime(env = process.env) {
  const config = loadConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  const store = new SettlementStore(pool);
  try {
    await store.migrate();
    const rpc = new JsonRpcClient(config.rpcUrl);
    const notifier = config.webhookUrl ? new WebhookNotifier({
      url: config.webhookUrl,
      bearerToken: config.webhookBearerToken,
      timeoutMs: config.webhookTimeoutMs,
    }) : null;
    const observer = new SettlementObserver({ config, rpc, store, notifier });
    return {
      config,
      pool,
      store,
      observer,
      createServer: () => createHttpServer({ observer, store, config }),
      close: async () => {
        observer.stop();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
