import test from "node:test";
import assert from "node:assert/strict";
import { createReadinessEngine, createSnapshotEngine } from "../src/market/snapshot.mjs";
import { sha256 } from "../src/market/core.mjs";

function fakeFetcher(url) {
  const parsed = new URL(url);
  let status = 200;
  let contentType = "application/json";
  let value;
  if (parsed.pathname === "/.well-known/agent-card.json") value = { name: "Example Agent", url: "https://example.com/a2a", capabilities: { streaming: false } };
  else if (parsed.pathname === "/.well-known/x402") value = { version: 1, resources: ["https://example.com/buy"] };
  else if (parsed.pathname === "/openapi.json") value = { openapi: "3.1.0", info: { title: "Example API", version: "1" }, paths: { "/buy": {} } };
  else if (parsed.pathname === "/llms.txt") {
    contentType = "text/plain";
    value = "# Example";
  } else if (parsed.pathname === "/healthz") value = { status: "ok" };
  else value = { service: "example" };
  const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return Promise.resolve({
    requested_url: url,
    final_url: url,
    redirects: [],
    status,
    headers: {
      "content-type": contentType,
      "strict-transport-security": "max-age=31536000",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
    body,
    body_sha256: sha256(body),
    body_bytes: body.length,
  });
}

test("snapshot output is deterministic Markdown plus JSON and contains no truth or Standing claim", async () => {
  const engine = createSnapshotEngine({ fetcher: fakeFetcher });
  const first = await engine("https://example.com/");
  const second = await engine("https://example.com/");
  assert.deepEqual(second, first);
  assert.match(first.markdown, /^# WHP Agent\/x402 Integrity Snapshot/mu);
  assert.equal(first.version, "WHP-INTEGRITY-SNAPSHOT-v1");
  assert(first.limitations.some((line) => line.includes("not WHP Standing")));
  assert(first.limitations.some((line) => line.includes("proof of truth")));
  assert.equal(Object.hasOwn(first.observations.target, "parsed_json"), false);
  assert.equal(first.analysis.capabilities.agent_card_observed, true);
  assert.equal(first.analysis.capabilities.openapi_observed, true);
});

test("readiness output is bounded and says only whether a full snapshot may be useful", async () => {
  const snapshot = createSnapshotEngine({ fetcher: fakeFetcher });
  const readiness = await createReadinessEngine({ snapshotEngine: snapshot })("https://example.com/");
  assert.equal(readiness.version, "WHP-X402-READINESS-v1");
  assert.equal(typeof readiness.readiness.full_snapshot_may_be_useful, "boolean");
  assert.equal(Object.hasOwn(readiness, "findings"), false);
  assert(readiness.limitations.some((line) => line.includes("never issues WHP Standing")));
});
