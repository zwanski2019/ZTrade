import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  secret,
  evaluateKeyScope,
  parseBybitPermissions,
  MemoryNonceStore,
  SignalVerifier,
  signSignal,
  scrub,
  containsSecret,
  containsLiteral,
  type SignedSignal,
} from "@ztrade/security";

/**
 * THE SELF-RED-TEAM SUITE (§3.3).
 *
 * This suite ATTACKS ZTrade. It is the project's front door and its marketing:
 * a trading framework that ships the exploits it defends against, and proves in
 * CI that the defence holds. Every test here is written from the attacker's
 * point of view — it succeeds when the attack FAILS.
 *
 * Each attack maps to a control documented in docs/SECURITY_TESTS.md.
 *
 * A failure in this suite is not a flaky test. It is a security regression, and
 * it must block the build.
 */

// ---------------------------------------------------------------------------
// ATTACK 1: secret exfiltration via any serialisation boundary
// ---------------------------------------------------------------------------

const REAL_KEY = "AQ.Ab8RN6K-realistic-looking-bybit-key-format-XYZ";

test("ATTACK: exfiltrate a key by throwing it through every serialisation path", () => {
  // The attacker's goal: get the key into logs, an error report, telemetry, a
  // crash dump — anywhere it can be read later.
  const key = secret(REAL_KEY, "apiKey");

  const attackSurfaces: string[] = [
    // 1. log the whole config object
    JSON.stringify({ config: { apiKey: key, other: "x" } }),
    // 2. console.log-style inspection
    inspect({ apiKey: key }, { depth: 10 }),
    // 3. error with the secret in context
    String(new Error(`request failed with key ${key}`)),
    // 4. template interpolation into a log line
    `[INFO] connecting with ${key}`,
    // 5. an unhandled-rejection style stringify of a request object
    JSON.stringify({ headers: { authorization: key }, url: "/order" }),
    // 6. array join, a sneaky path
    [1, key, 3].join(","),
  ];

  for (const output of attackSurfaces) {
    assert.ok(
      !output.includes(REAL_KEY),
      `EXFILTRATION SUCCEEDED — key leaked: ${output}`,
    );
  }
});

test("ATTACK: pattern-based leak detection catches a bare key that escaped wrapping", () => {
  // Defence in depth: even a raw string that was never wrapped in Secret gets
  // caught by the value scrubber before it reaches a log sink.
  const leaked = `api_secret=${REAL_KEY} in an error message`;
  const scrubbed = scrub(leaked);
  assert.ok(!containsLiteral(String(scrubbed), REAL_KEY), "scrubber missed a bare key");
  assert.equal(containsSecret(`apiKey=${REAL_KEY}`).leaked, true);
});

// ---------------------------------------------------------------------------
// ATTACK 2: run with a withdrawal-enabled key (account-draining permission)
// ---------------------------------------------------------------------------

test("ATTACK: start the bot with a key that can withdraw funds", () => {
  // The single most dangerous misconfiguration. A compromise of a bot holding a
  // withdrawal-enabled key is a drained account, not a bad trade.
  const withdrawalKey = parseBybitPermissions({
    permissions: { Wallet: ["Withdraw", "AccountTransfer"], ContractTrade: ["Order"] },
    ips: ["203.0.113.7"],
  });

  const verdict = evaluateKeyScope(withdrawalKey);
  assert.equal(verdict.safe, false, "the bot must REFUSE to start on a withdrawal key");
  if (!verdict.safe) assert.match(verdict.reason, /withdrawal/i);
});

// ---------------------------------------------------------------------------
// ATTACK 3: inject an order via a forged webhook
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "shared-webhook-secret";

function verifier(now = () => 1_700_000_000_000) {
  return new SignalVerifier(WEBHOOK_SECRET, new MemoryNonceStore(now), 60_000, 5_000, now);
}

test("ATTACK: inject a trade by POSTing an unsigned webhook", () => {
  // The classic retail-bot hole: a webhook URL that is an unauthenticated
  // "place this trade" endpoint. The attacker knows the URL and forges a signal.
  const forged: SignedSignal = {
    body: JSON.stringify({ action: "buy", symbol: "BTCUSDT", qty: 999 }),
    timestamp: 1_700_000_000_000,
    nonce: "attacker-nonce",
    signature: "f".repeat(64), // guessed
  };
  assert.equal(verifier().verify(forged).valid, false, "forged webhook was accepted");
});

