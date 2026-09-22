import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcClient } from "../src/rpc.mjs";

test("JSON-RPC client requests the finalized block tag", async () => {
  const requests = [];
  const client = new JsonRpcClient("https://rpc.invalid", {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { number: "0x64", hash: `0x${"aa".repeat(32)}` },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const block = await client.getFinalizedBlock();
  assert.equal(block.number, 100n);
  assert.equal(requests[0].method, "eth_getBlockByNumber");
  assert.deepEqual(requests[0].params, ["finalized", false]);
});

test("JSON-RPC errors fail closed", async () => {
  const client = new JsonRpcClient("https://rpc.invalid", {
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "unsupported block tag" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.getFinalizedBlock(), /unsupported block tag/);
});

test("finalized block hashes must be exact 32-byte hex", async () => {
  const client = new JsonRpcClient("https://rpc.invalid", {
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { number: "0x64", hash: "0x1234" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.getFinalizedBlock(), /invalid finalized block hash/);
});

test("historical block lookup rejects a response for the wrong height", async () => {
  const client = new JsonRpcClient("https://rpc.invalid", {
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { number: "0x65", hash: `0x${"aa".repeat(32)}` },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.getBlockByNumber(100n), /wrong block/);
});
