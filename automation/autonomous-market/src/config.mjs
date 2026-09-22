import { demand } from "./core.mjs";

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const DEFAULT_PAY_TO = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3";

export const PRODUCTS = Object.freeze({
  snapshot: Object.freeze({
    id: "snapshot",
    path: "/v1/snapshots",
    name: "WHP Agent/x402 Integrity Snapshot",
    description: "Deterministic Markdown and JSON observations for one public HTTPS URL. Not WHP Standing or proof of truth.",
    amount: "25000000",
    display_price: "25.00 USDC",
  }),
  readiness: Object.freeze({
    id: "readiness",
    path: "/v1/readiness",
    name: "WHP Agent/x402 Readiness Check",
    description: "Bounded public-interface readiness findings for one public HTTPS URL. Never issues Standing or claims truth.",
    amount: "50000",
    display_price: "0.05 USDC",
  }),
});

function httpsUrl(value, code, { originOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  demand(url.protocol === "https:" && !url.username && !url.password && !url.hash, code, 503);
  if (originOnly) demand(url.origin === value.replace(/\/$/u, "") && url.pathname === "/" && !url.search, code, 503);
  return originOnly ? url.origin : url.href.replace(/\/$/u, "");
}

export function paymentRequirements(payTo, amount) {
  demand(/^0x[0-9a-fA-F]{40}$/u.test(payTo), "CONFIG_PAY_TO_INVALID", 503);
  demand(/^[1-9][0-9]*$/u.test(amount), "CONFIG_AMOUNT_INVALID", 503);
  return Object.freeze({
    scheme: "exact",
    network: BASE_NETWORK,
    amount,
    asset: BASE_USDC,
    payTo: payTo.toLowerCase(),
    maxTimeoutSeconds: 300,
    extra: Object.freeze({
      assetTransferMethod: "eip3009",
      paymentFlow: "authorization",
      name: "USD Coin",
      version: "2",
    }),
  });
}

function required(env, name) {
  const value = env[name];
  demand(typeof value === "string" && value.length > 0, `CONFIG_${name}_REQUIRED`, 503);
  return value;
}

export function runtimeConfiguration(env = process.env) {
  const origin = httpsUrl(required(env, "WHP_MARKET_ORIGIN"), "CONFIG_WHP_MARKET_ORIGIN_INVALID", { originOnly: true });
  const facilitatorUrl = httpsUrl(required(env, "WHP_FACILITATOR_URL"), "CONFIG_WHP_FACILITATOR_URL_INVALID");
  const rpcUrl = httpsUrl(required(env, "WHP_RPC_URL"), "CONFIG_WHP_RPC_URL_INVALID");
  const databaseUrl = required(env, "DATABASE_URL");
  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    demand(false, "CONFIG_DATABASE_URL_INVALID", 503);
  }
  demand(["postgres:", "postgresql:"].includes(database.protocol) && database.hostname && database.pathname.length > 1, "CONFIG_DATABASE_URL_INVALID", 503);
  const payTo = (env.WHP_MARKET_PAY_TO || DEFAULT_PAY_TO).toLowerCase();
  demand(/^0x[0-9a-f]{40}$/u.test(payTo), "CONFIG_WHP_MARKET_PAY_TO_INVALID", 503);
  const port = env.PORT === undefined ? 8080 : Number(env.PORT);
  demand(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "CONFIG_PORT_INVALID", 503);
  const stripeSecret = env.STRIPE_WEBHOOK_SECRET || "";
  const stripePaymentLinkId = env.STRIPE_PAYMENT_LINK_ID || "";
  const stripeCheckoutUrl = env.STRIPE_CHECKOUT_URL || "";
  demand(Boolean(stripeSecret) === Boolean(stripePaymentLinkId), "CONFIG_STRIPE_INCOMPLETE", 503);
  if (stripeSecret) {
    demand(/^whsec_[A-Za-z0-9_=-]{8,}$/u.test(stripeSecret), "CONFIG_STRIPE_WEBHOOK_SECRET_INVALID", 503);
    demand(/^plink_[A-Za-z0-9_]+$/u.test(stripePaymentLinkId), "CONFIG_STRIPE_PAYMENT_LINK_ID_INVALID", 503);
  }
  demand(!stripeCheckoutUrl || stripeSecret, "CONFIG_STRIPE_CHECKOUT_WITHOUT_WEBHOOK", 503);
  const checkoutUrl = stripeCheckoutUrl
    ? httpsUrl(stripeCheckoutUrl, "CONFIG_STRIPE_CHECKOUT_URL_INVALID")
    : null;
  return {
    origin,
    facilitatorUrl,
    rpcUrl,
    databaseUrl,
    payTo,
    port,
    stripe: stripeSecret ? {
      webhookSecret: stripeSecret,
      paymentLinkId: stripePaymentLinkId,
      checkoutUrl,
    } : null,
    products: Object.fromEntries(Object.entries(PRODUCTS).map(([id, product]) => [id, { ...product, requirements: paymentRequirements(payTo, product.amount) }])),
  };
}
