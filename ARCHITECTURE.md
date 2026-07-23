# ZTrade — Advanced Systems Architecture

Implementation status against the build directive. This document is the honest
ledger: what exists, what does not, and how each subsystem fails.

---

## Phase status (§9)

| Phase | Scope | Status |
| --- | --- | --- |
| **0 — Spine** | core types, bus, clock, security, redaction, audit chain | **Done** |
| **1 — Read-only** | Bybit WS ingestion, L2 rebuild, feature store | **Done** — §4.1 acceptance green, verified against live Bybit |
| **2 — Sim loop** | sim-fill adapter, canary, parity gate | **Done** (gate #7 green) |
| **3 — Risk + execution shell** | risk engine, order SM, idempotency, scheduler | **Done** — risk engine, scheduler, smart exec, kill switch AND reconciliation loop all built and tested |
| **4 — Paper live** | testnet WS/REST, reconciliation under real latency | **Built and verified** — live REST broker, private WS with armed dead-man switch, journal + cold-start recovery, reconciliation loop; connect/auth path verified against real testnet. Remaining: a sustained multi-day soak with real keys |
| **5 — Small live** | mainnet, all gates green | **Ready to begin** — all 7 ship gates green in code; needs the Phase 4 testnet soak first |

The legacy `apps/server` engine from v0.3 still runs and still trades on
testnet. It is **not** yet migrated onto this spine. Both exist side by side, as
the directive's "additive, migrate incrementally" instruction requires.

---

## Ship gates (§1)

| # | Gate | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Kill switch works cold | **Done** | Runs on a dedicated worker thread with its own listener; proven to answer while the main thread is wedged in a 2s busy loop |
| 2 | Dead-man's switch armed | **Done** | Armed on the private WS AFTER auth and BEFORE subscribe, and re-armed on every reconnect; connect sequence verified against real Bybit testnet |
| 3 | Risk engine vetoes independently | **Done** | `packages/risk` — all 7 §4.4 checks + 3-state breaker, property-tested that exposure can never breach the cap |
| 4 | Idempotent orders | **Done** | Deterministic `orderLinkId`; duplicate submission refused — `parity.test.ts` |
| 5 | No plaintext keys in logs | **Done** | Two-layer redaction + end-to-end `pnpm gate:secrets` |
| 6 | State recovers on restart | **Done** | Durable JSONL journal, cold-start rebuild via the same order-state machine, reconcile against the venue, and a recovery gate that fails CLOSED until reconciled |
| 7 | Backtest == live parity | **Done** | `pnpm gate:parity` |

Gate 2 remains Partial deliberately: the `set_dcp` payload is built, clamped and
tested, but it is not yet sent on a live authenticated private WS. Calling it
done would be the exact kind of overstatement that gets an account drained.

---

## Failure modes (§13)

### `packages/core` — clock

**How it fails:** a strategy calls `Date.now()` or `setTimeout` and its
decisions stop being a pure function of the tape.
**How you find out:** the parity gate goes red — the same tape produces
different decisions on two runs.
**How it recovers:** it does not, silently. That is why the gate is a build
blocker rather than a warning. `StrategyContext` deliberately exposes no way to
reach wall-clock time.

### `packages/core` — bus

**How it fails:** a subscriber throws and downstream subscribers never see the
message.
**How it recovers:** handler errors are caught per-subscriber and reported
through `onHandlerError`; delivery to the remaining subscribers continues.
Handlers are awaited sequentially, preserving the single-writer guarantee.
**Known limit:** in-process only. No durability, no replay. Swapping in
JetStream is an implementation of `Bus` and touches no subscriber.

### `packages/security` — audit chain

**How it fails:** someone edits, deletes, or reorders history to hide what the
bot did.
**How you find out:** `verify()` returns the exact index where the chain broke.
Re-hashing a forged entry does not help — the successor's `prevHash` still pins
the original, which is asserted directly in the tests.
**Known limit:** it detects tampering, it does not prevent it. An attacker who
can rewrite the whole store can rebuild a consistent chain. Defeating that
needs the head hash published somewhere they do not control; `AuditChain.head`
is exposed for exactly that.

### `packages/security` — redaction

**How it fails:** a secret reaches a log sink through a path nobody modelled —
a `console.log(config)`, a dependency dumping request headers, an unhandled
rejection stringifying the client.
**How you find out:** `pnpm gate:secrets` boots the real server with sentinel
credentials, exercises the endpoints most likely to echo config, and scans both
process output and every HTTP response body.
**How it recovers:** it does not recover — a leaked key must be rotated. The
gate exists to stop the leak reaching production, not to clean up after it.

### `packages/execution` — order state machine

**How it fails:** an exchange event arrives that contradicts local state — an
overfill, a fill on a terminal order, a transition that should be impossible.
**How it recovers:** the machine is pure and returns a typed error instead of
mutating. Overfills and post-terminal fills are refused loudly, because
accepting them would corrupt position accounting and every risk check
downstream. Late duplicate *terminal* events are a quiet no-op — a REST poll
racing the WS is routine, and alerting on it would train the operator to ignore
alerts.
**Proof:** fuzzed event sequences over 400 seeds never reach an illegal state,
never exceed order quantity, and never escape a terminal state.

### `packages/adapters-sim` — sim broker

**How it fails:** it flatters a strategy. Instant fills, no fees, no queue, and
every backtest looks profitable.
**How it is mitigated:** fills resolve only after configured latency has
elapsed in *event* time; market orders sweep real book depth; maker and taker
fees are charged separately; resting orders fill only when price trades through
or observed volume clears the queue ahead.
**Known limit:** queue position is modelled with a single `queueAheadFactor`,
not a real matching engine. It is pessimistic by default (you join the back of
the queue), which is the correct direction to be wrong in.

### `packages/ingestion` — L2 orderbook

**How it fails:** a dropped WS message leaves our book silently diverged from
the exchange's. Every price derived from it is then wrong in a way that looks
completely normal.
**How you find out:** `u` must increment by exactly one. A gap marks the book
STALE, and `snapshot()` returns null while stale — there is deliberately no
accessor that keeps working. A crossed book (bid >= ask) is caught even when
sequencing looks perfect: sequence continuity proves we missed nothing,
crossed-book detection proves we applied what we got correctly. Bybit v5 linear
publishes no per-message checksum, so this is the strongest integrity signal
actually available.
**How it recovers:** unsubscribe/resubscribe forces a fresh snapshot, which
rebuilds from scratch rather than merging onto the corrupt remains. A socket
close invalidates every book immediately, because updates that occurred while
we were away are simply gone.
**Proof:** the §4.1 acceptance tests assert zero events are emitted during the
gap window, that no gap-window price leaks into any event, and that a fresh
snapshot restores service.

### `packages/ingestion` — validation

**How it fails:** a malformed payload is coerced — `Number(undefined)` is NaN,
and NaN propagates silently through arithmetic until it becomes a wrong size.
**How it recovers:** every inbound message is Zod-parsed fail-closed. An
invalid payload is dropped and counted, never partially applied.

### `packages/features` — feature store

**How it fails:** a feature is computed differently in backtest and live, so a
strategy sees different inputs and the parity gate cannot catch it (parity
compares decisions, and both sides would be consistently wrong).
**How it is prevented:** the store is fed only the normalised event stream, does
no I/O and reads no clock, so replaying a tape reproduces every value exactly.
Incremental updates are property-tested against a naive full recompute.
**Known limit:** rolling variance uses Welford rather than sum-of-squares
because the latter loses catastrophic precision at asset-price magnitudes; the
test asserts agreement to 1e-6 relative.

### `packages/risk` — risk engine

**How it fails:** a strategy bug emits an intent that would concentrate,
over-lever, or burst-order the account into a hole.
**How it recovers:** every intent passes through, and a veto is final —
strategies have no path to a broker, so this cannot be routed around. Checks run
cheapest-first and all seven are hard denials. A vetoed order is logged as a
first-class decision; silently dropping intents is how you end up staring at a
strategy that "isn't trading" with no record of why.
**Deliberate exception:** reduce-only orders survive a tripped breaker.
Blocking them would trap the operator in the very position the breaker fired
over.
**Proof:** fuzzed intents across 300 seeds can never push aggregate notional
past the cap, and nothing is ever accepted while the breaker blocks new risk.

### `packages/execution` — kill switch

**How it fails:** the trading loop wedges — infinite loop, sync stall, deadlocked
await — while holding exposure. An in-process kill switch is exactly as stuck as
the thing it is meant to stop.
**How it recovers:** it runs on a dedicated worker thread with its own event
loop and HTTP listener, holds its own credentials, and shares NO state with the
engine. Any shared structure is one that can be mid-mutation when the main
thread hangs. It cancels before flattening, because flattening while resting
orders are live can have them fill against the flattening trade and re-open the
position. Each symbol is closed independently: a partial flatten beats none.
**Proof:** the gate test wedges the main thread in a 2s busy loop and asserts
the request was both issued and served inside that window.
**Known limit:** it fires blind. It does not reconcile, does not verify the
flatten succeeded, and does not retry. It is the last resort, not a workflow.

### `packages/execution` — rate scheduler

**How it fails:** blind firing earns a 10006/10018, and the forced back-off
lands precisely when you most need an order to reach the venue.
**How it recovers:** per-category token buckets (one global bucket lets a
market-data burst starve order placement), exponential back-off on rate errors,
and venue headers treated as authoritative *downward only* — the venue counts
requests we may not know about, so a header can lower our estimate but never
inflate it.

### `packages/adapters-bybit` — private WebSocket

**How it fails:** the account stream is the single source of order truth; if it
silently stalls, fills stop arriving and the engine's view freezes.
**How it recovers:** on any disconnect it reconnects, re-authenticates, and
CRUCIALLY re-arms the dead-man switch — the venue tied the previous arming to
the connection that dropped, so a naive reconnect would leave exposure
unprotected. A rejected auth does NOT reconnect (the same key will just fail
again); it stays ERROR until an operator restarts.
**Gate #2 proof:** the connect sequence is asserted to be auth → set_dcp →
subscribe, in that order, on both first connect and every reconnect, and the
handshake was verified against real Bybit testnet.

### `packages/execution` — journal and cold-start recovery

**How it fails:** the process crashes mid-session with open positions, and a
naive restart resumes trading against a guessed state.
**How it recovers:** every account event is journalled SYNCHRONOUSLY to JSONL
before the broker sees it, so a crash loses nothing. On restart, recoverState()
replays the journal through the identical order-state machine used live, so the
rebuilt state equals what the engine held. Then it reconciles against the venue
and only opens the recovery gate — which fails CLOSED — once reconciled. A torn
final line from a killed write is skipped, not fatal.
**Gate #6 proof:** cold start is tested to rebuild, reconcile, correct toward
the exchange when the journal disagrees, and to leave trading OFF when
reconciliation cannot complete.

### `packages/adapters-bybit` — live broker

**How it fails:** a submitted order times out and we do not know if it landed;
retrying blindly double-fills.
**How it recovers:** the deterministic `orderLinkId` is passed straight to the
venue as its client order id. A retry reuses it, Bybit rejects the duplicate
(110072), and the adapter reports that as `duplicate: true` — a safe outcome,
not a failure. Order state NEVER comes from the REST response; it comes only
from the private execution stream (§11), so a 200 that is actually a
never-filled order cannot be mistaken for a fill.
**Known limit:** the account WebSocket that feeds `ingestOrderEvent` is the
single point of truth for fills; if it silently stalls, the reconciliation loop
below is the backstop.

### `packages/execution` — reconciliation loop

**How it fails:** a dropped private-WS message leaves the engine believing it
holds a position it has closed, or unaware of one it holds. Risk then sizes
against a fiction.
**How it recovers:** `reconcile()` periodically diffs local order/position
state against a fresh exchange pull. Position mismatches resolve TOWARD the
exchange — that is where the money actually is. Order-level drift (phantom and
untracked orders) is reported for re-query and logging but not auto-cancelled,
because acting on a single missed message is more dangerous than the brief
inconsistency the next event will fix.
**Known limit:** this is periodic, not continuous. Between passes the engine can
be briefly wrong; the interval trades staleness against API budget.

### `packages/execution` — engine loop

**How it fails:** lookahead — a strategy sees a fill from an order it submitted
on the same event.
**How it is prevented:** ordering inside `handle()` is fixed. The broker is
drained *before* the strategy runs, so a fill can only ever be observed on a
later event than its submission. This is structural, not a convention.
**Known limit:** single-node, single-writer, in-process. No NATS, no journal,
no crash recovery yet.

---

## What is deliberately NOT built

Stated plainly so nobody mistakes scaffolding for a finished system:

- **No private WS stream.** Order/execution/position/wallet schemas exist and
  are validated, but only the public streams are wired. Phase 3/4.
- **No orderbook checksum.** Bybit v5 linear does not publish one; crossed-book
  detection is the substitute (see below).
- **No journal or cold-start reconciliation.** Gate #6 is not met; the engine
  would restart blind.
- **No rate-limit-aware scheduler**, no TWAP, no iceberg, no post-only re-peg.
  The `ExecutionStyle` type models them; only `market` and `limit` are honoured
  by the sim broker.
- **No NATS, no TimescaleDB, no Redis, no OpenTelemetry.** The bus interface is
  shaped for NATS; nothing else is wired.
- **No Rust/Go hot path**, per §12 — and there is no evidence yet that the TS
  loop is anywhere near the constraint.

---

## Running the gates

```bash
pnpm gate:parity     # gate #7 — backtest/live decision parity
pnpm gate:secrets    # gate #5 — end-to-end secret log scan
pnpm test:gates      # both, plus the security and execution suites
pnpm -r typecheck
```

A red parity gate means every backtest number in this repository is fiction
until it is green again.
