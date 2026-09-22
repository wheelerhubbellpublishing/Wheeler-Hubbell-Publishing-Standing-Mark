import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const baseEnv = {
  BASE_RPC_URL: "https://mainnet.base.org",
  DATABASE_URL: "postgresql://example.invalid/observer",
  DATABASE_SSL_MODE: "disable",
};

test("configuration locks Base chain, canonical USDC, and the WHP payee", () => {
  const config = loadConfig({
    ...baseEnv,
    CHAIN_ID: "1",
    TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
    PAYEE_ADDRESS: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(config.chainId, 8453n);
  assert.equal(config.tokenAddress, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(config.payeeAddress, "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3");
});

test("RPC and webhook transports require HTTPS", () => {
  assert.throws(() => loadConfig({ ...baseEnv, BASE_RPC_URL: "http://mainnet.base.org" }), /must use HTTPS/);
  assert.throws(() => loadConfig({ ...baseEnv, WEBHOOK_URL: "http://example.test/hook" }), /must use HTTPS/);
});

test("START_BLOCK zero is retained for an intentional genesis backfill", () => {
  assert.equal(loadConfig({ ...baseEnv, START_BLOCK: "0" }).startBlock, 0n);
});
