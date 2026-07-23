# Roadmap

## Phases

| Phase | Scope | Status |
| :-- | :-- | :-- |
| **0 — Spine** | Core types, bus, clock, security, audit chain | ✅ **Done** |
| **1 — Read-only** | WS ingestion, L2 rebuild, feature store | ✅ **Done** |
| **2 — Sim loop** | Sim-fill adapter, canary, parity gate | ✅ **Done** |
| **3 — Risk + execution shell** | Risk engine, scheduler, smart exec, kill switch | 🟡 **Mostly** — reconciliation loop outstanding |
| **4 — Paper live** | Private WS, dead-man armed, reconciliation on testnet | ⬜ **Next** |
| **5 — Small live** | Mainnet, tiny size, all gates green | ⬜ Blocked on 3 & 4 |

**Phase 4 is not optional.** Testnet exposes most of the bugs that lose real
money, and it is the phase most likely to be skipped.

## Next up

1. **Reconciliation loop** — periodically diff local state against exchange
   truth and correct toward the exchange. This is what catches missed WS events,
   and it is the last piece of Phase 3.
2. **Journal + cold-start recovery** (gate #6) — rebuild state on restart,
   reconcile, and refuse to trade until reconciled. Currently the engine would
   restart blind. This is the main thing standing between the current state and
   running unattended.
3. **Private WS** — `order` / `execution` / `position` / `wallet`. Schemas exist
   and are validated; only the public streams are wired.
4. **Dead-man's switch armed** (gate #2) — `set_dcp` on a live authenticated
   private WS.
5. **Latency calibration** — set the simulator's fill delay from measured live
   percentiles rather than a default.

## Deliberately not built

Stated plainly so nobody mistakes scaffolding for a finished system.

- **No NATS, TimescaleDB, Redis or OpenTelemetry.** The bus interface is shaped
  for NATS so it drops in without touching subscribers; nothing else is wired.
- **No Rust or Go hot path.** Network round-trip to the exchange dominates
  everything at this scale. Rust earns its place only for local
  orderbook-derived microstructure signals or colocation. Until profiling proves
  the TypeScript loop is the constraint — and it is not — that complexity budget
  is better spent on risk, reconciliation and parity.
- **No custom strategy sandbox.** Needs worker isolation plus resource caps;
  `eval()` in a process holding exchange credentials is not acceptable.
- **No multi-user model.** One shared token, no roles.
- **No partial fill modelling.** A trade row is all-or-nothing.
- **Grid does not manage resting ladder orders.** It enters and exits at market.

## Contributing

See [CONTRIBUTING.md](https://github.com/zwanski2019/ZTrade/blob/main/CONTRIBUTING.md).
The rule that matters most: every subsystem PR must state **how it fails and how
it recovers**.
