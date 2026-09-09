// Run this WELL BEFORE the launch window. It does the two slow things so they
// are not sitting in the hot path:
//
//   1. wraps ETH into WETH
//   2. approves SwapRouter02 to spend it
//
// An approval costs a whole transaction and a whole block. Doing it at launch
// time means arriving one block late, every time, guaranteed. Doing it now
// means the launch transaction is a single swap.
//
//   npm run prep

import { formatEther, parseEther, maxUint256 } from 'viem';
import { LAPTOP, WETH, ROUTER, ARMED, loadWallets, POOLS, type SniperWallet } from './config.js';
import { http_, walletFor, erc20Abi, wethAbi, poolAbi, fmtEth } from './chain.js';
import { armedWallets, privateKeyOf } from './store.js';

/** Telegram wallets first, .env as the fallback — same rule as the watcher. */
function everyone(): SniperWallet[] {
  const fromTelegram = armedWallets().map((w) => ({
    name: w.handle,
    privateKey: privateKeyOf(w),
    spendEth: w.spendEth,
    minOutBps: 0,
  }));
  if (fromTelegram.length) return fromTelegram;
  try { return loadWallets(); } catch { return []; }
}

async function main() {
  const wallets = everyone();
  if (!wallets.length) {
    console.log('\nNobody to prepare yet. Send /start to the bot, fund the address,');
    console.log('set /spend, then run this again.\n');
    return;
  }
  console.log(`\nPreparing ${wallets.length} wallet(s). ARMED=${ARMED}\n`);

  for (const w of wallets) {
    const { account, client } = walletFor(w.privateKey);
    const need = parseEther(String(w.spendEth));

    const [eth, weth, allowance] = await Promise.all([
      http_.getBalance({ address: account.address }),
      http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [account.address, ROUTER] }),
    ]);

    console.log(`${w.name}  ${account.address}`);
    console.log(`  ETH ${formatEther(eth)}   WETH ${formatEther(weth)}   wants to spend ${w.spendEth}`);

    // --- wrap -------------------------------------------------------------
    if (weth < need) {
      const short = need - weth;
      if (eth < short) {
        console.log(`  ✗ needs ${formatEther(short)} more ETH to wrap, has ${formatEther(eth)}. Fund it.`);
        continue;
      }
      if (!ARMED) {
        console.log(`  · would wrap ${formatEther(short)} ETH → WETH  (dry run)`);
      } else {
        const hash = await client.writeContract({
          address: WETH, abi: wethAbi, functionName: 'deposit', value: short,
        });
        await http_.waitForTransactionReceipt({ hash });
        console.log(`  ✓ wrapped ${formatEther(short)} ETH → WETH`);
      }
    } else {
      console.log('  ✓ already holds enough WETH');
    }

    // --- approve ----------------------------------------------------------
    // Infinite approval on a throwaway sniping wallet is the right trade: the
    // wallet holds only what it is about to spend, and a per-trade approval
    // costs a block we cannot afford.
    if (allowance < need) {
      if (!ARMED) {
        console.log('  · would approve SwapRouter02 for WETH  (dry run)');
      } else {
        const hash = await client.writeContract({
          address: WETH, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256],
        });
        await http_.waitForTransactionReceipt({ hash });
        console.log('  ✓ approved SwapRouter02');
      }
    } else {
      console.log('  ✓ router already approved');
    }

    // Leave gas behind. A wallet that wrapped every last wei cannot pay to swap.
    const left = await http_.getBalance({ address: account.address });
    if (left < parseEther('0.0004')) {
      console.log(`  ⚠ only ${formatEther(left)} ETH left for gas. Top it up.`);
    }
    console.log('');
  }

  // --- has it already started? ---------------------------------------------
  console.log('Pool state right now:');
  for (const p of POOLS) {
    const [bal, liq] = await Promise.all([
      http_.readContract({ address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] }),
      http_.readContract({ address: p.address, abi: poolAbi, functionName: 'liquidity' }),
    ]);
    const started = bal > 0n;
    console.log(`  ${p.label.padEnd(6)} ${p.address}  LAPTOP ${fmtEth(bal).padStart(18)}  liquidity ${liq}`);
    if (started) console.log('    ⚠ THIS POOL ALREADY HAS LAPTOP IN IT — the launch may have happened.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\nprepare failed:', e.message ?? e);
  process.exit(1);
});
