// The watcher.
//
// Two independent ways of noticing the same thing, because a launch happens
// once and a dropped WebSocket at the wrong second is the whole game:
//
//   1. a live log subscription — LAPTOP Transfer events where `to` is a pool
//   2. a balance poll every 2s — the same question asked the slow way
//
// Whichever notices first wins, and a latch makes sure only one of them ever
// fires the buy.
//
//   npm run watch

import { formatEther } from 'viem';
import {
  LAPTOP, WETH, POOLS, loadWallets, RPC_WSS, HARD_CAP_ETH,
  MIN_POOL_TOKENS, MIN_POOL_WETH_WEI, countdown, type SniperWallet,
} from './config.js';
import { isArmed, restoredFromDisk, armAgeMinutes, isPrepped } from './runtime.js';
import { http_, getWs, erc20Abi, short } from './chain.js';
import { buyAll } from './buy.js';
import { notify } from './notify.js';
import { runBot } from './bot.js';
import { armedWallets, privateKeyOf } from './store.js';

/** Set the instant anything fires, so the poll and the socket cannot double-buy. */
let fired = false;

/**
 * Wallets come from Telegram first — people who texted /start, funded the
 * address they were given, and set a spend. The .env path stays as a fallback
 * so the bot still works with no Telegram configured.
 *
 * Read at fire time, not at boot: somebody funding their wallet at 12:58 should
 * still be in.
 */
function currentWallets(): SniperWallet[] {
  const fromTelegram = armedWallets().map((w) => ({
    name: w.handle,
    privateKey: privateKeyOf(w),
    spendEth: w.spendEth,
    minOutBps: 0,
  }));
  if (fromTelegram.length) return fromTelegram;
  try {
    return loadWallets();
  } catch {
    return [];
  }
}

/**
 * Is this a real launch, or somebody's dust?
 *
 * Both sides have to be there. A pool holding tokens but no WETH is a one-sided
 * add — buying into it hands over the whole order for nothing.
 */
async function looksReal(poolAddress: `0x${string}`): Promise<{ ok: boolean; laptop: bigint; weth: bigint }> {
  const [laptop, weth] = await Promise.all([
    http_.readContract({ address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }).catch(() => 0n),
    http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }).catch(() => 0n),
  ]);
  return { ok: laptop >= MIN_POOL_TOKENS && weth >= MIN_POOL_WETH_WEI, laptop, weth };
}

async function trigger(poolAddress: string, fee: number, label: string, how: string) {
  if (fired) return;

  const pool = poolAddress as `0x${string}`;
  const check = await looksReal(pool);
  if (!check.ok) {
    // Deliberately do NOT latch. This was dust or a partial add; the real one
    // may still be seconds away and we must still be watching for it.
    console.log(
      `  · ignoring ${label}: ${formatEther(check.laptop)} LAPTOP / ${formatEther(check.weth)} WETH — below the floor`,
    );
    if (!dustWarned) {
      dustWarned = true;
      await notify(
        `👀 Something touched the ${label} pool but it is below the floor ` +
          `(${formatEther(check.laptop)} LAPTOP, ${formatEther(check.weth)} WETH).\n` +
          `<i>Not firing. Still watching.</i>`,
      );
    }
    return;
  }

  fired = true;
  const amount = check.laptop;

  const wallets = currentWallets();
  await notify(
    `Signal from <b>${how}</b> — ${formatEther(amount)} LAPTOP now in the ${label} pool.`,
  );
  if (!wallets.length) {
    await notify('⚠️ Nobody has a funded wallet with a spend set. Nothing to fire.');
    return;
  }
  await buyAll(wallets, fee, label);
  await notify('Done. Watcher stays up — check Basescan for fills.');
}

/** Only warn once, however many pools drop. */
let wsWarned = false;
/** Only mention dust once — it could be spammed deliberately. */
let dustWarned = false;

/** Returns false when there is no usable socket, so the caller can warn loudly. */
function watchLogs(): boolean {
  const wsc = getWs();
  if (!wsc) return false;

  try {
    for (const p of POOLS) {
      wsc.watchContractEvent({
        address: LAPTOP,
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { to: p.address },
        onLogs: (logs: unknown[]) => {
          if (!logs.length) return;
          void trigger(p.address, p.fee, p.label, 'log subscription');
        },
        onError: (e: Error) => {
          console.error(`  ws error on ${p.label}:`, e.message);
          // The socket fails ASYNCHRONOUSLY, so returning true above was
          // optimistic. Say so once, plainly, rather than leaving a "live"
          // message on screen that is not true.
          if (!wsWarned) {
            wsWarned = true;
            console.error('  ⚠ the log subscription is NOT working — running on the 2s poll only.');
            void notify('⚠️ <b>WebSocket died</b> — running on the 2s poll, so up to 2s late. Set <code>BASE_WSS</code> to an Alchemy Base url.');
          }
        },
      });
    }
    return true;
  } catch (e) {
    console.error('  could not open the log subscription:', (e as Error).message);
    return false;
  }
}

