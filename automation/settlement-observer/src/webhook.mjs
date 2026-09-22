import { toPublicEvent } from "./queries.mjs";
import { randomUUID } from "node:crypto";

export class WebhookNotifier {
  #url;
  #token;
  #timeoutMs;
  #fetch;

  constructor({ url, bearerToken = null, timeoutMs = 10000, fetchImpl = fetch }) {
    this.#url = url;
    this.#token = bearerToken;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  async send(row) {
    const event = toPublicEvent(row);
    const headers = {
      "content-type": "application/json",
      "idempotency-key": event.eventId,
      "user-agent": "whp-settlement-observer/1.0",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;

    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "base.usdc.transfer.finalized",
        event,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  }
}

export async function deliverPendingWebhooks({ store, notifier, scope, limit }) {
  if (!notifier) return { attempted: 0, delivered: 0, failed: 0 };
  const leaseOwner = randomUUID();
  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  // Claim one row immediately before sending it. This bounds the lease age even
  // when the configured batch is large and another cron instance overlaps.
  while (attempted < limit) {
    const rows = await store.claimPendingWebhookEvents(scope, 1, leaseOwner, 120000);
    if (rows.length === 0) break;
    const row = rows[0];
    attempted += 1;
    try {
      await notifier.send(row);
    } catch (error) {
      await store.markWebhookFailed(
        row.event_key,
        leaseOwner,
        error instanceof Error ? error.message : String(error),
      );
      failed += 1;
      continue;
    }
    // An acknowledgement error is not a notification failure. Let the durable
    // lease expire so the at-least-once retry remains truthful.
    await store.markWebhookDelivered(row.event_key, leaseOwner);
    delivered += 1;
  }
  return { attempted, delivered, failed };
}
