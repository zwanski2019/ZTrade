import test from "node:test";
import assert from "node:assert/strict";
import { AuditChain, GENESIS, verifyChain } from "./auditChain.ts";
import { containsLiteral, containsSecret, REDACTED, scrub, scrubString } from "./redaction.ts";
import {
  authHeaders,
  buildQuery,
  deadMansSwitchPayload,
  sign,
  signaturePayload,
  verifySignature,
  wsAuthSignature,
} from "./signer.ts";

// ---------------------------------------------------------------------------
// Tamper-evident audit chain (§8)
// ---------------------------------------------------------------------------

function seededChain(): AuditChain {
  const chain = new AuditChain();
  chain.append({ at: 1, action: "engine.start", detail: "strategy=canary", actor: "127.0.0.1" });
  chain.append({ at: 2, action: "order.submit", detail: "BTCUSDT buy 0.01", actor: null });
  chain.append({ at: 3, action: "risk.veto", detail: "exposure cap", actor: null });
  return chain;
}

test("an untouched chain verifies", () => {
  const result = seededChain().verify();
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.length, 3);
});

test("the first entry commits to the genesis hash", () => {
  const chain = new AuditChain();
  const entry = chain.append({ at: 1, action: "a", detail: "b", actor: null });
  assert.equal(entry.prevHash, GENESIS);
});

test("each entry commits to its predecessor", () => {
  const entries = seededChain().all();
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i]!.prevHash, entries[i - 1]!.hash);
  }
});

test("MODIFYING a historical entry breaks the chain at that index", () => {
  const entries = [...seededChain().all()];
  // Someone edits the record to hide what the bot actually did.
  entries[1] = { ...entries[1]!, detail: "BTCUSDT buy 500" };

  const result = verifyChain(entries);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.brokenAt, 1);
    assert.match(result.reason, /modified/i);
  }
});

test("DELETING an entry breaks the chain", () => {
  const entries = [...seededChain().all()];
  entries.splice(1, 1);

  const result = verifyChain(entries);
  assert.equal(result.valid, false);
});

test("REORDERING entries breaks the chain", () => {
  const entries = [...seededChain().all()];
  [entries[0], entries[1]] = [entries[1]!, entries[0]!];

  const result = verifyChain(entries);
  assert.equal(result.valid, false);
});

test("re-hashing a forged entry still fails, because the successor pins it", async () => {
  // A naive forger recomputes the hash of the entry they edited. The NEXT
  // entry's prevHash still points at the original, so the chain breaks anyway.
  const chain = seededChain();
  const entries = [...chain.all()];
  const forgedInput = { ...entries[1]!, detail: "forged" };
  const { hashEntry } = await import("./auditChain.ts");
  entries[1] = { ...forgedInput, hash: hashEntry(forgedInput.prevHash, forgedInput) };

  const result = verifyChain(entries);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.brokenAt, 2, "the successor detects it");
});

test("an empty chain is valid and reports the genesis head", () => {
  const result = new AuditChain().verify();
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.head, GENESIS);
});

test("the head advances with every append", () => {
  const chain = new AuditChain();
  const first = chain.head;
  chain.append({ at: 1, action: "a", detail: "b", actor: null });
  assert.notEqual(chain.head, first);
});

// ---------------------------------------------------------------------------
// Redaction — ship gate #5
// ---------------------------------------------------------------------------

const FAKE_KEY = "AbCdEf1234567890XyZqRsTuVw";
const FAKE_SECRET = "s3cr3tV4lu3ThatMustNeverAppearInLogs00";

test("structural redaction removes sensitive keys at any depth", () => {
  const scrubbed = scrub({
    level: "info",
    config: { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET, port: 8788 },
    headers: { authorization: `Bearer ${FAKE_SECRET}` },
  }) as Record<string, Record<string, unknown>>;

  assert.equal(scrubbed.config!.apiKey, REDACTED);
  assert.equal(scrubbed.config!.apiSecret, REDACTED);
  assert.equal(scrubbed.config!.port, 8788, "non-secrets survive");
  assert.equal(scrubbed.headers!.authorization, REDACTED);
});

test("GATE #5: a secret pasted into free text is still scrubbed", () => {
  // The case structural redaction cannot catch, and the one that actually
  // happens: a key ending up inside an error message.
  const line = `request failed: api_secret=${FAKE_SECRET} rejected by venue`;
  const scrubbed = scrubString(line);

  assert.ok(!containsLiteral(scrubbed, FAKE_SECRET), "the secret survived redaction");
  assert.ok(scrubbed.includes(REDACTED));
});

