export const BASE_MAINNET_CHAIN_ID = 8453n;
export const BASE_MAINNET_NETWORK = "base-mainnet";
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const WHP_PAYEE_ADDRESS = "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3";
export const USDC_SYMBOL = "USDC";
export const USDC_DECIMALS = 6;
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const OBSERVER_SCOPE = `eip155:${BASE_MAINNET_CHAIN_ID}:${BASE_USDC_ADDRESS}:${WHP_PAYEE_ADDRESS}`;

export function addressToTopic(address) {
  const normalized = normalizeAddress(address);
  return `0x${"0".repeat(24)}${normalized.slice(2)}`;
}

export function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Invalid EVM address: ${String(value)}`);
  }
  return value.toLowerCase();
}
