// Master key + value encryption for the `setting` table.
//
// Envelope encryption, one level deep:
//
//   safeStorage (OS keychain)  ──wraps──>  master key (32 random bytes)
//   master key                 ──AES-256-GCM──>  each secret setting value
//
// The wrapped key lives in `<userData>/masterkey.enc`, NOT in the DB: it is
// machine-bound (only this machine's keychain can unwrap it) while the DB is
// portable — backed up, copied, potentially synced. Keeping machine-bound bytes
// out of portable data means a copied DB carries nothing that pretends to be
// usable elsewhere.
//
// Linux without a keyring: safeStorage falls back to a hardcoded password, so
// wrapping there buys nothing. Rather than pretend, we store the key marked
// `plain` and warn once — same posture the old settings.json path had (it wrote
// plaintext secrets in that situation). The app keeps working; the user is told.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { app, safeStorage } from 'electron';

const KEY_FILE = 'masterkey.enc';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

let cachedKey: Buffer | null = null;
let warnedNoEncryption = false;

function keyPath(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

function warnOnce() {
  if (warnedNoEncryption) return;
  console.warn('[secrets] safeStorage unavailable — master key stored unwrapped');
  warnedNoEncryption = true;
}

// File is small JSON so the format is self-describing and a future rotation can
// branch on `v` without guessing at raw bytes.
type KeyFile = { v: 1; wrapped?: string; plain?: string };

function readKeyFile(): Buffer | null {
  let parsed: KeyFile;
  try {
    parsed = JSON.parse(fs.readFileSync(keyPath(), 'utf8'));
  } catch {
    return null; // absent or unreadable — caller generates a fresh key
  }
  try {
    if (parsed.wrapped) {
      const raw = Buffer.from(safeStorage.decryptString(Buffer.from(parsed.wrapped, 'base64')), 'base64');
      if (raw.length !== KEY_BYTES) throw new Error(`bad key length ${raw.length}`);
      return raw;
    }
    if (parsed.plain) {
      warnOnce();
      const raw = Buffer.from(parsed.plain, 'base64');
      if (raw.length !== KEY_BYTES) throw new Error(`bad key length ${raw.length}`);
      return raw;
    }
  } catch (err: any) {
    // The keychain entry is gone or belongs to another identity (restored
    // machine, changed login keychain). We CANNOT silently regenerate: that
    // would leave every existing secret row undecryptable while looking healthy.
    // Throw so the caller surfaces it instead.
    throw new Error(`master key unreadable — secrets cannot be decrypted: ${err?.message ?? err}`);
  }
  return null;
}

function writeKeyFile(raw: Buffer) {
  const b64 = raw.toString('base64');
  const body: KeyFile = safeStorage.isEncryptionAvailable()
    ? { v: 1, wrapped: safeStorage.encryptString(b64).toString('base64') }
    : (warnOnce(), { v: 1, plain: b64 });
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // tmp + rename: a half-written key file would be an unrecoverable secret loss.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Generated on first call, then cached for the process lifetime. Never crosses
// IPC — the renderer has no path to it.
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const existing = readKeyFile();
  if (existing) {
    cachedKey = existing;
    return cachedKey;
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  writeKeyFile(fresh);
  cachedKey = fresh;
  return cachedKey;
}

export interface Sealed {
  value: string; // base64 ciphertext
  iv: Buffer;
  tag: Buffer;
}

// Fresh IV per write — GCM catastrophically leaks plaintext relationships if an
// (key, IV) pair is ever reused, so this must never be derived from the key name.
export function seal(plain: string): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { value: ct.toString('base64'), iv, tag: cipher.getAuthTag() };
}

// Returns '' on failure rather than throwing: one corrupt row shouldn't take
// down the whole settings read. Mirrors the old decryptSecret's behavior.
export function unseal(sealed: { value: string; iv: Buffer | null; tag: Buffer | null }): string {
  if (!sealed.iv || !sealed.tag) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(sealed.iv));
    decipher.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([decipher.update(Buffer.from(sealed.value, 'base64')), decipher.final()]).toString('utf8');
  } catch (err: any) {
    console.warn('[secrets] failed to decrypt setting:', err?.message ?? err);
    return '';
  }
}
