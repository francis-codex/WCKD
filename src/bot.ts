// The Telegram front door.
//
// Each person texts the bot, gets their own generated wallet address, funds it
// themselves, and sets how much of it to spend. Nobody pastes a private key
// into a chat and nobody hands a key to anybody.
//
// Long-polling on purpose: no webhook, no public URL, no tunnel. It runs on a
// laptop and that is the whole requirement.

import { formatEther, parseEther } from 'viem';
import { TELEGRAM_TOKEN, HARD_CAP_ETH, LAPTOP, WETH, POOLS, countdown, type SniperWallet } from './config.js';
import { http_, erc20Abi } from './chain.js';
import {
  getOrCreate, get, setSpend, all, armedWallets, pendingWallets,
  setApproved, findByHandleOrId, privateKeyOf,
} from './store.js';
import { isArmed, setArmed, claimAdmin, isAdmin, setPrepped } from './runtime.js';
import { prepareAll } from './prepAll.js';
import { sell } from './sell.js';
import { remember } from './target.js';

const API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number }; text?: string }
interface TgUpdate { update_id: number; message?: TgMessage }

export async function send(chatId: number, text: string): Promise<void> {
  try {
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('  send failed:', (e as Error).message);
  }
}

const nameOf = (u?: TgUser) => u?.username ? `@${u.username}` : (u?.first_name ?? 'friend');

async function ethBalance(address: `0x${string}`) {
  try { return await http_.getBalance({ address }); } catch { return 0n; }
}

async function wethBalance(address: `0x${string}`) {
  try {
    return await http_.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  } catch { return 0n; }
}

/**
 * What this wallet can actually spend, which is ETH **plus WETH**.
 *
 * /prep wraps ETH into WETH ahead of the launch. Reporting only the ETH side
 * made it look like half the money had vanished, and blocked people from
 * raising their spend after prepping. Both halves are the same money.
 */
async function spendable(address: `0x${string}`): Promise<{ eth: bigint; weth: bigint; total: bigint }> {
  const [eth, weth] = await Promise.all([ethBalance(address), wethBalance(address)]);
  return { eth, weth, total: eth + weth };
}

const OWNER_HELP = [
  '',
  '<b>Owner</b>',
  '/pending — who is funded and waiting on you',
  '/approve @handle — let them into the buy · /deny @handle',
  '/prep — wrap and approve every approved wallet. Before 1pm.',
  '/arm — go live · /disarm — stand down',
].join('\n');

const OTHER_HELP = [
  '',
  '<b>Anytime</b>',
  '/balance · /status · /who',
  '/position — what you are holding, with a chart link',
  '/sell 50 — sell half · /sell — sell it all',
  '/export — your private key, so you can sell it yourself',
].join('\n');

/** Telegram wallets that are funded and have a spend set. */
function readyWallets(): SniperWallet[] {
  return armedWallets().map((w) => ({
    name: w.handle,
    privateKey: privateKeyOf(w),
    spendEth: w.spendEth,
    minOutBps: 0,
  }));
}

