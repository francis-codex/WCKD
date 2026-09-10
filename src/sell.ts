// Getting out.
//
// The buy is a race; the sell is a panic. Different problem, same requirement:
// one transaction, no thinking, no app switching. /prep already approved LAPTOP
// for the router, so this is a single swap.
//
// Slippage is wide on purpose. In a dump the price you saw a second ago is not
// the price you get, and a sell that reverts on slippage means holding the whole
// bag through the next leg down. Getting out at a bad price beats not getting out.

import { parseGwei, type Address } from 'viem';
import {
  LAPTOP, WETH, ROUTER, PRIORITY_FEE_GWEI, MAX_FEE_MULTIPLIER, SWAP_GAS_LIMIT,
} from './config.js';
import { http_, walletFor, routerAbi, erc20Abi } from './chain.js';
import { privateKeyOf, type StoredWallet } from './store.js';

export interface SellResult {
  name: string;
  address: Address;
  sold?: bigint;
  hash?: string;
  error?: string;
}

/**
 * Sell a percentage of whatever LAPTOP this wallet holds.
 *
 * `percent` is 1-100. Selling a share rather than a fixed amount means the
 * caller never has to know the balance, which matters when they are typing
 * one-handed watching a chart.
 */
export async function sell(w: StoredWallet, percent: number): Promise<SellResult> {
  const { account, client } = walletFor(privateKeyOf(w));

  try {
    const held = await http_.readContract({
      address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
    });
    if (held === 0n) {
      return { name: w.handle, address: account.address, error: 'holding no LAPTOP' };
    }

    const amountIn = (held * BigInt(Math.round(percent))) / 100n;
    if (amountIn === 0n) {
      return { name: w.handle, address: account.address, error: 'that percentage rounds to nothing' };
    }

    let maxFeePerGas: bigint;
    let maxPriorityFeePerGas: bigint;
    try {
      const block = await http_.getBlock({ blockTag: 'latest' });
      const base = block.baseFeePerGas ?? parseGwei('0.01');
      maxPriorityFeePerGas = parseGwei(String(PRIORITY_FEE_GWEI));
      maxFeePerGas = base * BigInt(Math.max(2, Math.round(MAX_FEE_MULTIPLIER))) + maxPriorityFeePerGas;
    } catch {
      maxPriorityFeePerGas = parseGwei('1.5');
      maxFeePerGas = parseGwei('5');
    }

    // Same rule as the buy: never bid more than the balance can reserve, or the
    // transaction is rejected outright instead of merely being slow.
    try {
      const bal = await http_.getBalance({ address: account.address });
      const affordable = (bal * 95n) / 100n / SWAP_GAS_LIMIT;
      if (affordable > 0n && maxFeePerGas > affordable) {
        maxFeePerGas = affordable;
        if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
      }
    } catch { /* go with what we computed */ }

    const hash = await client.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: LAPTOP,
        tokenOut: WETH,
        fee: w.soldFee ?? 10000,
        recipient: account.address,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
      chain: undefined,
      gas: SWAP_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: await http_.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    });

    return { name: w.handle, address: account.address, sold: amountIn, hash };
  } catch (e) {
    return { name: w.handle, address: account.address, error: (e as Error).message.split('\n')[0] };
  }
}
