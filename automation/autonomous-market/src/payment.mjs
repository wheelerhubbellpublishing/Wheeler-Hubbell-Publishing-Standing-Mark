import { canonical, demand, Fault, sameJson, sha256 } from "./core.mjs";
import { BASE_NETWORK } from "./config.mjs";

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
export const HEX32 = /^0x[0-9a-fA-F]{64}$/u;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";

function decimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/u.test(value) && BigInt(value) < 2n ** 256n;
}

export function validatePayment(payment, requirements, resource, now = Math.floor(Date.now() / 1_000), { allowExpired = false } = {}) {
  demand(payment && typeof payment === "object" && !Array.isArray(payment), "PAYMENT_INVALID");
  demand(payment.x402Version === 2, "X402_VERSION_UNSUPPORTED");
  demand(sameJson(payment.accepted, requirements), "PAYMENT_TERMS_MISMATCH");
  demand(payment.resource && sameJson(payment.resource, resource), "PAYMENT_RESOURCE_MISMATCH");
  const payload = payment.payload;
  demand(payload && typeof payload === "object" && !Array.isArray(payload), "PAYMENT_PAYLOAD_INVALID");
  demand(typeof payload.signature === "string" && /^0x[0-9a-fA-F]{128}(?:00|01|1[bBcC])$/u.test(payload.signature), "PAYMENT_SIGNATURE_FORMAT");
  const authorization = payload.authorization;
  demand(authorization && typeof authorization === "object" && !Array.isArray(authorization), "PAYMENT_AUTHORIZATION_INVALID");
  demand(EVM_ADDRESS.test(authorization.from) && EVM_ADDRESS.test(authorization.to), "PAYMENT_ADDRESS_INVALID");
  demand(decimal(authorization.value) && decimal(authorization.validAfter) && decimal(authorization.validBefore), "PAYMENT_INTEGER_INVALID");
  demand(HEX32.test(authorization.nonce), "PAYMENT_NONCE_INVALID");
  demand(authorization.to.toLowerCase() === requirements.payTo.toLowerCase() && authorization.value === requirements.amount, "PAYMENT_VALUE_OR_RECIPIENT_MISMATCH");
  demand(BigInt(authorization.validAfter) < BigInt(authorization.validBefore) && BigInt(authorization.validAfter) < BigInt(now), "PAYMENT_NOT_YET_VALID");
  demand(BigInt(authorization.validBefore) - BigInt(now) <= BigInt(requirements.maxTimeoutSeconds + 30), "PAYMENT_WINDOW_EXCEEDS_TERMS");
  if (!allowExpired) demand(BigInt(now) < BigInt(authorization.validBefore), "PAYMENT_EXPIRED");
  return sha256(canonical({
    domain: "WHP-MARKET-PAYMENT-v1",
    network: requirements.network,
    asset: requirements.asset.toLowerCase(),
    from: authorization.from.toLowerCase(),
    nonce: authorization.nonce.toLowerCase(),
  }));
}

