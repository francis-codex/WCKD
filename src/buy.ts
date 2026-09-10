// The hot path. Everything expensive has already happened in prepare.ts, so
// this builds one transaction and sends it.
//
// Deliberate choices, because a launch is not a normal trade:
//
//   · amountOutMinimum defaults to 0. A snipe that reverts on slippage is a
//     lost snipe. What bounds the loss here is the SIZE of the buy, not the
//     price — that is why there is a hard cap in config.
//   · gas is overpaid on purpose. Being outbid by a gwei costs the trade.
//   · no simulation before sending. Simulating costs a round trip, and the
//     pool state we would simulate against is the one we are racing.

import { parseEther, parseGwei, type Address } from 'viem';
import {
  LAPTOP, WETH, ROUTER, CHAIN_ID,
  PRIORITY_FEE_GWEI, MAX_FEE_MULTIPLIER, SWAP_GAS_LIMIT, type SniperWallet,
} from './config.js';
import { isArmed } from './runtime.js';
import { http_, walletFor, routerAbi } from './chain.js';
import { notify, basescanTx } from './notify.js';
import { all as allWallets, setSoldFee } from './store.js';

export interface BuyResult {
  wallet: string;
  address: Address;
  hash?: string;
  error?: string;
  dryRun?: boolean;
}

export async function buy(w: SniperWallet, fee: number): Promise<BuyResult> {
  const { account, client } = walletFor(w.privateKey);
  const amountIn = parseEther(String(w.spendEth));

  // 5 minutes is generous, but a deadline is a safety net, not a strategy.
  const params = {
    tokenIn: WETH,
    tokenOut: LAPTOP,
    fee,
    recipient: account.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  } as const;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const block = await http_.getBlock({ blockTag: 'latest' });
    const base = block.baseFeePerGas ?? parseGwei('0.01');
    maxPriorityFeePerGas = parseGwei(String(PRIORITY_FEE_GWEI));
    maxFeePerGas = base * BigInt(Math.max(2, Math.round(MAX_FEE_MULTIPLIER))) + maxPriorityFeePerGas;
  } catch {
    // If we cannot read the block we still want to fire, just cautiously high.
    maxPriorityFeePerGas = parseGwei('0.05');
    maxFeePerGas = parseGwei('0.5');
  }

  // A transaction whose maxFee × gasLimit exceeds the wallet's ETH is REJECTED
  // outright — not outbid, not slow, simply never broadcast. Being outbid is a
  // maybe; failing to submit is a certain miss. So bid as hard as the balance
  // allows and no harder.
  try {
    const bal = await http_.getBalance({ address: account.address });
    const affordable = (bal * 95n) / 100n / SWAP_GAS_LIMIT; // 5% back for the wrap of rounding
    if (affordable > 0n && maxFeePerGas > affordable) {
      maxFeePerGas = affordable;
      if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
    }
  } catch {
    /* if we cannot read the balance, go with what we computed */
  }

  if (!isArmed()) {
    return {
      wallet: w.name,
      address: account.address,
      dryRun: true,
      hash: undefined,
      error: undefined,
    };
  }

  try {
    const hash = await client.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [params],
      chain: undefined,
      // A fixed limit skips an estimateGas round trip, and a tighter one frees
      // up balance to bid harder on priority.
      gas: SWAP_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: await http_.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    });
    return { wallet: w.name, address: account.address, hash };
  } catch (e) {
    return { wallet: w.name, address: account.address, error: (e as Error).message.split('\n')[0] };
  }
}

/** Fire every wallet at once. One failing must never hold up another. */
export async function buyAll(wallets: SniperWallet[], fee: number, poolLabel: string) {
  await notify(
    `🚨 <b>LAUNCH DETECTED</b> — LAPTOP is in the ${poolLabel} pool.\n` +
      `Firing ${wallets.length} wallet(s)${isArmed() ? '' : ' <b>(NOT ARMED — nothing sent)</b>'}…`,
  );

  const results = await Promise.all(wallets.map((w) => buy(w, fee)));
  // Remember the tier so /sell routes back through the same pool.
  for (const sw of allWallets()) setSoldFee(sw.telegramId, fee);

  for (const r of results) {
    if (r.dryRun) {
      await notify(`· <b>${r.wallet}</b> would have bought ${r.address}\n<i>Not armed, so nothing was sent.</i>`);
    } else if (r.hash) {
      await notify(`✅ <b>${r.wallet}</b> sent\n${basescanTx(r.hash)}`);
    } else {
      await notify(`❌ <b>${r.wallet}</b> failed\n<code>${r.error}</code>`);
    }
  }
  return results;
}
