// Where alerts go.
//
// TELEGRAM_CHAT_ID in the env was empty, which meant notify() returned before
// sending and every alert — including LAUNCH DETECTED — went to the console on
// a server nobody is watching. Found during the pre-launch check at 02:00.
//
// So the chat id is now learned: the first person to talk to the bot becomes
// the alert target, and it is remembered across restarts.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { TELEGRAM_CHAT } from './config.js';

const FILE = join(process.cwd(), '.chats.json');

interface Chats { ids: number[] }

function read(): Chats {
  if (!existsSync(FILE)) return { ids: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')) as Chats; } catch { return { ids: [] }; }
}

function write(c: Chats): void {
  try { writeFileSync(FILE, JSON.stringify(c, null, 2)); chmodSync(FILE, 0o600); } catch { /* ignore */ }
}

/** Called on every command, so anyone who talks to the bot gets the alerts. */
export function remember(chatId: number): void {
  const c = read();
  if (c.ids.includes(chatId)) return;
  c.ids.push(chatId);
  write(c);
}

/** Everyone we should shout at. The env value wins if it is set. */
export function alertTargets(): number[] {
  const fromEnv = TELEGRAM_CHAT ? [Number(TELEGRAM_CHAT)] : [];
  const learned = read().ids;
  const all = [...new Set([...fromEnv, ...learned])].filter((n) => Number.isFinite(n));
  return all;
}
