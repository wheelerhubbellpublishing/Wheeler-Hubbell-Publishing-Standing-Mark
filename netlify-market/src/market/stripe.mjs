import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { canonical, demand, Fault, sha256 } from "./core.mjs";
import { normalizePublicHttpsUrl } from "./ssrf.mjs";

export const STRIPE_WEBHOOK_BODY_LIMIT = 262_144;
export const STRIPE_FULFILLMENT_LEASE_SECONDS = 900;
export const STRIPE_SNAPSHOT_AMOUNT = 2_500;
export const STRIPE_SNAPSHOT_CURRENCY = "usd";

const STRIPE_SESSION_ID = /^cs_live_[A-Za-z0-9_]+$/u;
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]+$/u;
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export function createStripeClient() {
  // The instance is used only for local webhook signature verification. No
  // Stripe API request is made, so no API key or global configuration is
  // required. The authenticator fails closed if future code attempts one.
  return new Stripe("", {
    authenticator: async () => { throw new Error("Stripe API calls are disabled"); },
    maxNetworkRetries: 0,
    telemetry: false,
  });
}

export function verifyStripeWebhook(stripeClient, rawBody, signature, secret, now) {
  demand(Buffer.isBuffer(rawBody), "STRIPE_RAW_BODY_REQUIRED", 500);
  demand(typeof signature === "string" && signature.length > 0 && signature.length <= 8_192, "STRIPE_SIGNATURE_REQUIRED", 400);
  try {
    return stripeClient.webhooks.constructEvent(rawBody, signature, secret, 300, undefined, now * 1_000);
  } catch {
    throw new Fault("STRIPE_SIGNATURE_INVALID", 400);
  }
}

function targetUrlFrom(session) {
  demand(Array.isArray(session.custom_fields) && session.custom_fields.length <= 8, "STRIPE_TARGET_URL_MISSING", 422);
  const matches = session.custom_fields.filter((field) => field?.key === "targeturl");
  demand(matches.length === 1, "STRIPE_TARGET_URL_MISSING", 422);
  const field = matches[0];
  demand(field.type === "text" && field.optional === false && typeof field.text?.value === "string", "STRIPE_TARGET_URL_INVALID", 422);
  return normalizePublicHttpsUrl(field.text.value).href;
}

export function createStripeResultToken() {
  return randomBytes(32).toString("hex");
}

export function stripeOrderFromEvent(event, rawBody, stripeConfig, now) {
  demand(event && typeof event === "object" && STRIPE_EVENT_ID.test(event.id ?? ""), "STRIPE_EVENT_INVALID", 422);
  if (!HANDLED_EVENTS.has(event.type)) return null;
  demand(event.livemode === true, "STRIPE_LIVEMODE_REQUIRED", 422);
  const session = event.data?.object;
  demand(session?.object === "checkout.session" && STRIPE_SESSION_ID.test(session.id ?? ""), "STRIPE_SESSION_INVALID", 422);
  demand(session.livemode === true, "STRIPE_LIVEMODE_REQUIRED", 422);
  demand(session.mode === "payment", "STRIPE_MODE_INVALID", 422);
  demand(session.payment_status === "paid", "STRIPE_PAYMENT_NOT_PAID", 422);
  demand(session.currency === STRIPE_SNAPSHOT_CURRENCY, "STRIPE_CURRENCY_INVALID", 422);
  demand(session.amount_total === STRIPE_SNAPSHOT_AMOUNT, "STRIPE_AMOUNT_INVALID", 422);
  demand(session.payment_link === stripeConfig.paymentLinkId, "STRIPE_PAYMENT_LINK_INVALID", 422);
  demand(session.automatic_tax?.enabled !== true, "STRIPE_AUTOMATIC_TAX_FORBIDDEN", 422);
  const targetUrl = targetUrlFrom(session);
  const token = createStripeResultToken();
  return {
    order: {
      session_id: session.id,
      target_url: targetUrl,
      target_hash: sha256(targetUrl),
      result_token: token,
      result_token_hash: sha256(token),
      amount_total: session.amount_total,
      currency: session.currency,
      payment_link: session.payment_link,
      livemode: true,
      created_at: now,
    },
    event: {
      id: event.id,
      session_id: session.id,
      event_type: event.type,
      payload_hash: sha256(rawBody),
      created_at: now,
    },
  };
}

export function stripeDelivery(row, report) {
  return {
    version: "WHP-MARKET-STRIPE-DELIVERY-v1",
    rail: "stripe",
    product: "snapshot",
    additional_charge: false,
    payment: {
      status: "paid",
      currency: row.currency,
      amount_total: row.amount_total,
      payment_link: row.payment_link,
    },
    report,
  };
}

export async function fulfillStripeRow({ store, engine, row, owner, clock }) {
  try {
    const report = await engine(row.target_url);
    const resultBytes = canonical(stripeDelivery(row, report));
    return await store.completeStripe(row.session_id, owner, resultBytes, clock());
  } catch (error) {
    await store.failStripe(row.session_id, owner, clock());
    throw error;
  }
}

export async function runStripeWorkerOnce({ store, engine, clock = () => Math.floor(Date.now() / 1_000), maxOrders = 25 }) {
  demand(Number.isSafeInteger(maxOrders) && maxOrders > 0 && maxOrders <= 1_000, "STRIPE_WORKER_LIMIT_INVALID", 500);
  const stats = { claimed: 0, completed: 0, failed: 0 };
  for (let index = 0; index < maxOrders; index += 1) {
    const owner = randomBytes(16).toString("hex");
    const row = await store.claimNextStripe(owner, clock(), STRIPE_FULFILLMENT_LEASE_SECONDS);
    if (!row) break;
    stats.claimed += 1;
    try {
      await fulfillStripeRow({ store, engine, row, owner, clock });
      stats.completed += 1;
    } catch {
      stats.failed += 1;
    }
  }
  return stats;
}