async function handle(msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = (msg.text ?? '').trim();
  if (!from || !text.startsWith('/')) return;

  // Learn every chat that talks to us, so alerts actually reach a human.
  remember(chatId);

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    claimAdmin(from.id); // first person to /start owns arm and prep
    const w = getOrCreate(from.id, nameOf(from));
    const b = await spendable(w.address);
    const bal = b.total;
    const funded = bal > 0n;

    // Address first, then two steps. Nobody reads a wall of commands at 1am.
    const lines = [
      '<b>WCKD</b>',
      '',
      '<b>Your wallet</b>',
      `<code>${w.address}</code>`,
      funded ? `holding ${formatEther(bal)} ETH` : '<i>empty — fund it to take part</i>',
      '',
      '<b>Two things to do</b>',
      '1. Send ETH to that address. It must be on <b>Base</b>.',
      '2. Reply <code>/spend 0.02</code> — how much of it to use.',
      '',
      'That is it. Launch is <b>1:00pm WAT today</b> and the bot buys the second',
      'liquidity lands. You do not need to be watching.',
      '',
      'Send a bit more than you plan to spend so there is gas left over.',
      'Only put in what you can afford to lose.',
    ];
    if (isAdmin(from.id)) lines.push(OWNER_HELP);
    lines.push(OTHER_HELP);

    await send(chatId, lines.join('\n'));
    return;
  }

  if (cmd === '/balance') {
    const w = get(from.id);
    if (!w) return void send(chatId, 'No wallet yet — send /start first.');
    const b = await spendable(w.address);
    await send(
      chatId,
      `<code>${w.address}</code>\n` +
        `<b>${formatEther(b.total)} ETH</b> total\n` +
        `· ${formatEther(b.eth)} ETH\n` +
        `· ${formatEther(b.weth)} WETH${b.weth > 0n ? ' <i>(wrapped by /prep — same money)</i>' : ''}\n` +
        (w.spendEth ? `\nset to spend <b>${w.spendEth}</b> ETH` : '\nno spend amount set yet — /spend 0.02'),
    );
    return;
  }

  if (cmd === '/spend') {
    const w = get(from.id);
    if (!w) return void send(chatId, 'No wallet yet — send /start first.');
    const amount = Number(args[0]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return void send(chatId, 'Give me a number, like <code>/spend 0.02</code>');
    }
    if (amount > HARD_CAP_ETH) {
      return void send(chatId, `That is above the ${HARD_CAP_ETH} ETH cap. Pick something smaller.`);
    }
    const b = await spendable(w.address);
    if (b.total < parseEther(String(amount))) {
      return void send(
        chatId,
        `Set to ${amount} ETH, but the wallet holds ${formatEther(b.total)}.\n` +
          `Fund <code>${w.address}</code> on Base before 1pm or it will not fire.`,
      );
    }
    // Leave something for gas. Spending the entire balance means no gas to swap with.
    if (b.total - parseEther(String(amount)) < parseEther('0.0003')) {
      return void send(
        chatId,
        `That leaves nothing for gas. Hold back about 0.0005 ETH — try /spend ${(Number(formatEther(b.total)) - 0.0005).toFixed(4)}`,
      );
    }
    setSpend(from.id, amount);
    const rec = get(from.id);
    await send(
      chatId,
      rec?.approved
        ? `✅ You are in for <b>${amount} ETH</b>.\nWallet ${formatEther(b.total)} ETH. Nothing else to do.`
        : `✅ Set to <b>${amount} ETH</b>. Wallet ${formatEther(b.total)} ETH.\n\n` +
            `<i>Waiting on the owner to let you in. You will not be included until then.</i>`,
    );
    return;
  }

  if (cmd === '/status') {
    const lines: string[] = [`⏱ <b>${countdown()}</b>`, '', '<b>Pools</b>'];
    let started = false;
    for (const p of POOLS) {
      try {
        const bal = await http_.readContract({
          address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [p.address],
        });
        if (bal > 0n) started = true;
        lines.push(`${p.label} — LAPTOP ${formatEther(bal)}`);
      } catch {
        lines.push(`${p.label} — could not read`);
      }
    }
    lines.push('');
    lines.push(started ? '🔴 <b>Launch has started.</b>' : '🟢 Still empty. Nothing has launched.');
    lines.push(isArmed() ? '🔴 <b>ARMED</b> — it will spend.' : '🟡 Not armed. Nothing will be sent.');
    lines.push(`${armedWallets().length} funded wallet(s) ready.`);
    await send(chatId, lines.join('\n'));
    return;
  }

  if (cmd === '/sell') {
    const w = get(from.id);
    if (!w) return void send(chatId, 'No wallet yet — send /start first.');
    const pct = args[0] ? Number(String(args[0]).replace('%', '')) : 100;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return void send(chatId, 'Give me a percentage. <code>/sell 50</code> or just <code>/sell</code> for everything.');
    }
    await send(chatId, `Selling ${pct}%…`);
    const r = await sell(w, pct);
    await send(
      chatId,
      r.hash
        ? `✅ Sell sent — ${formatEther(r.sold ?? 0n)} LAPTOP\nhttps://basescan.org/tx/${r.hash}`
        : `❌ ${r.error}`,
    );
    return;
  }

  if (cmd === '/pending') {
    if (!isAdmin(from.id)) return void send(chatId, 'Owner only.');
    const list = pendingWallets();
    if (!list.length) return void send(chatId, 'Nobody waiting. Everyone funded is approved.');
    const rows = await Promise.all(
      list.map(async (w) => `${w.handle} — ${w.spendEth} ETH set, holds ${formatEther(await ethBalance(w.address))}`),
    );
    await send(chatId, `<b>Waiting on you</b>\n${rows.join('\n')}\n\nApprove with <code>/approve handle</code>`);
    return;
  }

  if (cmd === '/approve' || cmd === '/deny') {
    if (!isAdmin(from.id)) return void send(chatId, 'Owner only.');
    const who = args[0];
    if (!who) return void send(chatId, `Who? <code>${cmd} debar_fx</code>`);
    const target = findByHandleOrId(who);
    if (!target) return void send(chatId, `No wallet for ${who}. They need to /start first.`);
    const yes = cmd === '/approve';
    setApproved(target.telegramId, yes);
    await send(chatId, yes
      ? `✅ ${target.handle} is in for ${target.spendEth} ETH.`
      : `🚫 ${target.handle} is out. Their funds are untouched and they can /export any time.`);
    // Tell them, so nobody is left wondering whether they are in the buy.
    await send(target.telegramId, yes
      ? '✅ You are in. Nothing else to do — it fires on its own at 1pm.'
      : 'You have not been included in this one. Your funds are yours, /export to take the key.');
    return;
  }

  if (cmd === '/prep') {
    if (!isAdmin(from.id)) return void send(chatId, 'Only the owner can run prep.');
    const wallets = readyWallets();
    if (!wallets.length) {
      return void send(chatId, 'Nobody is funded with a spend set yet. /start, fund, then /spend.');
    }
    await send(chatId, `Wrapping and approving for ${wallets.length} wallet(s)… this takes a moment.`);
    // Always live: wrapping and approving cannot lose anyone money, and being
    // unprepped at 1pm costs the whole trade.
    const lines = await prepareAll(wallets, true);
    if (lines.every((l) => l.ok)) setPrepped();
    await send(
      chatId,
      `<b>Prep</b>\n${lines.map((l) => `${l.ok ? '✅' : '❌'} ${l.name} — ${l.detail}`).join('\n')}`,
    );
    return;
  }

  if (cmd === '/arm') {
    if (!isAdmin(from.id)) return void send(chatId, 'Only the owner can arm it.');
    const ready = armedWallets().length;
    if (!ready) return void send(chatId, 'Nothing to arm — no funded wallets with a spend set.');
    setArmed(true, nameOf(from));
    await send(
      chatId,
      `🔴 <b>ARMED.</b>\n${ready} wallet(s) will buy the moment LAPTOP hits a pool.\n\n` +
        `Survives a restart for 6 hours, so a crash near 1pm will not silently disarm it.\n` +
        `Run /prep first if you have not. /disarm to stand down.`,
    );
    return;
  }

  if (cmd === '/disarm') {
    if (!isAdmin(from.id)) return void send(chatId, 'Only the owner can disarm it.');
    setArmed(false, nameOf(from));
    await send(chatId, '🟡 Disarmed. It will still watch and report, but send nothing.');
    return;
  }

  if (cmd === '/position') {
    const w = get(from.id);
    if (!w) return void send(chatId, 'No wallet yet — send /start first.');
    const [laptop, eth] = await Promise.all([
      http_.readContract({ address: LAPTOP, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }).catch(() => 0n),
      ethBalance(w.address),
    ]);
    await send(
      chatId,
      `<b>${formatEther(laptop)} LAPTOP</b>\n` +
        `${formatEther(eth)} ETH left for gas\n\n` +
        `Live price and your position:\nhttps://dexscreener.com/base/${LAPTOP}\n` +
        `Wallet: https://basescan.org/address/${w.address}`,
    );
    return;
  }

  if (cmd === '/export') {
    const w = get(from.id);
    if (!w) return void send(chatId, 'No wallet yet — send /start first.');
    // Refuse in groups. A key pasted into a group chat is a key given away.
    if (chatId !== from.id) {
      return void send(chatId, '⚠️ Not in a group. Message me directly and send /export there.');
    }
    await send(
      chatId,
      '<b>Your private key</b>\n' +
        `<code>${privateKeyOf(w)}</code>\n\n` +
        'This wallet is yours now. Import it into Rabby or MetaMask (add the Base network) ' +
        'and you can sell whenever you like, on Uniswap or Matcha.\n\n' +
        '⚠️ <b>Delete this message once you have saved it.</b> Anyone with this key owns the wallet.\n' +
        '⚠️ Do not use this wallet for anything else afterwards.',
    );
    return;
  }

  if (cmd === '/who') {
    const list = all();
    if (!list.length) return void send(chatId, 'Nobody yet.');
    const rows = await Promise.all(
      list.map(async (w) => {
        const bal = (await spendable(w.address)).total;
        const state = w.spendEth ? `in for ${w.spendEth} ETH` : 'not set';
        return `${w.handle} — ${formatEther(bal)} ETH, ${state}`;
      }),
    );
    await send(chatId, `<b>Taking part</b>\n${rows.join('\n')}\n\n${armedWallets().length} ready to fire.`);
    return;
  }
}

