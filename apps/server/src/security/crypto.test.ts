import test from "node:test";
import assert from "node:assert/strict";
import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  generateToken,
  isEncrypted,
  safeCompare,
} from "./crypto.ts";

const KEY = "correct-horse-battery-staple";

test("a secret round-trips through encrypt/decrypt", () => {
  const secret = "123456:AAH-bot-token-value";
  assert.equal(decryptSecret(encryptSecret(secret, KEY), KEY), secret);
});

test("the same plaintext never produces the same ciphertext", () => {
  // Random salt + IV per call, so a repeated token is not recognisable as such.
  const a = encryptSecret("same", KEY);
  const b = encryptSecret("same", KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), decryptSecret(b, KEY));
});

test("ciphertext does not contain the plaintext", () => {
  const cipher = encryptSecret("SUPERSECRET", KEY);
  assert.ok(!cipher.includes("SUPERSECRET"));
});

test("decrypting with the wrong key fails loudly", () => {
  const cipher = encryptSecret("value", KEY);
  assert.throws(() => decryptSecret(cipher, "wrong-key"), DecryptionError);
});

test("tampered ciphertext is rejected rather than silently decrypted", () => {
  const cipher = encryptSecret("value", KEY);
  const parts = cipher.split(":");
  // Flip the payload; GCM's auth tag must catch it.
  parts[4] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join(":"), KEY), DecryptionError);
});

test("malformed payloads are rejected", () => {
  assert.throws(() => decryptSecret("not-a-ciphertext", KEY), DecryptionError);
  assert.throws(() => decryptSecret("v9:a:b:c:d", KEY), DecryptionError);
});

test("isEncrypted recognises our format and nothing else", () => {
  assert.equal(isEncrypted(encryptSecret("x", KEY)), true);
  assert.equal(isEncrypted("123456:ABC-plain-token"), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
});

test("empty strings survive the round trip", () => {
  assert.equal(decryptSecret(encryptSecret("", KEY), KEY), "");
});

test("unicode survives the round trip", () => {
  const secret = "clé-secrète-🔐-中文";
  assert.equal(decryptSecret(encryptSecret(secret, KEY), KEY), secret);
});

// ---------------------------------------------------------------------------
// Token comparison
// ---------------------------------------------------------------------------

test("safeCompare matches identical strings", () => {
  assert.equal(safeCompare("abc123", "abc123"), true);
});

test("safeCompare rejects differing strings", () => {
  assert.equal(safeCompare("abc123", "abc124"), false);
});

test("safeCompare rejects differing lengths without throwing", () => {
  // timingSafeEqual throws on length mismatch; we must not propagate that.
  assert.equal(safeCompare("short", "much-longer-token"), false);
  assert.equal(safeCompare("", "x"), false);
});

test("generated tokens are URL-safe and unique", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 32);
});
