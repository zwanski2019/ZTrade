# Ship Gates

A build is not shippable unless these hold. Status is tracked honestly — gates
are marked Partial where the *mechanism* exists but live wiring does not.
Overstating them is how accounts get drained.

| # | Gate | Status | Evidence |
| :-: | :-- | :-- | :-- |
| 1 | Kill switch works cold | ✅ **Done** | Dedicated worker thread; proven to answer while the main thread is wedged in a 2s busy loop |
| 2 | Dead-man's switch armed | 🟡 **Partial** | `set_dcp` payload built, clamped and tested; not yet sent on a live authenticated private WS |
| 3 | Risk engine vetoes independently | ✅ **Done** | All 7 §4.4 checks + 3-state breaker; property-tested that exposure cannot breach the cap |
| 4 | Idempotent orders | ✅ **Done** | Deterministic `orderLinkId`; duplicate submission refused |
| 5 | No plaintext keys on disk or in logs | ✅ **Done** | Two-layer redaction + end-to-end `pnpm gate:secrets` |
| 6 | State recovers on restart | ❌ **Not done** | No journal, no cold-start reconciliation |
| 7 | Backtest == live parity | ✅ **Done** | `pnpm gate:parity` |

## Gate 7 — parity

The load-bearing one.

```bash
pnpm gate:parity
```

A canary strategy is replayed through two independently constructed engines on
the same tape. The decision logs must be **byte-identical**.

**If this goes red, every backtest number in the repository is fiction until it
is green again.** That is why it is a build blocker, not a warning.

Three further properties are asserted alongside it: determinism (the same tape
twice), no-lookahead (a fill never resolves on the event that submitted it), and
position accounting derived purely from fills.

## Gate 4 — idempotency

```
orderLinkId = "zt-" + sha256(strategyId ‖ symbol ‖ intentSeq)
```

No timestamp. No random value. No attempt counter. Any of those would make a
retry a *new order*, which is precisely the bug this prevents.

The dangerous case — "did my order land before the connection dropped?" —
becomes a safe no-op: the venue rejects the duplicate `clientOrderId`.

## Gate 5 — secrets

```bash
pnpm gate:secrets
```

Boots the **real server** with sentinel credentials, exercises the endpoints most
likely to echo config, and scans both process output *and every HTTP response
body*.

Deliberately end-to-end rather than a unit test of the redactor. What this
catches is what unit tests structurally cannot: a `console.log(config)` added
later, a dependency dumping its own request headers, an unhandled rejection
stringifying the client. That is how keys actually leak.

## Gate 1 — kill switch

The test that matters wedges the main thread in a 2-second busy loop and asserts
the kill request was both **issued and served** inside that window.

An earlier version of that test passed while proving nothing — the request
completed 22 ms *before* the block started. Asserting a 200 on a healthy process
proves nothing at all.

## Gate 6 — not met

There is no journal and no cold-start reconciliation. The engine would restart
blind. This is Phase 4 work and is the main thing standing between the current
state and running unattended.
