// Status goes to everyone who has talked to the bot, so both people see the
// same thing at the same time. Nothing here is allowed to throw: a notifier
// that crashes the process during a launch would be worse than no notifier.

import { TELEGRAM_TOKEN } from './config.js';
import { alertTargets } from './target.js';

const stamp = () =>
  new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour12: false });

export async function notify(text: string): Promise<void> {
  console.log(`[${stamp()}] ${text}`);
  if (!TELEGRAM_TOKEN) return;

  const targets = alertTargets();
  if (!targets.length) {
    console.log('  (nobody to alert yet — send the bot a message so it learns the chat)');
    return;
  }

  await Promise.all(
    targets.map(async (chatId) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) console.error(`  telegram refused ${chatId}: ${res.status}`);
      } catch (e) {
        // Losing an alert is survivable. Losing the buy is not.
        console.error(`  telegram unreachable for ${chatId}:`, (e as Error).message);
      }
    }),
  );
}

export const basescanTx = (hash: string) => `https://basescan.org/tx/${hash}`;
