import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/market/core.mjs";
import { createSnapshotEngine } from "../src/market/snapshot.mjs";

function fetched(url) {
  const body = Buffer.from("{}");
  return {
    requested_url: url,
    final_url: url,
    redirects: [],
    status: 200,
    headers: { "content-type": "application/json" },
    body,
    body_sha256: sha256(body),
    body_bytes: body.length,
  };
}

test("snapshot starts all six independently pinned probes in parallel", async () => {
  const pending = [];
  const engine = createSnapshotEngine({
    fetcher: (url) => new Promise((resolve) => pending.push({ url, resolve })),
  });
  const result = engine("https://example.com/");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 6);
  for (const item of pending) item.resolve(fetched(item.url));
  const snapshot = await result;
  assert.equal(snapshot.observations.target.status, 200);
  assert.deepEqual(Object.keys(snapshot.observations.discovery), ["agent_card", "x402", "openapi", "llms", "health"]);
});

test("a submitted discovery URL is fetched once and reused deterministically", async () => {
  const urls = [];
  const engine = createSnapshotEngine({
    fetcher: async (url) => {
      urls.push(url);
      return fetched(url);
    },
  });
  const snapshot = await engine("https://example.com/.well-known/x402");
  assert.equal(urls.length, 5);
  assert.equal(urls.filter((url) => url.endsWith("/.well-known/x402")).length, 1);
  assert.deepEqual(snapshot.observations.target, snapshot.observations.discovery.x402);
});