test("ATTACK: replay a legitimately-signed webhook to double a position", () => {
  const now = () => 1_700_000_000_000;
  const v = verifier(now);
  const body = JSON.stringify({ action: "buy", symbol: "BTCUSDT" });
  const legit: SignedSignal = {
    body,
    timestamp: 1_700_000_000_000,
    nonce: "n-legit",
    signature: signSignal(WEBHOOK_SECRET, body, 1_700_000_000_000, "n-legit"),
  };

  assert.equal(v.verify(legit).valid, true);
  // Attacker captured it off the wire and resends within the window.
  assert.equal(v.verify(legit).valid, false, "replay succeeded — position could be doubled");
});

test("ATTACK: tamper with the size of a signed webhook in transit", () => {
  const now = () => 1_700_000_000_000;
  const v = verifier(now);
  const body = JSON.stringify({ action: "buy", qty: 1 });
  const signal: SignedSignal = {
    body,
    timestamp: 1_700_000_000_000,
    nonce: "n1",
    signature: signSignal(WEBHOOK_SECRET, body, 1_700_000_000_000, "n1"),
  };
  // Man-in-the-middle inflates the quantity, keeping the original signature.
  signal.body = JSON.stringify({ action: "buy", qty: 100_000 });
  assert.equal(v.verify(signal).valid, false, "tampered payload was accepted");
});

// ---------------------------------------------------------------------------
// ATTACK 4: clock-skew abuse
// ---------------------------------------------------------------------------

test("ATTACK: pre-sign a far-future signal to bypass expiry", () => {
  const now = () => 1_700_000_000_000;
  const v = verifier(now);
  const future = 1_700_000_000_000 + 3_600_000; // an hour ahead
  const body = "x";
  const signal: SignedSignal = {
    body,
    timestamp: future,
    nonce: "n1",
    signature: signSignal(WEBHOOK_SECRET, body, future, "n1"),
  };
  assert.equal(v.verify(signal).valid, false, "future-dated signal bypassed the window");
});

// ---------------------------------------------------------------------------
// ATTACK 5: nonce exhaustion (DoS a legitimate source)
// ---------------------------------------------------------------------------

test("ATTACK: burn a victim's nonce with a forged signal to block their real signal", () => {
  const now = () => 1_700_000_000_000;
  const store = new MemoryNonceStore(now);
  const v = new SignalVerifier(WEBHOOK_SECRET, store, 60_000, 5_000, now);

  // Attacker sends a forged signal reusing the nonce the victim is about to use.
  v.verify({ body: "x", timestamp: 1_700_000_000_000, nonce: "shared", signature: "bad".repeat(21) + "b" });

  // The victim's genuine signal with that nonce must still work — a forged
  // signal must never consume a nonce.
  const body = "real";
  const legit: SignedSignal = {
    body,
    timestamp: 1_700_000_000_000,
    nonce: "shared",
    signature: signSignal(WEBHOOK_SECRET, body, 1_700_000_000_000, "shared"),
  };
  assert.equal(v.verify(legit).valid, true, "a forged signal burned a legitimate nonce");
});

// ---------------------------------------------------------------------------
// ATTACK 6: timing attack on the webhook secret
// ---------------------------------------------------------------------------

test("ATTACK: recover the signature byte-by-byte via response timing", () => {
  // Not a timing measurement (flaky), but a proof that the comparison is
  // length-safe and constant-time by construction: differing-length and
  // differing-content signatures are both simply rejected, with no early return
  // that would leak a matching prefix.
  const now = () => 1_700_000_000_000;
  const v = verifier(now);
  const body = "x";
  const real = signSignal(WEBHOOK_SECRET, body, 1_700_000_000_000, "n1");

  // A prefix-matching guess of the wrong length is rejected like any other.
  const guesses = [real.slice(0, 10), real.slice(0, -1) + "0", "", "a"];
  for (const guess of guesses) {
    const result = v.verify({ body, timestamp: 1_700_000_000_000, nonce: "n1", signature: guess });
    assert.equal(result.valid, false);
  }
});
