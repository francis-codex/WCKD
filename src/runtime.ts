// Live state, flippable from Telegram so nobody needs a terminal on launch day.
//
// Arming is persisted, but with an expiry. Two failure modes to avoid and they
// pull in opposite directions:
//
//   · not persisting at all — systemd restarts at 12:58, the bot comes back
//     disarmed, and does nothing at 13:00. Silent, and costs the whole trade.
//   · persisting forever — a bot that comes back armed days later is a live
//     order nobody remembers giving.
//
// So it persists for a few hours and then stops meaning anything.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ARMED as ARMED_FROM_ENV } from './config.js';

const FILE = join(process.cwd(), '.armed.json');

/** Long enough to cover a crash and a launch window, short enough to forget. */
const ARM_TTL_MS = 6 * 60 * 60 * 1000;

interface ArmRecord { armed: boolean; at: number; by?: string }

function read(): ArmRecord | null {
  if (!existsSync(FILE)) return null;
  try { return JSON.parse(readFileSync(FILE, 'utf8')) as ArmRecord; } catch { return null; }
}

function write(rec: ArmRecord): void {
  try {
    writeFileSync(FILE, JSON.stringify(rec, null, 2));
    chmodSync(FILE, 0o600);
  } catch { /* not worth failing the process over */ }
}

function restore(): boolean {
  if (ARMED_FROM_ENV) return true;
  const rec = read();
  if (!rec?.armed) return false;
  const age = Date.now() - rec.at;
  if (age > ARM_TTL_MS) return false;
  return true;
}

let armed = restore();

/** True when this boot came back armed from a previous run rather than the env. */
export const restoredFromDisk = armed && !ARMED_FROM_ENV;

export const isArmed = () => armed;

export function setArmed(next: boolean, by?: string): void {
  armed = next;
  write({ armed: next, at: Date.now(), by });
}

/** Minutes left before a restored arm goes stale, for the boot message. */
export function armAgeMinutes(): number | null {
  const rec = read();
  if (!rec?.armed) return null;
  return Math.round((Date.now() - rec.at) / 60000);
}

/**
 * The owner is pinned by Telegram id in the env, not learned at runtime.
 *
 * It used to be "whoever /starts first after boot", which handed ownership to
 * whoever happened to text the bot after a restart — on 9 Sept that was Deber,
 * and Francis could not arm his own bot. An identity that moves when the
 * process restarts is not an identity.
 */
const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID ?? '0') || null;

export function claimAdmin(_telegramId: number): boolean {
  return true; // kept for call-site compatibility; ownership is not claimable
}

/** With no OWNER_TELEGRAM_ID set, nobody is owner — fail closed, not open. */
export const isAdmin = (telegramId: number) => OWNER_ID !== null && telegramId === OWNER_ID;
export const ownerId = () => OWNER_ID;


/** Whether /prep has been run since boot. Only used to nag in the heartbeat. */
let prepDone = false;
export const setPrepped = () => { prepDone = true; };
export const isPrepped = () => prepDone;
