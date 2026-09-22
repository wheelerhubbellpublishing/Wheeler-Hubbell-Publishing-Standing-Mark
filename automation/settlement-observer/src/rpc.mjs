function quantity(value) {
  if (typeof value !== "bigint" || value < 0n) throw new Error("RPC quantity must be non-negative bigint");
  return `0x${value.toString(16)}`;
}

export function parseQuantity(value, fieldName = "quantity") {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return BigInt(value);
}

export class JsonRpcClient {
  #url;
  #fetch;
  #id = 0;

  constructor(url, { fetchImpl = fetch } = {}) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  async call(method, params) {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
    if (!("result" in body)) throw new Error("RPC response has no result");
    return body.result;
  }

  async getChainId() {
    return parseQuantity(await this.call("eth_chainId", []), "chain id");
  }

  async getFinalizedBlock() {
    const block = await this.call("eth_getBlockByNumber", ["finalized", false]);
    if (!block?.number || !block?.hash) throw new Error("RPC did not return a finalized block");
    if (!/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
      throw new Error("RPC returned an invalid finalized block hash");
    }
    return { number: parseQuantity(block.number, "finalized block number"), hash: block.hash.toLowerCase() };
  }

  async getBlockByNumber(blockNumber) {
    const block = await this.call("eth_getBlockByNumber", [quantity(blockNumber), false]);
    if (!block?.number || !/^0x[0-9a-fA-F]{64}$/.test(block?.hash || "")) {
      throw new Error(`RPC did not return block ${blockNumber}`);
    }
    const returnedNumber = parseQuantity(block.number, "block number");
    if (returnedNumber !== blockNumber) {
      throw new Error(`RPC returned the wrong block: expected ${blockNumber}, received ${returnedNumber}`);
    }
    return { number: returnedNumber, hash: block.hash.toLowerCase() };
  }

  async getLogs({ address, topics, fromBlock, toBlock }) {
    const result = await this.call("eth_getLogs", [{
      address,
      topics,
      fromBlock: quantity(fromBlock),
      toBlock: quantity(toBlock),
    }]);
    if (!Array.isArray(result)) throw new Error("RPC eth_getLogs result is not an array");
    return result;
  }
}