export function wordAddress(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

export function calldataMatches(input, authorization, signature) {
  if (typeof input !== "string" || input.length !== 10 + 9 * 64 || input.slice(0, 10).toLowerCase() !== TRANSFER_WITH_AUTHORIZATION_SELECTOR) return false;
  const words = input.slice(10).toLowerCase().match(/.{64}/gu);
  if (!words || words.length !== 9) return false;
  const addressWord = (address) => `${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const sig = signature.slice(2).toLowerCase();
  const rawV = Number.parseInt(sig.slice(128), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  return words[0] === addressWord(authorization.from)
    && words[1] === addressWord(authorization.to)
    && BigInt(`0x${words[2]}`) === BigInt(authorization.value)
    && BigInt(`0x${words[3]}`) === BigInt(authorization.validAfter)
    && BigInt(`0x${words[4]}`) === BigInt(authorization.validBefore)
    && words[5] === authorization.nonce.slice(2).toLowerCase()
    && BigInt(`0x${words[6]}`) === BigInt(v)
    && words[7] === sig.slice(0, 64)
    && words[8] === sig.slice(64, 128);
}

export class PaymentRail {
  constructor({ facilitatorUrl, rpcUrl }, { fetchImpl = fetch } = {}) {
    demand(/^https:\/\//u.test(facilitatorUrl) && /^https:\/\//u.test(rpcUrl), "HTTPS_PAYMENT_ENDPOINTS_REQUIRED", 503);
    this.facilitatorUrl = facilitatorUrl.replace(/\/$/u, "");
    this.rpcUrl = rpcUrl;
    this.fetch = fetchImpl;
  }

  async postJson(url, body, code) {
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonical(body),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new Fault(code, 503, { retryable: true });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(code, 503, { retryable: true });
    }
    const reader = response.body?.getReader();
    const parts = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Fault(`${code}_RESPONSE_TOO_LARGE`, 503, { retryable: true });
        }
        parts.push(Buffer.from(value));
      }
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
    } catch {
      throw new Fault(`${code}_RESPONSE_INVALID`, 503, { retryable: true });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Fault(`${code}_RESPONSE_INVALID`, 503, { retryable: true });
    }
  }

  serverPaymentPayload(payment, bazaar) {
    const { extensions: _untrusted, ...base } = payment;
    return { ...base, extensions: { bazaar } };
  }

  async facilitator(phase, payment, requirements, bazaar) {
    return this.postJson(`${this.facilitatorUrl}/${phase}`, {
      x402Version: 2,
      paymentPayload: this.serverPaymentPayload(payment, bazaar),
      paymentRequirements: requirements,
    }, "PAYMENT_PROVIDER_UNAVAILABLE");
  }

  async verify(payment, requirements, bazaar) {
    const response = await this.facilitator("verify", payment, requirements, bazaar);
    const expected = payment.payload.authorization.from.toLowerCase();
    demand(response.isValid === true && typeof response.payer === "string" && response.payer.toLowerCase() === expected, "PAYMENT_SIGNATURE_OR_STATE_INVALID", 402);
    return response;
  }

  async settle(payment, requirements, bazaar) {
    return this.facilitator("settle", payment, requirements, bazaar);
  }

  async rpc(method, params) {
    const response = await this.postJson(this.rpcUrl, { jsonrpc: "2.0", id: 1, method, params }, "CHAIN_READ_UNAVAILABLE");
    demand(!response.error, "CHAIN_READ_UNAVAILABLE", 503, { retryable: true });
    return response.result;
  }

  async startBlock() {
    const chain = await this.rpc("eth_chainId", []);
    demand(`${"eip155:"}${BigInt(chain)}` === BASE_NETWORK, "RPC_CHAIN_MISMATCH", 503);
    return Number(BigInt(await this.rpc("eth_blockNumber", [])));
  }

  async evidence(payment, transaction, observedAt) {
    if (!HEX32.test(transaction ?? "")) return null;
    const chain = await this.rpc("eth_chainId", []);
    demand(`${"eip155:"}${BigInt(chain)}` === payment.accepted.network, "RPC_CHAIN_MISMATCH", 503);
    const receipt = await this.rpc("eth_getTransactionReceipt", [transaction]);
    if (!receipt || receipt.status !== "0x1") return null;
    const finalized = await this.rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!finalized || BigInt(receipt.blockNumber) > BigInt(finalized.number)) return null;
    const block = await this.rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!block || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;
    const transactionData = await this.rpc("eth_getTransactionByHash", [transaction]);
    const authorization = payment.payload.authorization;
    const token = payment.accepted.asset.toLowerCase();
    if (!transactionData
      || transactionData.hash.toLowerCase() !== transaction.toLowerCase()
      || transactionData.to?.toLowerCase() !== token
      || transactionData.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()
      || !calldataMatches(transactionData.input, authorization, payment.payload.signature)) return null;
    const logs = receipt.logs.filter((log) => log.address.toLowerCase() === token
      && !log.removed
      && log.transactionHash.toLowerCase() === transaction.toLowerCase()
      && log.blockHash.toLowerCase() === receipt.blockHash.toLowerCase());
    const authorizationLogs = logs.filter((log) => log.topics.length === 3
      && log.topics[0].toLowerCase() === AUTHORIZATION_USED_TOPIC
      && log.topics[1].toLowerCase() === wordAddress(authorization.from)
      && log.topics[2].toLowerCase() === authorization.nonce.toLowerCase());
    const transferLogs = logs.filter((log) => log.topics.length === 3
      && log.topics[0].toLowerCase() === TRANSFER_TOPIC
      && log.topics[1].toLowerCase() === wordAddress(authorization.from)
      && log.topics[2].toLowerCase() === wordAddress(authorization.to)
      && /^0x[0-9a-fA-F]{64}$/u.test(log.data)
      && BigInt(log.data) === BigInt(authorization.value));
    if (authorizationLogs.length !== 1 || transferLogs.length !== 1) return null;
    return {
      version: "WHP-X402-FINALIZED-SETTLEMENT-v1",
      network: payment.accepted.network,
      asset: payment.accepted.asset.toLowerCase(),
      amount: authorization.value,
      payer: authorization.from.toLowerCase(),
      pay_to: authorization.to.toLowerCase(),
      nonce: authorization.nonce.toLowerCase(),
      transaction: transaction.toLowerCase(),
      block_number: Number(BigInt(receipt.blockNumber)),
      block_hash: receipt.blockHash.toLowerCase(),
      finality: "finalized",
      finalized_head: { number: finalized.number, hash: finalized.hash },
      observed_at: observedAt,
    };
  }

  async reconcile(row, observedAt) {
    if (row.transaction_hint) {
      const proof = await this.evidence(row.payment_payload, row.transaction_hint, observedAt);
      if (proof) return proof;
    }
    const head = await this.rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!head) return null;
    const payment = row.payment_payload;
    const authorization = payment.payload.authorization;
    const from = row.scan_from ?? row.observed_block;
    const finalizedNumber = Number(BigInt(head.number));
    const to = Math.min(finalizedNumber, from + 1_999);
    if (from > to) return null;
    const logs = await this.rpc("eth_getLogs", [{
      address: payment.accepted.asset,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics: [AUTHORIZATION_USED_TOPIC, wordAddress(authorization.from), authorization.nonce],
    }]);
    demand(Array.isArray(logs), "CHAIN_LOGS_INVALID", 503);
    for (const log of logs) {
      const proof = await this.evidence(payment, log.transactionHash, observedAt);
      if (proof) return proof;
    }
    return { scan_only: true, next_scan_from: to + 1 };
  }
}
