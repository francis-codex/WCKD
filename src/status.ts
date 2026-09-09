// A pre-flight you can run any time, including before any key exists.
// Answers the only questions that matter before the window opens:
// is the chain reachable, is the socket alive, and has it started without us.
//
//   npm run status

import { formatEther } from 'viem';
import { LAPTOP, POOLS, ARMED, RPC_HTTP, RPC_WSS, TELEGRAM_TOKEN, TELEGRAM_CHAT } from './config.js';
import { http_, getWs, withTimeout, erc20Abi, poolAbi } from './chain.js';

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;

async function main() {
  console.log('\nWCKD — pre-flight\n');

  // --- chain ---------------------------------------------------------------
  try {
    const block = await http_.getBlockNumber();
    console.log(ok(`HTTP reachable — Base block ${block}`));
  } catch (e) {
    console.log(bad(`HTTP failed (${RPC_HTTP}): ${(e as Error).message}`));
  }

  const wsc = getWs();
  if (!wsc) {
    console.log(bad(`No WebSocket configured (${RPC_WSS})`));
  } else {
    try {
      const block = await withTimeout(wsc.getBlockNumber(), 6000, 'WebSocket');
      console.log(ok(`WebSocket reachable — block ${block}`));
    } catch (e) {
      console.log(bad(`WebSocket failed (${RPC_WSS}): ${(e as Error).message}`));
      console.log('    The PUBLIC Base endpoint serves no WebSocket — it answers 405.');
      console.log('    Get a Base WSS url from Alchemy or QuickNode and set BASE_WSS.');
      console.log('    Without it the bot polls every 2s, which is up to 2s late.');
    }
  }

  // --- has it started? -----------------------------------------------------
  console.log('\nPools:');
  let started = false;
  for (const p of POOLS) {
    try {
      const [bal, liq] = await Promise.all([
        http_.readContract({ address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] }),
        http_.readContract({ address: p.address, abi: poolAbi, functionName: 'liquidity' }),
      ]);
      const flag = bal > 0n ? '  ← HAS LAPTOP' : '';
      console.log(`  ${p.label.padEnd(6)} ${p.address}`);
      console.log(`         LAPTOP ${formatEther(bal).padStart(20)}   liquidity ${liq}${flag}`);
      if (bal > 0n) started = true;
    } catch (e) {
      console.log(bad(`could not read ${p.label} pool: ${(e as Error).message}`));
    }
  }

  console.log(
    started
      ? '\n🔴 LAUNCH HAS ALREADY HAPPENED — a pool holds LAPTOP. Do not auto-buy into it.'
      : '\n🟢 Both pools still empty. Nothing has launched.',
  );

  // --- config --------------------------------------------------------------
  console.log('\nConfig:');
  console.log(TELEGRAM_TOKEN && TELEGRAM_CHAT ? ok('Telegram configured') : bad('Telegram not configured — you will only see the terminal'));

  // Check the key is actually a key. A placeholder "0x" left in from
  // .env.example is worse than nothing: it reads as configured and then fails
  // at the worst possible moment.
  let real = 0;
  let placeholder = 0;
  for (const i of [1, 2, 3, 4]) {
    const pk = process.env[`SNIPER_${i}_PK`]?.trim();
    if (!pk) continue;
    if (/^0x[0-9a-fA-F]{64}$/.test(pk)) real++;
    else placeholder++;
  }
  if (real) console.log(ok(`${real} wallet(s) with a real key`));
  if (placeholder) console.log(bad(`${placeholder} wallet slot(s) still hold a placeholder, not a key`));
  if (!real && !placeholder) console.log(bad('No wallets configured yet'));

  console.log(
    ARMED
      ? '\n🔴 ARMED=true — a fill WILL spend real money.\n'
      : '\n🟡 ARMED=false — dry run. It will detect and report, and send nothing.\n',
  );

  process.exit(0);
}

main().catch((e) => {
  console.error('\nstatus failed:', e.message ?? e);
  process.exit(1);
});