test("GATE #5: bearer tokens and telegram tokens are scrubbed", () => {
  const telegram = "123456789:AAHfake_TelegramBotTokenValue_abcdefghij";
  for (const line of [`Authorization: Bearer ${FAKE_SECRET}`, `bot ${telegram} enabled`]) {
    const scrubbed = scrubString(line);
    assert.equal(containsSecret(scrubbed).leaked, false, `leak survived in: ${scrubbed}`);
  }
});

test("containsSecret detects a leak before it reaches a log sink", () => {
  assert.equal(containsSecret(`apiKey=${FAKE_KEY}`).leaked, true);
  assert.equal(containsSecret("nothing sensitive here, just a trade fill").leaked, false);
});

test("scrubbing handles cycles and errors without throwing", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => scrub(cyclic));

  const scrubbedError = scrub(new Error(`boom token=${FAKE_SECRET}`)) as { message: string };
  assert.ok(!containsLiteral(scrubbedError.message, FAKE_SECRET));
});

test("scrubbing never mutates the input object", () => {
  const original = { apiKey: FAKE_KEY };
  scrub(original);
  assert.equal(original.apiKey, FAKE_KEY, "the live config must remain usable");
});

// ---------------------------------------------------------------------------
// Bybit v5 signing — fixed vectors (§8)
// ---------------------------------------------------------------------------

const VECTOR = {
  apiKey: "testkey123456789012",
  apiSecret: "testsecret9876543210",
  timestamp: "1700000000000",
  recvWindow: "5000",
  payload: "category=linear&symbol=BTCUSDT",
};

test("the signature payload is concatenated in the exact documented order", () => {
  assert.equal(
    signaturePayload(VECTOR),
    "1700000000000testkey1234567890125000category=linear&symbol=BTCUSDT",
  );
});

test("signing is deterministic and hex-encoded", () => {
  const a = sign(VECTOR);
  const b = sign(VECTOR);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("any change to any signed component changes the signature", () => {
  const baseline = sign(VECTOR);
  const mutations = [
    { ...VECTOR, timestamp: "1700000000001" },
    { ...VECTOR, apiKey: "otherkey12345678901" },
    { ...VECTOR, recvWindow: "6000" },
    { ...VECTOR, payload: "category=linear&symbol=ETHUSDT" },
    { ...VECTOR, apiSecret: "differentsecret98765" },
  ];
  for (const mutated of mutations) {
    assert.notEqual(sign(mutated), baseline);
  }
});

test("auth headers carry every field Bybit requires", () => {
  const headers = authHeaders(VECTOR);
  assert.equal(headers["X-BAPI-API-KEY"], VECTOR.apiKey);
  assert.equal(headers["X-BAPI-SIGN"], sign(VECTOR));
  assert.equal(headers["X-BAPI-SIGN-TYPE"], "2");
  assert.equal(headers["X-BAPI-RECV-WINDOW"], "5000");
});

test("query building is order-independent, so the signed string is stable", () => {
  // Two objects with the same pairs in different insertion order MUST produce
  // the same string, or the signature depends on how the caller built the object.
  assert.equal(
    buildQuery({ symbol: "BTCUSDT", category: "linear" }),
    buildQuery({ category: "linear", symbol: "BTCUSDT" }),
  );
  assert.equal(buildQuery({ b: 2, a: 1 }), "a=1&b=2");
  assert.equal(buildQuery({ a: 1, skip: undefined }), "a=1");
});

test("signature verification is length-safe", () => {
  const s = sign(VECTOR);
  assert.equal(verifySignature(s, s), true);
  assert.equal(verifySignature(s, "short"), false);
  assert.equal(verifySignature(s, s.slice(0, -1) + "0"), false);
});

test("WebSocket auth uses the GET/realtime scheme, not the REST one", () => {
  // A common silent failure: the socket connects but never delivers order
  // events because it was signed with the REST payload.
  const wsSig = wsAuthSignature(VECTOR.apiSecret, 1700000000000);
  assert.match(wsSig, /^[0-9a-f]{64}$/);
  assert.notEqual(wsSig, sign(VECTOR));
});

// ---------------------------------------------------------------------------
// Dead-man's switch — ship gate #2
// ---------------------------------------------------------------------------

test("GATE #2: the dead-man payload is well formed", () => {
  const payload = deadMansSwitchPayload(60);
  assert.equal(payload.op, "set_dcp");
  assert.equal(payload.args[0].timeWindow, 60);
});

test("GATE #2: the window is clamped into the range the venue accepts", () => {
  // An out-of-range value would be rejected, leaving the switch silently
  // unarmed — strictly worse than a shorter window.
  assert.equal(deadMansSwitchPayload(1).args[0].timeWindow, 10);
  assert.equal(deadMansSwitchPayload(99_999).args[0].timeWindow, 300);
  assert.equal(deadMansSwitchPayload(45.6).args[0].timeWindow, 46);
});
