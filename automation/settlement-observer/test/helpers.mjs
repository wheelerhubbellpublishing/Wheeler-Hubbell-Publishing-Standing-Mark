export class FakeStore {
  constructor() {
    this.cursor = null;
    this.events = [];
    this.commits = [];
    this.reportedFinalizedBlock = null;
    this.reportedFinalizedHash = null;
  }

  async ping() {}

  async initializeCursor(_config, cursor, finalized) {
    if (this.cursor === null) {
      this.cursor = cursor;
      this.reportedFinalizedBlock = finalized.number;
      this.reportedFinalizedHash = finalized.hash;
    }
    return this.cursor;
  }

  async getCursor() {
    return this.cursor;
  }

  async getCheckpoint() {
    if (this.cursor === null) return null;
    return {
      cursor: this.cursor,
      reportedFinalizedBlock: this.reportedFinalizedBlock,
      reportedFinalizedHash: this.reportedFinalizedHash,
    };
  }

  async recordFinalizedHead(_scope, number, hash) {
    if (this.reportedFinalizedBlock !== null && number < this.reportedFinalizedBlock) {
      throw new Error("Refused finalized regression");
    }
    if (
      number === this.reportedFinalizedBlock
      && this.reportedFinalizedHash !== null
      && hash !== this.reportedFinalizedHash
    ) throw new Error("Refused finalized hash replacement");
    this.reportedFinalizedBlock = number;
    this.reportedFinalizedHash = hash;
  }

  async commitBatch(_config, events, throughBlock, finalizedCheckpoint = null) {
    const existing = new Set(this.events.map((event) => event.eventKey));
    for (const event of events) if (!existing.has(event.eventKey)) this.events.push(event);
    this.cursor = throughBlock;
    if (
      finalizedCheckpoint
      && (
        this.reportedFinalizedBlock === null
        || finalizedCheckpoint.number > this.reportedFinalizedBlock
      )
    ) {
      this.reportedFinalizedBlock = finalizedCheckpoint.number;
      this.reportedFinalizedHash = finalizedCheckpoint.hash;
    }
    this.commits.push({ events, throughBlock });
  }

  async claimPendingWebhookEvents() { return []; }
}

export function testConfig(overrides = {}) {
  return {
    chainId: 8453n,
    network: "base-mainnet",
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    payeeAddress: "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3",
    scope: "test-scope",
    startBlock: null,
    blockRange: 2n,
    pollIntervalMs: 5000,
    webhookBatchSize: 20,
    ...overrides,
  };
}

export function transferLog({
  blockNumber = 101n,
  logIndex = 0n,
  amount = 1_000_000n,
  from = "0x1111111111111111111111111111111111111111",
  to = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3",
} = {}) {
  const padded = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
  return {
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      padded(from),
      padded(to),
    ],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    blockHash: `0x${"cd".repeat(32)}`,
    removed: false,
  };
}
