const MARKET_ENV_NAMES = Object.freeze([
  "WHP_MARKET_ORIGIN",
  "WHP_FACILITATOR_URL",
  "WHP_RPC_URL",
  "WHP_MARKET_PAY_TO",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAYMENT_LINK_ID",
  "STRIPE_CHECKOUT_URL",
]);

export function readNetlifyEnvironment(get, names = MARKET_ENV_NAMES) {
  if (typeof get !== "function") throw new Error("Netlify environment getter is required");
  const env = {};
  for (const name of names) {
    const value = get(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function databaseConnectionString(getConnectionString) {
  if (typeof getConnectionString !== "function") throw new Error("Netlify Database provider is required");
  const value = getConnectionString();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Netlify Database returned an invalid connection string");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("Netlify Database returned an invalid connection string");
  }
  return value;
}

export { MARKET_ENV_NAMES };
