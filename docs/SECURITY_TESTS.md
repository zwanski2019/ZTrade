# Security Tests — The Self-Red-Team Suite

> ZTrade ships the exploits it defends against, and proves in CI that the
> defence holds. This page is the project's front door.

The suite in [`security-tests/`](../security-tests) *attacks ZTrade*. Every test
is written from the attacker's point of view — it passes when the attack
**fails**. A failure here is a security regression and blocks the build.

```bash
pnpm --filter @ztrade/security-tests redteam
```

Each attack below maps to a control in the [threat model](THREAT_MODEL.md).

---

## The attacks

### 1. Secret exfiltration via any serialisation boundary

**The attack.** Get a trading key into a log, an error report, telemetry, or a
crash dump — anywhere it can be read later. The suite throws a wrapped key
through six serialisation paths: `JSON.stringify`, `util.inspect`, an `Error`
message, template interpolation, a request-object stringify, and `Array.join`.

**The control.** `Secret<T>` redacts on every path structurally. A second
pattern scrubber catches bare keys that were never wrapped.

**Passes when.** The real key appears in **none** of the six outputs.

### 2. Running with a withdrawal-enabled key

**The attack.** Start the bot with a key that can move funds off the exchange —
turning any compromise into a drained account.

**The control.** Key-scope enforcement refuses to start on a withdrawal key.

**Passes when.** `evaluateKeyScope` returns `safe: false`.

### 3. Order injection via a forged webhook

**The attack.** POST an unsigned "buy 999 BTC" signal to the webhook endpoint,
the way an attacker who guessed the URL would.

**The control.** HMAC signature verification rejects anything not signed with
the shared secret.

**Passes when.** The forged signal is rejected.

### 4. Replaying a legitimately-signed webhook

**The attack.** Capture a real, correctly-signed signal off the wire and resend
it within its validity window to double the position.

**The control.** Nonce-based replay protection burns each nonce on first use.

**Passes when.** The first delivery is accepted and the replay is rejected as
`replay`.

### 5. Tampering with a signed payload in transit

**The attack.** A man-in-the-middle inflates the order quantity while keeping
the original signature.

**The control.** The signature covers the body, so any change invalidates it.

**Passes when.** The tampered signal is rejected as `bad_signature`.

### 6. Clock-skew abuse

**The attack.** Pre-sign a signal dated an hour in the future to sidestep the
expiry window.

**The control.** A signal beyond the skew tolerance is rejected as `future`.

**Passes when.** The future-dated signal is rejected.

### 7. Nonce exhaustion (DoS a legitimate source)

**The attack.** Send a forged signal reusing the nonce the victim is about to
use, to burn it and block their real signal.

**The control.** A forged signal is rejected *before* its nonce is consumed, so
it can never burn a legitimate one.

**Passes when.** The victim's genuine signal with that nonce still works.

### 8. Timing attack on the webhook secret

**The attack.** Recover the signature byte-by-byte from response timing.

**The control.** Constant-time, length-safe comparison — no early return leaks a
matching prefix.

**Passes when.** Prefix-matching and wrong-length guesses are all rejected
identically.

---

## What is NOT yet covered

Being honest about the suite's own gaps (the alternative is theatre):

- **Malicious strategy plugin escape** — the strategy sandbox does not exist
  yet; the custom-strategy slot is disabled instead of sandboxed, so there is
  nothing to attack. When the sandbox lands, an fs/net/child_process escape test
  lands with it.
- **Rogue-order reconciliation** — reconciliation exists and is tested in
  `@ztrade/adapters-bybit`, but a dedicated "place an order outside the bot and
  assert it halts" chaos test against testnet is future work.
- **Dependency-confusion / typosquat CI check** — planned, not built.
- **Spoofed-WS-frame chaos test** — the ingestion layer's stale-book behaviour
  is unit-tested; an end-to-end malformed-frame injection test is future work.

These are tracked as the next expansion of this suite.
