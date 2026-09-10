// Wrap + approve for everyone who is funded, callable from Telegram.
//
// This is the work that must NOT happen at launch time. An approval costs a
// whole transaction and a whole block, so doing it at 1pm means arriving late
// every single time, guaranteed. Doing it at noon means the launch transaction
// is one swap and nothing else.

import { formatEther, parseEther, maxUint256 } from 'viem';
import { WETH, ROUTER, LAPTOP, type SniperWallet } from './config.js';
import { http_, walletFor, erc20Abi, wethAbi } from './chain.js';

export interface PrepLine {
  name: string;
  ok: boolean;
  detail: string;
}

export async function prepareOne(w: SniperWallet, live: boolean): Promise<PrepLine> {
  const { account, client } = walletFor(w.privateKey);
  const need = parseEther(String(w.spendEth));

  try {
    const [eth, weth, allowance] = await Promise.all([
      http_.getBalance({ address: account.address }),
      http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [account.address, ROUTER] }),
    ]);

    const steps: string[] = [];

    if (weth < need) {
      const shortfall = need - weth;
      // Keep gas back. A wallet that wrapped every last wei cannot pay to swap.
      const reserve = parseEther('0.0004');
      if (eth < shortfall + reserve) {
        return {
          name: w.name,
          ok: false,
          detail: `needs ${formatEther(shortfall + reserve)} ETH, holds ${formatEther(eth)}. Fund it.`,
        };
      }
      if (!live) steps.push(`would wrap ${formatEther(shortfall)}`);
      else {
        const hash = await client.writeContract({
          address: WETH, abi: wethAbi, functionName: 'deposit', value: shortfall,
        });
        await http_.waitForTransactionReceipt({ hash });
        steps.push(`wrapped ${formatEther(shortfall)}`);
      }
    } else {
      steps.push('WETH ready');
    }

    if (allowance < need) {
      if (!live) steps.push('would approve router');
      else {
        const hash = await client.writeContract({
          address: WETH, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256],
        });
        await http_.waitForTransactionReceipt({ hash });
        steps.push('approved router');
      }
    } else {
      steps.push('router approved');
    }

    // Approve LAPTOP for the router NOW, before we own any. Approval does not
    // need a balance, and doing it here means the eventual SELL is one
    // transaction instead of approve-then-swap. On a launch dump that is the
    // difference between getting out and watching yourself not get out.
    try {
      const lapAllow = await http_.readContract({
        address: LAPTOP, abi: erc20Abi, functionName: 'allowance', args: [account.address, ROUTER],
      });
      if (lapAllow < maxUint256 / 2n) {
        if (!live) steps.push('would pre-approve LAPTOP for selling');
        else {
          const hash = await client.writeContract({
            address: LAPTOP, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256],
          });
          await http_.waitForTransactionReceipt({ hash });
          steps.push('sell pre-approved');
        }
      } else {
        steps.push('sell ready');
      }
    } catch {
      steps.push('sell approval failed — you can still sell, it just costs one extra tx');
    }

    return { name: w.name, ok: true, detail: steps.join(', ') };
  } catch (e) {
    return { name: w.name, ok: false, detail: (e as Error).message.split('\n')[0] };
  }
}

/** Prep is real work with real gas, so it runs for real even when ARMED is off —
 *  wrapping and approving cannot lose you anything, and being prepped is the
 *  whole point. `live` is passed explicitly by the caller. */
export async function prepareAll(wallets: SniperWallet[], live: boolean): Promise<PrepLine[]> {
  const out: PrepLine[] = [];
  for (const w of wallets) out.push(await prepareOne(w, live));
  return out;
}
