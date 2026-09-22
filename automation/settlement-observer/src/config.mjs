import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_NETWORK,
  BASE_USDC_ADDRESS,
  OBSERVER_SCOPE,
  USDC_DECIMALS,
  USDC_SYMBOL,
  WHP_PAYEE_ADDRESS,
} from "./constants.mjs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function optionalBlock(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative block number`);
  return BigInt(raw);
}

function optionalHttpsUrl(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url.toString();
}

function requiredHttpsUrl(env, name) {
  const raw = required(env, name);
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  return url.toString();
}

export function loadConfig(env = process.env) {
  const sslMode = env.DATABASE_SSL_MODE?.trim() || "require";
  if (!["require", "disable"].includes(sslMode)) {
    throw new Error("DATABASE_SSL_MODE must be require or disable");
  }

  return Object.freeze({
    rpcUrl: requiredHttpsUrl(env, "BASE_RPC_URL"),
    databaseUrl: required(env, "DATABASE_URL"),
    databaseSsl: sslMode === "require" ? { rejectUnauthorized: false } : false,
    port: integer(env, "PORT", 3000, { min: 1, max: 65535 }),
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 5000, { min: 1000, max: 300000 }),
    blockRange: BigInt(integer(env, "RPC_BLOCK_RANGE", 2000, { min: 1, max: 10000 })),
    startBlock: optionalBlock(env, "START_BLOCK"),
    webhookUrl: optionalHttpsUrl(env, "WEBHOOK_URL"),
    webhookBearerToken: env.WEBHOOK_BEARER_TOKEN?.trim() || null,
    webhookTimeoutMs: integer(env, "WEBHOOK_TIMEOUT_MS", 10000, { min: 1000, max: 60000 }),
    webhookBatchSize: integer(env, "WEBHOOK_BATCH_SIZE", 20, { min: 1, max: 100 }),
    chainId: BASE_MAINNET_CHAIN_ID,
    network: BASE_MAINNET_NETWORK,
    tokenAddress: BASE_USDC_ADDRESS,
    tokenSymbol: USDC_SYMBOL,
    tokenDecimals: USDC_DECIMALS,
    payeeAddress: WHP_PAYEE_ADDRESS,
    scope: OBSERVER_SCOPE,
  });
}