async function pollBalances() {
  while (!fired) {
    for (const p of POOLS) {
      try {
        const bal = await http_.readContract({
          address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address],
        });
        if (bal > 0n) {
          await trigger(p.address, p.fee, p.label, 'balance poll');
          return;
        }
      } catch {
        // A failed read is not news. The next one is 2 seconds away.
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Say what is true and, more usefully, what is still missing. Somebody should
 * be able to read one of these at 11am and know exactly what is not yet done.
 */
async function heartbeat(): Promise<void> {
  if (fired) return;

  const wallets = currentWallets();
  const funded = wallets.reduce((a, w) => a + w.spendEth, 0);

  let poolLine = 'pools unreadable';
  try {
    const bals = await Promise.all(
      POOLS.map((p) =>
        http_.readContract({ address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] }),
      ),
    );
    poolLine = bals.every((b) => b === 0n)
      ? 'both pools still empty'
      : `⚠️ LAPTOP is in a pool: ${bals.map((b, i) => `${POOLS[i].label} ${formatEther(b)}`).join(' · ')}`;
  } catch { /* keep the fallback line */ }

  const missing: string[] = [];
  if (!wallets.length) missing.push('nobody has funded a wallet and set /spend');
  if (!isArmed()) missing.push('<b>not armed</b> — send /arm or nothing happens at 1pm');
  if (!isPrepped()) missing.push('/prep has not been run this session');

  await notify(
    `⏱ <b>${countdown()}</b>\n` +
      `${poolLine}\n` +
      `${wallets.length} wallet(s) in, ${funded} ETH total\n` +
      `${isArmed() ? '🔴 ARMED' : '🟡 not armed'} · watching via ${wsWarned ? '2s poll' : 'websocket'}\n` +
      (missing.length ? `\n<b>Still needed</b>\n· ${missing.join('\n· ')}` : '\n✅ Ready. Nothing outstanding.'),
  );
}

async function main() {
  const boot = currentWallets();
  console.log('\nWCKD\n');
  console.log(`  token    ${LAPTOP}`);
  console.log(`  wss      ${RPC_WSS}`);
  console.log(`  wallets  ${boot.length ? boot.map((w) => `${w.name}:${w.spendEth}ETH`).join('  ') : 'none yet — waiting on Telegram'}`);
  console.log(`  cap      ${HARD_CAP_ETH} ETH per wallet`);
  console.log(`  ARMED    ${isArmed()}${isArmed() ? '  ← THIS WILL SPEND REAL MONEY' : '  ← not armed. /arm from telegram when ready'}\n`);

  for (const p of POOLS) {
    const bal = await http_.readContract({
      address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address],
    });
    console.log(`  pool ${p.label.padEnd(6)} ${short(p.address)}  LAPTOP ${formatEther(bal)}`);
    if (bal > 0n) {
      console.log('\n  ⚠ There is already LAPTOP in this pool. The launch has happened.');
      console.log('    Not firing automatically — decide this one yourself.\n');
      await notify('⚠️ Watcher started but a pool <b>already holds LAPTOP</b>. Launch looks done. Not auto-buying.');
      fired = true;
      return;
    }
  }

  // The Telegram front door runs alongside the watcher, so people can still
  // join and fund right up to the moment it fires.
  void runBot();

  // A restart must never leave anyone guessing which state it came back in.
  const armLine = isArmed()
    ? restoredFromDisk
      ? `🔴 <b>ARMED</b> — restored after a restart (armed ${armAgeMinutes()} min ago).`
      : '🔴 <b>ARMED</b> — this will spend.'
    : '🟡 <b>NOT ARMED.</b> Send /arm when you are ready, or it does nothing at 1pm.';

  await notify(
    `👀 <b>Watcher up</b>. Launch 1:00pm WAT.\n` +
      `Both pools empty. ${boot.length} wallet(s) ready.\n` +
      'Send /start to get your wallet.\n' +
      armLine,
  );

  const live = watchLogs();
  if (!live) {
    console.log('\n  ⚠ NO WEBSOCKET. Falling back to a 2s poll — up to 2 seconds late.');
    console.log('    The public Base endpoint serves none. Set BASE_WSS to an Alchemy');
    console.log('    or QuickNode Base url before the window opens.\n');
    await notify('⚠️ <b>No WebSocket</b> — polling every 2s instead. Set <code>BASE_WSS</code> to a real provider or we are up to 2s late.');
  } else {
    console.log('  ✓ log subscription live on both pools\n');
  }
  void pollBalances();

  // Heartbeat every 30 minutes until launch.
  //
  // A silent channel is ambiguous — it could mean "watching" or "died at 3am".
  // Every report carries the countdown and, more importantly, whatever is still
  // MISSING, so a wallet nobody funded or a bot nobody armed is impossible to
  // discover for the first time at 13:00.
  setInterval(() => void heartbeat(), 30 * 60_000);
  setTimeout(() => void heartbeat(), 60_000); // one soon, to prove it works
}

process.on('SIGINT', async () => {
  await notify('🛑 Watcher stopped by hand.');
  process.exit(0);
});

main().catch(async (e) => {
  console.error('\nwatcher failed to start:', e.message ?? e);
  await notify(`❌ <b>Watcher failed to start</b>\n<code>${(e as Error).message}</code>`);
  process.exit(1);
});
