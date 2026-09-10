// Everything the sniper needs to know, in one place.
//
// The target is $LAPTOP on Base. Its contract has been live since before launch
// and its two Uniswap V3 pools already exist — what has NOT happened is anyone
// putting LAPTOP into them. That arrival is the starting gun, and it is why this
// watches the chain instead of watching X for a contract address that was
// public all along.

import 'dotenv/config';
import { getAddress, type Address } from 'viem';

/** $LAPTOP. Verified against Base RPC: name/symbol LAPTOP, supply 1e27. */
export const LAPTOP: Address = getAddress('0xB095274743941e953c746F9C228DA9c18Bb6ec29');

/** Canonical WETH on Base. We buy with WETH, never raw ETH — see prepare.ts. */
export const WETH: Address = getAddress('0x4200000000000000000000000000000000000006');

/** Uniswap SwapRouter02 on Base. */
export const ROUTER: Address = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481');

/**
 * The pools that already exist. Both held zero LAPTOP at 23:25 on 8 Sept, so
 * either one filling is the signal. The 0.05% pool already carries a one-sided
 * WETH position, which means somebody else is parked and waiting too.
 */
export const POOLS: { address: Address; fee: number; label: string; buyable: boolean }[] = [
  { address: getAddress('0x7ed7bfbcc7167fcb87f43ca730548dd52547e774'), fee: 500, label: 'WETH 0.05%', buyable: true },
  { address: getAddress('0x9e235c14fc46534906d5b2709c0fc40014862cec'), fee: 3000, label: 'WETH 0.3%', buyable: true },
  { address: getAddress('0xa321d950082166d11db11cfbd6e32a91e6144ff0'), fee: 10000, label: 'WETH 1%', buyable: true },
  // USDC-paired. We hold WETH, so this cannot be bought through directly —
  // watched so that if the launch lands here we hear about it in the same
  // second and can act by hand, rather than staring at three empty pools.
  { address: getAddress('0x7702411b3893ea4f6ab96c50231cfec65448ab9f'), fee: 10000, label: 'USDC 1%', buyable: false },
];

export const CHAIN_ID = 8453;

/**
 * A public endpoint works, but a paid one is the difference between hearing the
 * block and hearing about it. Set BASE_WSS to your own before launch.
 */
export const RPC_HTTP = process.env.BASE_HTTP?.trim() || 'https://mainnet.base.org';
export const RPC_WSS = process.env.BASE_WSS?.trim() || 'wss://mainnet.base.org';

/**
 * ARMED is the safety catch. Everything runs identically without it — the
 * watcher subscribes, the trigger fires, the swap is built and priced — and
 * then it prints the transaction instead of sending it. Nothing spends until a
 * human sets ARMED=true.
 */
export const ARMED = process.env.ARMED?.trim().toLowerCase() === 'true';

/**
 * Refuse to send more than this per wallet however the env is set. A typo in a
 * spend amount should cost a rounding error, not a wallet.
 */
export const HARD_CAP_ETH = 0.25;

/**
 * Do not treat a pool as launched until it holds at least this much LAPTOP.
 *
 * Anyone can send 1 wei of LAPTOP to a pool address for a few cents. Without a
 * floor, that dust looks identical to a launch: we fire into a pool with no
 * real liquidity and, with amountOutMinimum at 0, hand over the whole buy for
 * nothing. It is a cheap and well-known attack on exactly this trigger.
 *
 * Supply is 1e9 tokens. A genuine launch puts a meaningful slice in; 100,000
 * tokens is 0.01% of supply and far above anything worth spending gas to fake.
 */
export const MIN_POOL_TOKENS = 100_000n * 10n ** 18n;

/** Also require the pool to hold real WETH, so a one-sided dust add cannot pass. */
export const MIN_POOL_WETH_WEI = 10n ** 17n; // 0.1 WETH

export interface SniperWallet {
  name: string;
  privateKey: `0x${string}`;
  /** WETH to spend, in ether units. */
  spendEth: number;
  /** Floor on what we accept back, in basis points of the quote. 0 = accept anything. */
  minOutBps: number;
}

function readWallet(idx: number): SniperWallet | null {
  const pk = process.env[`SNIPER_${idx}_PK`]?.trim();
  if (!pk) return null;

  const name = process.env[`SNIPER_${idx}_NAME`]?.trim() || `wallet-${idx}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(`SNIPER_${idx}_PK is not a 32-byte hex private key`);
  }

  const spend = Number(process.env[`SNIPER_${idx}_SPEND`] ?? '0');
  if (!Number.isFinite(spend) || spend <= 0) {
    throw new Error(`SNIPER_${idx}_SPEND must be a positive number of ETH`);
  }
  if (spend > HARD_CAP_ETH) {
    throw new Error(
      `SNIPER_${idx}_SPEND is ${spend} ETH, above the ${HARD_CAP_ETH} hard cap. ` +
        'Raise HARD_CAP_ETH deliberately if you really mean it.',
    );
  }

  return {
    name,
    privateKey: pk as `0x${string}`,
    spendEth: spend,
    // Default 0. A launch snipe that reverts on slippage is a lost snipe; the
    // protection that matters here is the size of the buy, not the price.
    minOutBps: Number(process.env[`SNIPER_${idx}_MIN_OUT_BPS`] ?? '0'),
  };
}

/**
 * Each user runs their own key and funds it themselves. Neither can spend the
 * other's — there is no shared wallet and no pooled money, by design.
 */
export function loadWallets(): SniperWallet[] {
  const found = [1, 2, 3, 4].map(readWallet).filter((w): w is SniperWallet => w !== null);
  if (found.length === 0) {
    throw new Error('No wallets configured. Set SNIPER_1_PK and SNIPER_1_SPEND.');
  }
  return found;
}

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
export const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID?.trim() || '';

/**
 * Gas headroom over the current base fee. A launch block is contested and being
 * outbid by a gwei costs the whole trade, so we overpay on purpose.
 */
// 0.05 gwei was the quiet-day rate and it would have put us behind everybody.
// On a contested launch people bid whole gwei. At a 250k gas limit, 1.5 gwei of
// priority costs about $1 on an $824 position — obviously worth paying to be
// near the front of the block rather than politely at the back.
export const PRIORITY_FEE_GWEI = Number(process.env.PRIORITY_FEE_GWEI ?? '1.5');
export const MAX_FEE_MULTIPLIER = Number(process.env.MAX_FEE_MULTIPLIER ?? '3');

/**
 * A Uniswap V3 exactInputSingle lands around 150k. 400k was padding, but the
 * transaction must RESERVE maxFee × gasLimit up front, and most of these
 * wallets hold only 0.002 ETH — so an oversized limit was capping how hard we
 * could bid. Unused gas is refunded either way.
 */
export const SWAP_GAS_LIMIT = 250_000n;


/** 13:00 WAT on 9 Sept 2026 = 12:00 UTC. Announced by the project itself. */
export const LAUNCH_AT = Date.UTC(2026, 8, 9, 12, 0, 0);

/** Human countdown, used in the heartbeat and in /status. */
export function countdown(): string {
  const ms = LAUNCH_AT - Date.now();
  if (ms <= 0) return 'launch window is OPEN';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m until 1:00pm WAT` : `${m}m until 1:00pm WAT`;
}
