import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated encryption for secrets held at rest (currently the Telegram bot
 * token in SQLite).
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypted into
 * garbage. The key is derived from ZTRADE_SECRET_KEY via scrypt; each value
 * carries its own random salt and IV, so identical plaintexts never produce
 * identical ciphertexts.
 *
 * Format: v1:<salt>:<iv>:<authTag>:<ciphertext>, all base64url.
 */
const VERSION = "v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt cost chosen to stay well under a second on modest hardware; these
  // values only run on settings reads/writes, not in the trading hot path.
  return scryptSync(passphrase, salt, KEY_LENGTH, { N: 16_384, r: 8, p: 1 });
}

export function encryptSecret(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    salt.toString("base64url"),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(payload: string, passphrase: string): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new DecryptionError("Malformed ciphertext");
  }

  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(passphrase, Buffer.from(saltB64!, "base64url"));

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64!, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64!, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key or tampered payload — GCM cannot tell us which, and we should
    // not leak the difference anyway.
    throw new DecryptionError("Could not decrypt: wrong key or tampered data");
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

/**
 * Constant-time string comparison for tokens.
 *
 * A plain `===` leaks the length of the matching prefix through timing, which
 * is enough to recover a token byte by byte over many requests.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so hash-free length equalisation
  // is done first; the length itself is not secret for fixed-format tokens.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
