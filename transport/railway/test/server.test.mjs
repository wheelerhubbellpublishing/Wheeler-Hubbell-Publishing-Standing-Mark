import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { createGatewayServer } from "../server.mjs";

let upstreamServer;
let gatewayServer;
let upstreamOrigin;
let gatewayOrigin;
const received = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

before(async () => {
  upstreamServer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });

      if (request.url === "/__whp_transport/mcp") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "verified-session",
        });
        response.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        return;
      }

      response.writeHead(201, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 1, 2, 3, 255]));
    });
  });
  upstreamOrigin = await listen(upstreamServer);
  gatewayServer = createGatewayServer({ upstreamOrigin });
  gatewayOrigin = await listen(gatewayServer);
});

after(async () => {
  await Promise.all([close(gatewayServer), close(upstreamServer)]);
});

test("forwards MCP requests and streams the upstream response", async () => {
  const payload = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  );
  const response = await fetch(`${gatewayOrigin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer public-test",
      "content-type": "application/json",
      "mcp-session-id": "incoming-session",
    },
    body: payload,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("mcp-session-id"), "verified-session");
  assert.match(await response.text(), /"jsonrpc":"2.0"/);

  const request = received.at(-1);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/__whp_transport/mcp");
  assert.equal(request.headers.authorization, "Bearer public-test");
  assert.equal(request.headers["mcp-session-id"], "incoming-session");
  assert.deepEqual(request.body, payload);
});

test("preserves path, query, status, content type, and response bytes", async () => {
  const response = await fetch(`${gatewayOrigin}/immutable/object.bin?version=7`);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from([0, 1, 2, 3, 255]),
  );
  assert.equal(
    received.at(-1).url,
    "/__whp_transport/immutable/object.bin?version=7",
  );
});

test("answers gateway health without calling the upstream", async () => {
  const beforeCount = received.length;
  const response = await fetch(`${gatewayOrigin}/__gateway-health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "whp-standing-mark-transport",
    upstream: `${upstreamOrigin}/__whp_transport`,
  });
  assert.equal(received.length, beforeCount);
});