/** Long-poll forever. Never let one bad update kill the loop. */
export async function runBot(): Promise<void> {
  if (!TELEGRAM_TOKEN) {
    console.log('  (no TELEGRAM_BOT_TOKEN — Telegram front door is off)');
    return;
  }

  // Skip whatever piled up while the bot was down.
  //
  // Telegram redelivers any update the bot never acknowledged, so starting from
  // offset 0 replays the backlog — which is exactly why a /start that failed at
  // 00:41 got answered twice after a restart at 00:44. Ask for the last update
  // only, and begin after it.
  let offset = 0;
  try {
    const res = await fetch(`${API}/getUpdates?offset=-1`, { signal: AbortSignal.timeout(10000) });
    const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
    const last = body.result?.[body.result.length - 1];
    if (last) {
      offset = last.update_id + 1;
      console.log('  · skipped messages sent while it was down');
    }
  } catch {
    // Not worth failing to start over. Worst case is one stale reply.
  }

  console.log('  ✓ telegram bot listening');

  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, {
        signal: AbortSignal.timeout(40000),
      });
      const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      for (const u of body.result ?? []) {
        offset = u.update_id + 1;
        if (!u.message) continue;
        // Never fail silently. A command that throws and says nothing is how a
        // missing WALLET_SECRET cost fifteen minutes at 00:41.
        await handle(u.message).catch(async (e) => {
          console.error('  handler:', e.message);
          await send(u.message!.chat.id, `⚠️ That failed:\n<code>${(e as Error).message}</code>`);
        });
      }
    } catch {
      // Timeouts are the normal shape of long-polling. Breathe and go again.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
