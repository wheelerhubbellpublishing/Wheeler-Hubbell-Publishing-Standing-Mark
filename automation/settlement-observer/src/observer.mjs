import { addressToTopic, ERC20_TRANSFER_TOPIC } from "./constants.mjs";
import { parseTransferLog } from "./events.mjs";
import { deliverPendingWebhooks } from "./webhook.mjs";

function serializeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export class SettlementObserver {
  #config;
  #rpc;
  #store;
  #notifier;
  #timer = null;
  #stopping = false;
  #syncing = false;

  constructor({ config, rpc, store, notifier = null, now = () => new Date() }) {
    this.#config = config;
    this.#rpc = rpc;
    this.#store = store;
    this.#notifier = notifier;
    this.now = now;
    this.runtime = {
      initialized: false,
      running: false,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastSkipReason: null,
      finalizedHead: null,
    };
  }

  async initialize() {
    await this.#store.ping();
    const actualChainId = await this.#rpc.getChainId();
    if (actualChainId !== this.#config.chainId) {
      throw new Error(`Wrong RPC chain: expected ${this.#config.chainId}, received ${actualChainId}`);
    }
    const finalized = await this.#rpc.getFinalizedBlock();
    const initialCursor = this.#config.startBlock === null
      ? finalized.number - 1n
      : this.#config.startBlock - 1n;
    await this.#store.initializeCursor(this.#config, initialCursor, finalized);
    this.runtime.initialized = true;
    this.runtime.finalizedHead = finalized.number.toString();
  }

  async syncOnce() {
    if (this.#syncing) return { skipped: true, reason: "already-syncing" };
    this.#syncing = true;
    this.runtime.lastPollAt = this.now().toISOString();
    try {
      if (!this.runtime.initialized) await this.initialize();
      const actualChainId = await this.#rpc.getChainId();
      if (actualChainId !== this.#config.chainId) {
        throw new Error(`Wrong RPC chain: expected ${this.#config.chainId}, received ${actualChainId}`);
      }
      const previousRuntimeHead = this.runtime.finalizedHead === null
        ? null
        : BigInt(this.runtime.finalizedHead);
      const finalized = await this.#rpc.getFinalizedBlock();
      const checkpoint = await this.#store.getCheckpoint(this.#config.scope);
      if (checkpoint === null) throw new Error("Observer cursor disappeared after initialization");
      if (
        previousRuntimeHead !== null
        && finalized.number < previousRuntimeHead
      ) {
        throw new Error(
          `RPC finalized head regressed during this process: ${finalized.number} < ${previousRuntimeHead}`,
        );
      }
      if (
        finalized.number < checkpoint.cursor
        || (
          checkpoint.reportedFinalizedBlock !== null
          && finalized.number < checkpoint.reportedFinalizedBlock
        )
      ) {
        const webhook = await deliverPendingWebhooks({
          store: this.#store,
          notifier: this.#notifier,
          scope: this.#config.scope,
          limit: this.#config.webhookBatchSize,
        });
        this.runtime.lastSuccessAt = this.now().toISOString();
        this.runtime.lastError = null;
        this.runtime.lastSkipReason = "rpc-finalized-head-behind-durable-checkpoint";
        return {
          skipped: true,
          reason: this.runtime.lastSkipReason,
          finalizedHead: finalized.number.toString(),
          durableCursor: checkpoint.cursor.toString(),
          webhook,
        };
      }
      if (
        checkpoint.reportedFinalizedBlock === finalized.number
        && checkpoint.reportedFinalizedHash
        && checkpoint.reportedFinalizedHash !== finalized.hash
      ) {
        throw new Error(`RPC changed the finalized block hash at height ${finalized.number}`);
      }
      if (
        checkpoint.reportedFinalizedBlock !== null
        && checkpoint.reportedFinalizedBlock < finalized.number
        && checkpoint.reportedFinalizedHash
      ) {
        const prior = await this.#rpc.getBlockByNumber(checkpoint.reportedFinalizedBlock);
        if (prior.hash !== checkpoint.reportedFinalizedHash) {
          throw new Error(
            `RPC no longer recognizes finalized checkpoint ${checkpoint.reportedFinalizedBlock}`,
          );
        }
      }
      this.runtime.finalizedHead = finalized.number.toString();
      let cursor = checkpoint.cursor;
      let batches = 0;
      let insertedCandidates = 0;

      while (cursor < finalized.number) {
        const fromBlock = cursor + 1n;
        const toBlock = fromBlock + this.#config.blockRange - 1n > finalized.number
          ? finalized.number
          : fromBlock + this.#config.blockRange - 1n;
        const logs = await this.#rpc.getLogs({
          address: this.#config.tokenAddress,
          topics: [ERC20_TRANSFER_TOPIC, null, addressToTopic(this.#config.payeeAddress)],
          fromBlock,
          toBlock,
        });
        const events = logs
          .map((log) => parseTransferLog(log, this.#config, finalized.number))
          .filter((event) => event.amountAtomic > 0n)
          .sort((left, right) => {
            if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
            return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
          });
        await this.#store.commitBatch(
          this.#config,
          events,
          toBlock,
          toBlock === finalized.number ? finalized : null,
        );
        cursor = toBlock;
        batches += 1;
        insertedCandidates += events.length;
      }

      if (batches === 0) {
        await this.#store.recordFinalizedHead(
          this.#config.scope,
          finalized.number,
          finalized.hash,
        );
      }

      const webhook = await deliverPendingWebhooks({
        store: this.#store,
        notifier: this.#notifier,
        scope: this.#config.scope,
        limit: this.#config.webhookBatchSize,
      });
      this.runtime.lastSuccessAt = this.now().toISOString();
      this.runtime.lastError = null;
      this.runtime.lastSkipReason = null;
      return {
        skipped: false,
        finalizedHead: finalized.number.toString(),
        cursor: cursor.toString(),
        batches,
        observedLogs: insertedCandidates,
        webhook,
      };
    } catch (error) {
      this.runtime.lastError = { message: serializeError(error), at: this.now().toISOString() };
      this.runtime.lastSkipReason = null;
      throw error;
    } finally {
      this.#syncing = false;
    }
  }

  async start() {
    if (this.runtime.running) return;
    this.runtime.running = true;
    this.#stopping = false;
    const poll = async () => {
      try {
        await this.syncOnce();
      } catch (error) {
        console.error(JSON.stringify({ level: "error", component: "observer", message: serializeError(error) }));
      }
      if (!this.#stopping) this.#timer = setTimeout(poll, this.#config.pollIntervalMs);
    };
    await poll();
  }

  stop() {
    this.#stopping = true;
    this.runtime.running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  snapshot() {
    return { ...this.runtime };
  }
}
