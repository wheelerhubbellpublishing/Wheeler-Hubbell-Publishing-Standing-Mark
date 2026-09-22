import test from "node:test";
import assert from "node:assert/strict";
import { paymentRequirements } from "../src/config.mjs";
import {
  AUTHORIZATION_USED_TOPIC,
  calldataMatches,
  PaymentRail,
  TRANSFER_TOPIC,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  wordAddress,
} from "../src/payment.mjs";

const PAY_TO = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3";
const PAYER = "0x1111111111111111111111111111111111111111";
const requirements = paymentRequirements(PAY_TO, "25000000");
const authorization = {
  from: PAYER,
  to: PAY_TO,
  value: "25000000",
  validAfter: "1999999999",
  validBefore: "2000000300",
  nonce: `0x${"22".repeat(32)}`,
};
const signature = `0x${"33".repeat(32)}${"44".repeat(32)}1b`;
const payment = {
  x402Version: 2,
  accepted: requirements,
  resource: { url: "https://market.example/v1/snapshots", description: "snapshot", mimeType: "application/json" },
  payload: { signature, authorization },
  extensions: { bazaar: { client_supplied: "must not reach facilitator" } },
};

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function calldata() {
  const rawV = Number.parseInt(signature.slice(-2), 16);
  return `${TRANSFER_WITH_AUTHORIZATION_SELECTOR}${[
    authorization.from.slice(2).padStart(64, "0"),
    authorization.to.slice(2).padStart(64, "0"),
    word(authorization.value),
    word(authorization.validAfter),
    word(authorization.validBefore),
    authorization.nonce.slice(2),
    word(rawV),
    signature.slice(2, 66),
    signature.slice(66, 130),
  ].join("")}`;
}

test("exact EIP-3009 calldata is matched against the signed authorization", () => {
  assert.equal(calldataMatches(calldata(), authorization, signature), true);
  assert.equal(calldataMatches(calldata().replace("017d7840", "017d7841"), authorization, signature), false);
});

test("facilitator calls discard client extension replacement and send server-owned Bazaar metadata", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.endsWith("/verify")
      ? { isValid: true, payer: PAYER }
      : { success: true, transaction: `0x${"ab".repeat(32)}`, network: requirements.network, payer: PAYER }));
  };
  const rail = new PaymentRail({ facilitatorUrl: "https://facilitator.example", rpcUrl: "https://rpc.example" }, { fetchImpl });
  const bazaar = { info: { input: { type: "http" } }, schema: { type: "object" } };
  await rail.verify(payment, requirements, bazaar);
  await rail.settle(payment, requirements, bazaar);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.body.paymentPayload.extensions, { bazaar });
    assert.equal(call.body.paymentPayload.extensions.bazaar.client_supplied, undefined);
    assert.deepEqual(call.body.paymentRequirements, requirements);
  }
});

test("on-chain evidence requires finalized receipt, matching transaction calldata and exact logs", async () => {
  const txid = `0x${"ab".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  const rail = new PaymentRail({ facilitatorUrl: "https://facilitator.example", rpcUrl: "https://rpc.example" }, { fetchImpl: async () => { throw new Error("unused"); } });
  const values = {
    eth_chainId: "0x2105",
    eth_getTransactionReceipt: {
      status: "0x1",
      blockNumber: "0x64",
      blockHash,
      logs: [
        { address: requirements.asset, removed: false, transactionHash: txid, blockHash, topics: [AUTHORIZATION_USED_TOPIC, wordAddress(PAYER), authorization.nonce], data: "0x" },
        { address: requirements.asset, removed: false, transactionHash: txid, blockHash, topics: [TRANSFER_TOPIC, wordAddress(PAYER), wordAddress(PAY_TO)], data: `0x${word(authorization.value)}` },
      ],
    },
    eth_getTransactionByHash: { hash: txid, to: requirements.asset, blockHash, input: calldata() },
  };
  rail.rpc = async (method, params) => {
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") return { number: "0x65", hash: `0x${"ef".repeat(32)}` };
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: blockHash };
    return values[method];
  };
  const proof = await rail.evidence(payment, txid, 2_000_000_000);
  assert.equal(proof.finality, "finalized");
  assert.equal(proof.transaction, txid);

  rail.rpc = async (method, params) => {
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") return { number: "0x63", hash: `0x${"ef".repeat(32)}` };
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: blockHash };
    return values[method];
  };
  assert.equal(await rail.evidence(payment, txid, 2_000_000_000), null);
});
