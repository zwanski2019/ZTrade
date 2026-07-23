import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { SecretVault, isSecret, secret, secretFromEnv } from "./secret.ts";
import { evaluateKeyScope, parseBybitPermissions, type KeyPermissions } from "./keyScope.ts";
import {
  MemoryNonceStore,
  SignalVerifier,
  signSignal,
  type SignedSignal,
} from "./signalAuth.ts";

// ===========================================================================
// Secret<T> — structural redaction
// ===========================================================================

const SENTINEL = "SUPER-SECRET-KEY-abc123XYZ-never-log-me";

test("expose() is the only way to read the value", () => {
  const s = secret(SENTINEL, "apiKey");
  assert.equal(s.expose(), SENTINEL);
  assert.equal(s.label, "apiKey");
});

test("toString redacts", () => {
  assert.equal(String(secret(SENTINEL)), "[REDACTED]");
  assert.equal(`${secret(SENTINEL)}`, "[REDACTED]");
});

test("template-string interpolation cannot leak (toPrimitive)", () => {
  // The hole a naive wrapper leaves: `key=${s}` bypasses toString on some paths.
  const leaked = `authorization: Bearer ${secret(SENTINEL)}`;
  assert.ok(!leaked.includes(SENTINEL), `LEAK: ${leaked}`);
  assert.ok(leaked.includes("[REDACTED]"));
});

test("JSON.stringify redacts, at top level and nested", () => {
  const config = { apiKey: secret(SENTINEL), port: 8788, nested: { secret: secret(SENTINEL) } };
  const json = JSON.stringify(config);
  assert.ok(!json.includes(SENTINEL), `LEAK in JSON: ${json}`);
  assert.match(json, /\[REDACTED\]/);
});

test("util.inspect (what console.log uses) redacts", () => {
  const out = inspect({ key: secret(SENTINEL, "apiKey") }, { depth: 5 });
  assert.ok(!out.includes(SENTINEL), `LEAK in inspect: ${out}`);
});

test("the value is invisible to Object.keys and spread", () => {
  const s = secret(SENTINEL);
  assert.equal(Object.keys(s).length, 0, "no enumerable own keys");
  assert.ok(!JSON.stringify({ ...s }).includes(SENTINEL));
});

test("PROPERTY: no fuzzed serialisation of a Secret ever emits its value", () => {
  // The core guarantee of the Security Plane. Throw a Secret through every
  // serialisation path a logger or error reporter might reach.
  let state = 12345 >>> 0;
  const rng = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);

  for (let i = 0; i < 500; i++) {
    const value = `secret-${rng().toString(36)}-${i}-tail`;
    const s = secret(value, `label-${i}`);

    // Build an arbitrary object graph containing the secret at a random depth.
    const graph: Record<string, unknown> = { a: 1, b: "text", nested: { deep: { s } } };
    if (i % 2 === 0) graph.arr = [1, s, { s }];
    if (i % 3 === 0) graph.err = new Error(`context ${s}`);

    const serialisations = [
      JSON.stringify(graph),
      inspect(graph, { depth: 8 }),
      String(s),
      `${s}`,
      s.toJSON(),
      `${graph.err ?? ""}`,
    ];

    for (const out of serialisations) {
      assert.ok(!out.includes(value), `seed ${i}: value leaked via serialisation: ${out}`);
    }
  }
});

test("isPresent reflects emptiness", () => {
  assert.equal(secret("x").isPresent, true);
  assert.equal(secret("").isPresent, false);
  assert.equal(secret(null as unknown as string).isPresent, false);
});

test("secretFromEnv lifts or returns null", () => {
  const env = { KEY: "value", BLANK: "", MISSING: undefined } as NodeJS.ProcessEnv;
  assert.equal(secretFromEnv("KEY", env)?.expose(), "value");
  assert.equal(secretFromEnv("BLANK", env), null);
  assert.equal(secretFromEnv("MISSING", env), null);
});

test("the vault stores and clears references", () => {
  const vault = new SecretVault();
  vault.set("bybit", secret(SENTINEL));
  assert.equal(vault.get<string>("bybit")?.expose(), SENTINEL);
  assert.equal(vault.size, 1);
  vault.clear();
  assert.equal(vault.size, 0);
  assert.equal(vault.get("bybit"), null);
});

test("isSecret guards", () => {
  assert.equal(isSecret(secret("x")), true);
  assert.equal(isSecret("x"), false);
  assert.equal(isSecret({ expose: () => "x" }), false);
});

// ===========================================================================
// Key scope enforcement
// ===========================================================================

function perms(overrides: Partial<KeyPermissions> = {}): KeyPermissions {
  return {
    canTrade: true,
    canWithdraw: false,
    canTransfer: false,
    canRead: true,
    ipWhitelist: ["1.2.3.4"],
    raw: [],
    ...overrides,
  };
}

test("a trade+read key with no withdrawal and an IP whitelist is safe", () => {
  const verdict = evaluateKeyScope(perms());
  assert.equal(verdict.safe, true);
  if (verdict.safe) assert.equal(verdict.warnings.length, 0);
});

test("NON-NEGOTIABLE: a withdrawal-enabled key refuses to start", () => {
  const verdict = evaluateKeyScope(perms({ canWithdraw: true }));
  assert.equal(verdict.safe, false);
  if (!verdict.safe) assert.match(verdict.reason, /withdrawal/i);
});

test("withdrawal refusal wins even if everything else looks fine", () => {
  const verdict = evaluateKeyScope(
    perms({ canWithdraw: true, canTrade: true, ipWhitelist: ["1.2.3.4"] }),
  );
  assert.equal(verdict.safe, false);
});

