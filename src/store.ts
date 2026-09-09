// Per-user wallets, keyed by Telegram user id.
//
// The bot generates the wallet, so nobody ever pastes an existing private key
// into a chat. That is the one real safety win of this design and the reason
// it is worth the custody: a fresh key that has only ever held what its owner
// deliberately sent it.
//
// Be honest about what this is: the keys live on THIS machine. Whoever runs the
// bot can spend them. That is acceptable between two people who know each other
// and a sum they can afford to lose, and it is not acceptable for anything else.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address } from 'viem';

const FILE = join(process.cwd(), '.wallets.json');

export interface StoredWallet {
  telegramId: number;
  handle: string;
  address: Address;
  /** aes-256-gcm, keyed off WALLET_SECRET. iv:tag:ciphertext, all hex. */
  encrypted: string;
  spendEth: number;
  createdAt: string;
}

type Db = Record<string, StoredWallet>;

function secret(): Buffer {
  const s = process.env.WALLET_SECRET?.trim();
  if (!s || s.length < 16) {
    throw new Error(
      'WALLET_SECRET must be set to at least 16 characters. It encrypts every ' +
        'generated key at rest — without it the wallet file is plaintext.',
    );
  }
  // Fixed salt: the file and the secret travel together, so a per-record salt
  // would buy nothing here and costs a migration.
  return scryptSync(s, 'laptop-sniper', 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', secret(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
}

function load(): Db {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Db;
  } catch {
    return {};
  }
}

function save(db: Db): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
  // Owner-only. Cheap, and it stops the most boring way this goes wrong.
  try { chmodSync(FILE, 0o600); } catch { /* best effort */ }
}

/** Idempotent: texting /start twice must never mint a second wallet and strand
 *  whatever was already funded into the first. */
export function getOrCreate(telegramId: number, handle: string): StoredWallet {
  const db = load();
  const existing = db[String(telegramId)];
  if (existing) return existing;

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const record: StoredWallet = {
    telegramId,
    handle,
    address: account.address,
    encrypted: encrypt(pk),
    spendEth: 0,
    createdAt: new Date().toISOString(),
  };
  db[String(telegramId)] = record;
  save(db);
  return record;
}

export function get(telegramId: number): StoredWallet | null {
  return load()[String(telegramId)] ?? null;
}

export function all(): StoredWallet[] {
  return Object.values(load());
}

/** Only the ones with something to spend. A wallet nobody funded is not a
 *  participant, and firing an empty wallet just burns gas on a revert. */
export function armedWallets(): StoredWallet[] {
  return all().filter((w) => w.spendEth > 0);
}

export function setSpend(telegramId: number, spendEth: number): void {
  const db = load();
  const w = db[String(telegramId)];
  if (!w) throw new Error('no wallet for that user yet — send /start first');
  w.spendEth = spendEth;
  save(db);
}

export function privateKeyOf(w: StoredWallet): `0x${string}` {
  return decrypt(w.encrypted) as `0x${string}`;
}
