import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const JOB_TIMEOUT_MS = 10 * 60 * 1_000;

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function selectedEnvironment(names) {
  const environment = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
}

function runJob(name, entrypoint, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, JOB_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, error: String(error?.message ?? error).slice(0, 500) });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: !timedOut && code === 0, code, signal, timedOut });
    });
  });
}

const jobs = [
  {
    name: "stripe-fulfillment",
    entrypoint: "autonomous-market/src/stripe-worker.mjs",
    environment: () => ({
      ...selectedEnvironment(["NODE_ENV", "STRIPE_WORKER_MAX_ORDERS"]),
      MARKET_DATABASE_URL: required("MARKET_DATABASE_URL"),
    }),
  },
  {
    name: "settlement-observer",
    entrypoint: "settlement-observer/src/run-once.mjs",
    environment: () => ({
      ...selectedEnvironment([
        "NODE_ENV", "DATABASE_SSL_MODE", "START_BLOCK", "RPC_BLOCK_RANGE",
        "WEBHOOK_URL", "WEBHOOK_BEARER_TOKEN", "WEBHOOK_TIMEOUT_MS", "WEBHOOK_BATCH_SIZE",
      ]),
      DATABASE_URL: required("SETTLEMENT_DATABASE_URL"),
      BASE_RPC_URL: required("BASE_RPC_URL"),
    }),
  },
  {
    name: "ept-carrier",
    entrypoint: "carrier-daemon/src/main.mjs",
    environment: () => ({
      ...selectedEnvironment([
        "NODE_ENV", "WHP_MARKET_ORIGIN", "CARRIER_DISABLED", "CARRIER_MAX_AUTOMATED_CONTACTS",
        "CARRIER_REGISTRY_PAGES", "CARRIER_CONNECT_TIMEOUT_MS", "CARRIER_STATUS_TIMEOUT_MS",
      ]),
      CARRIER_DATABASE_URL: required("CARRIER_DATABASE_URL"),
      CARRIER_MODE: "once",
    }),
  },
];

const results = [];
for (const job of jobs) {
  try {
    results.push(await runJob(job.name, job.entrypoint, job.environment()));
  } catch (error) {
    results.push({ name: job.name, ok: false, error: String(error?.message ?? error).slice(0, 500) });
  }
}

process.stdout.write(`${JSON.stringify({ event: "hourly_run_complete", results })}\n`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