test("no IP whitelist is a warning, not fatal", () => {
  const verdict = evaluateKeyScope(perms({ ipWhitelist: [] }));
  assert.equal(verdict.safe, true);
  if (verdict.safe) assert.ok(verdict.warnings.some((w) => /IP whitelist/i.test(w)));
});

test("internal transfer capability is a warning", () => {
  const verdict = evaluateKeyScope(perms({ canTransfer: true }));
  assert.equal(verdict.safe, true);
  if (verdict.safe) assert.ok(verdict.warnings.some((w) => /transfer/i.test(w)));
});

test("a read-only key warns it cannot trade", () => {
  const verdict = evaluateKeyScope(perms({ canTrade: false }));
  assert.equal(verdict.safe, true);
  if (verdict.safe) assert.ok(verdict.warnings.some((w) => /cannot place orders/i.test(w)));
});

test("Bybit permission shape parses, and detects withdrawal", () => {
  const withdrawKey = parseBybitPermissions({
    permissions: { Wallet: ["AccountTransfer", "Withdraw"], ContractTrade: ["Order"] },
    ips: ["203.0.113.1"],
  });
  assert.equal(withdrawKey.canWithdraw, true);
  assert.equal(withdrawKey.canTrade, true);
  assert.equal(withdrawKey.canTransfer, true);
  assert.deepEqual(withdrawKey.ipWhitelist, ["203.0.113.1"]);

  // And a safe key parses as safe.
  const safe = parseBybitPermissions({
    permissions: { ContractTrade: ["Order", "Position"] },
    ips: ["203.0.113.1"],
  });
  assert.equal(safe.canWithdraw, false);
  assert.equal(evaluateKeyScope(safe).safe, true);
});

test("Bybit '*' IP means no real whitelist", () => {
  const parsed = parseBybitPermissions({ permissions: {}, ips: ["*"] });
  assert.deepEqual(parsed.ipWhitelist, []);
});

// ===========================================================================
// Signal authentication
// ===========================================================================

const SECRET = "webhook-shared-secret";

function verifier(now: () => number): SignalVerifier {
  return new SignalVerifier(SECRET, new MemoryNonceStore(now), 60_000, 5_000, now);
}

function signed(body: string, ts: number, nonce: string): SignedSignal {
  return { body, timestamp: ts, nonce, signature: signSignal(SECRET, body, ts, nonce) };
}

test("a correctly signed, fresh, unseen signal is valid", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  assert.deepEqual(v.verify(signed('{"action":"buy"}', 1_000_000, "n1")), { valid: true });
});

test("ATTACK: an unsigned/forged signal is rejected", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  const forged: SignedSignal = {
    body: '{"action":"buy"}',
    timestamp: 1_000_000,
    nonce: "n1",
    signature: "deadbeef".repeat(8),
  };
  assert.equal(v.verify(forged).valid, false);
});

test("ATTACK: tampering with the body after signing is rejected", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  const s = signed('{"action":"buy","qty":1}', 1_000_000, "n1");
  s.body = '{"action":"buy","qty":1000}'; // attacker inflates the size
  const result = v.verify(s);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "bad_signature");
});

test("ATTACK: replaying a captured valid signal is rejected", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  const s = signed('{"action":"buy"}', 1_000_000, "n1");

  assert.equal(v.verify(s).valid, true);
  // The captured, still-in-window, correctly-signed signal fires again.
  const replay = v.verify(s);
  assert.equal(replay.valid, false);
  if (!replay.valid) assert.equal(replay.reason, "replay");
});

test("ATTACK: a stale signal outside the window is rejected", () => {
  let clock = 1_000_000;
  const v = verifier(() => clock);
  const s = signed('{"action":"buy"}', 1_000_000, "n1");

  clock = 1_000_000 + 61_000; // 61s later, window is 60s
  const result = v.verify(s);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "expired");
});

test("ATTACK: a future-dated signal beyond skew tolerance is rejected", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  const s = signed('{"action":"buy"}', 1_000_000 + 10_000, "n1"); // 10s ahead, tol 5s
  const result = v.verify(s);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "future");
});

test("a forged signature never burns a nonce", () => {
  // Otherwise an attacker guessing signatures could burn legitimate nonces.
  const now = () => 1_000_000;
  const store = new MemoryNonceStore(now);
  const v = new SignalVerifier(SECRET, store, 60_000, 5_000, now);

  const forged: SignedSignal = { body: "x", timestamp: 1_000_000, nonce: "victim-nonce", signature: "00".repeat(32) };
  v.verify(forged);
  assert.equal(store.size, 0, "a forged signal must not consume the nonce");

  // The legitimate signal with that nonce still works.
  assert.equal(v.verify(signed("x", 1_000_000, "victim-nonce")).valid, true);
});

test("malformed signal shapes are rejected, not thrown on", () => {
  const now = () => 1_000_000;
  const v = verifier(now);
  for (const bad of [
    { body: 1, timestamp: 1_000_000, nonce: "n", signature: "s" },
    { body: "x", timestamp: NaN, nonce: "n", signature: "s" },
    { body: "x", timestamp: 1_000_000, nonce: "", signature: "s" },
  ]) {
    const result = v.verify(bad as unknown as SignedSignal);
    assert.equal(result.valid, false);
  }
});

test("the nonce store prunes expired entries so it stays bounded", () => {
  let clock = 1_000;
  const store = new MemoryNonceStore(() => clock);
  store.remember("a", 2_000);
  assert.equal(store.seen("a"), true);
  clock = 3_000;
  assert.equal(store.seen("a"), false, "expired nonce is forgotten");
});
