# ZTrade Threat Model

> A trading bot is a credentialed, internet-facing, money-moving process.
> Adversaries want it. Most open-source trading frameworks treat security as an
> afterthought. ZTrade treats it as the product.

This document enumerates the threats ZTrade defends against, the mitigation for
each, and — where one exists — the self-red-team test that proves the mitigation
holds ([`docs/SECURITY_TESTS.md`](SECURITY_TESTS.md)).

Scope: the ZTrade process, its control plane, its credentials, and its trust
boundary with the exchange and with signal sources.

---

## Trust boundaries

```
   UNTRUSTED                    │  ZTrade process           │  EXCHANGE
   ─────────                    │  ────────────             │  ────────
   webhook / signal sources ───┼──▶ signal auth ──▶ risk ──┼──▶ signed REST
   the internet (dashboard) ───┼──▶ control-plane auth      │
   npm dependency tree ────────┼──▶ (supply chain)          │
   other host processes ───────┼──▶ (local)                 │
                               │  secrets: Secret<T>, vault │  ◀── private WS
```

Everything left of the process boundary is untrusted input, including a signal
that claims to come from your own TradingView account.

---

## Threats and mitigations

### T1 — Credential theft via serialisation

**Attack.** A key reaches a log, error report, crash dump, or telemetry sink —
someone logs a config object, an error stringifies a request, an unhandled
rejection dumps the client.

**Mitigation.** `Secret<T>` (§ Security Plane). Every serialisation path a
logger can reach — `toString`, `toJSON`, `util.inspect`, primitive coercion —
returns `[REDACTED]`. The plaintext is reachable only through an explicit
`.expose()` that greps trivially in review. A second, pattern-based scrubber
catches any bare key that was never wrapped.

**Proven by.** Redaction property test (500 fuzzed serialisations, zero leaks) +
the exfiltration attack in the red-team suite.

### T2 — Account-draining key

**Attack.** The bot holds a withdrawal-enabled API key. A compromise — leaked
key, RCE via a strategy, exposed dashboard — drains the account rather than
merely trading badly.

**Mitigation.** Key-scope enforcement. On startup ZTrade queries its own key's
permissions and **refuses to start** if withdrawal is enabled. Loud and fatal,
never a warning.

**Proven by.** `evaluateKeyScope` tests + the withdrawal-key attack.

### T3 — Order injection via a forged webhook

**Attack.** A webhook or signal endpoint is an unauthenticated "place this
trade" path. Anyone who learns the URL moves the account. Or a legitimate signal
is captured and replayed to re-fire a trade.

**Mitigation.** Signal authentication: HMAC-SHA256 over
`timestamp.nonce.body`, plus replay protection (nonce + timestamp window).
Unsigned, tampered, stale, future-dated, or replayed signals are rejected. A
forged signal never burns a legitimate nonce.

**Proven by.** Six attack tests: forged, replayed, tampered, future-dated,
nonce-exhaustion, timing.

### T4 — Exposed control plane

**Attack.** The dashboard/API is bound to `0.0.0.0` without auth. A common,
real finding in deployed retail bots.

**Mitigation.** Bearer-token auth on every route, bound to loopback by default,
constant-time comparison, per-IP rate limiting, WebSocket origin checks, and a
read/trade privilege split. `ztrade doctor` flags a public bind as a **fail**
when auth is off.

**Proven by.** Auth and origin tests in `apps/server`; the doctor network-exposure
checks.

### T5 — Supply-chain compromise

**Attack.** A malicious or typosquatted npm package in a process holding trading
keys. A postinstall script exfiltrates them.

**Mitigation (in progress).** Minimal dependency budget enforced by `ztrade
doctor`, committed lockfile, Dependabot, `npm audit` in CI. **Planned:**
`--ignore-scripts`, osv-scanner, published SBOM, signed releases.

### T6 — Strategy plugin as RCE

**Attack.** A downloaded community strategy is arbitrary code in a keyed
process — it opens a socket, reads the filesystem, spawns a child.

**Mitigation (partial).** The custom-strategy slot is currently **inert** by
design — running operator-supplied code is disabled until a real capability
sandbox exists. **Planned:** a capability manifest, deny-by-default, signals
routed only through the bus, no raw network/fs/child_process.

### T7 — Spoofed or corrupted exchange data

**Attack.** Out-of-order or malformed order-book deltas corrupt local state, or
a replayed signed request is accepted.

**Mitigation.** Strict L2 sequence validation — a gap forces a resnapshot, a
crossed book marks stale, and a stale book **serves no prices at all**. Tight
`recvWindow` bounds replay. Clock-skew is flagged by `ztrade doctor`.

**Proven by.** The §4.1 ingestion acceptance tests.

### T8 — Local / insider

**Attack.** Another process on the host reads memory or unencrypted state.

**Mitigation (partial).** Secrets held only in memory, dropped on shutdown;
loopback-only binding. **Planned:** vault-backed secrets at rest (age/sops),
encrypted state.

### T9 — Denial of service

**Attack.** A co-tenant bot exhausts the shared rate limit; a WS flood.

**Mitigation.** Per-category rate governor with exponential back-off; the kill
switch runs out-of-process so it answers even when the main loop is wedged.

---

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md). **Never open a public issue.** ZTrade
practises the disclosure process it documents.

---

## Honest limits

Security is a posture, not a finished state. Known gaps, stated plainly:

- No secrets-at-rest vault yet (age/sops) — secrets live in `.env` and memory.
- No SBOM or signed releases yet.
- No strategy capability sandbox — the custom slot is disabled instead.
- No multi-user model — the API token is a single shared credential.
- JavaScript strings are immutable, so secret zeroing is best-effort (drop the
  reference for GC), not a memory wipe. Claiming otherwise would be theatre.
