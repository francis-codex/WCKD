// Shared clients and the two ABI fragments the bot actually uses.
// Kept small on purpose: the fewer moving parts in the hot path, the fewer
// things that can be slow or wrong at 2pm.

import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  parseAbi,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { RPC_HTTP, RPC_WSS } from './config.js';

export const http_ = createPublicClient({ chain: base, transport: http(RPC_HTTP) });

/**
 * The WebSocket client is optional and created lazily.
 *
 * The public endpoint (mainnet.base.org) answers 405 to an upgrade request — it
 * serves no WebSocket at all. So this returns null rather than hanging, and the
 * caller falls back to polling and says so out loud. Point BASE_WSS at a real
 * provider (Alchemy, QuickNode) before launch: the difference is hearing the
 * block versus hearing about it.
 */
let wsClient: any;

export function getWs() {
  if (wsClient !== undefined) return wsClient;
  if (!RPC_WSS.startsWith('ws')) {
    wsClient = null;
    return wsClient;
  }
  try {
    wsClient = createPublicClient({
      chain: base,
      transport: webSocket(RPC_WSS, { retryCount: 10, retryDelay: 400 }),
    });
  } catch {
    wsClient = null;
  }
  return wsClient;
}

/** Never let a hung socket hold the whole process open. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export function walletFor(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    client: createWalletClient({ account, chain: base, transport: http(RPC_HTTP) }),
  };
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const wethAbi = parseAbi([
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
]);

/** SwapRouter02. One function, the only one in the hot path. */
export const routerAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

/** Uniswap V3 pool — we only ever read from it. */
export const poolAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);

/** Just enough to ask an unknown address "are you a WETH pool, and at what fee?" */
export const poolAbi2 = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

export const fmtEth = (wei: bigint) => (Number(wei) / 1e18).toLocaleString('en-GB', { maximumFractionDigits: 6 });
export const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
