import { ERC20_TRANSFER_TOPIC, normalizeAddress } from "./constants.mjs";
import { parseQuantity } from "./rpc.mjs";

function topicToAddress(topic, fieldName) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error(`Invalid ${fieldName} topic`);
  }
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

export function parseTransferLog(log, config, finalizedHead) {
  if (log?.removed === true) throw new Error("Finalized RPC returned a removed log");
  if (!Array.isArray(log?.topics) || log.topics.length !== 3) throw new Error("Transfer log must have exactly three topics");
  if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) throw new Error("Unexpected event topic");
  if (normalizeAddress(log.address) !== config.tokenAddress) throw new Error("Unexpected token address");

  const fromAddress = topicToAddress(log.topics[1], "from");
  const toAddress = topicToAddress(log.topics[2], "to");
  if (toAddress !== config.payeeAddress) throw new Error("Unexpected transfer recipient");
  if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
    throw new Error("Invalid Transfer amount data");
  }

  const blockNumber = parseQuantity(log.blockNumber, "log block number");
  const logIndex = parseQuantity(log.logIndex, "log index");
  if (blockNumber > finalizedHead) throw new Error("RPC returned a log above the finalized head");
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash || "")) throw new Error("Invalid transaction hash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.blockHash || "")) throw new Error("Invalid block hash");

  const transactionHash = log.transactionHash.toLowerCase();
  return Object.freeze({
    eventKey: `${config.chainId}:${transactionHash}:${logIndex}`,
    scope: config.scope,
    chainId: config.chainId,
    network: config.network,
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: config.tokenDecimals,
    payeeAddress: config.payeeAddress,
    fromAddress,
    toAddress,
    amountAtomic: BigInt(log.data),
    transactionHash,
    logIndex,
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    finality: "finalized",
    finalizedHead,
  });
}

export function formatTokenAmount(amountAtomic, decimals) {
  const value = typeof amountAtomic === "bigint" ? amountAtomic : BigInt(amountAtomic);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
