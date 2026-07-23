import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyOrderEvent, newOrder, type OrderEvent, type OrderRecord } from "./orderState.ts";

/**
 * Append-only journal and cold-start recovery (§4.6, ship gate #6).
 *
 * The rule the gate encodes: after a crash or restart, the engine must NOT
 * resume trading on a guess. It rebuilds its order and position state from the
 * journal, reconciles that against exchange truth, and refuses to place a
 * single order until the two agree.
 *
 * The journal records order LIFECYCLE events — the same OrderEvents the state
 * machine consumes — plus a marker for each opened order so replay knows the
 * symbol/side/qty to seed the record with. Replaying them through the identical
 * `applyOrderEvent` used live means the rebuilt state is exactly what the engine
 * would have held, not an approximation.
 *
 * Format is JSONL: one JSON object per line, appended, never rewritten. A torn
 * final line (killed mid-write) is skipped on read rather than aborting
 * recovery — losing the last event is safe, refusing to start is not.
 */
export type JournalEntry =
  | { t: "open"; at: number; orderLinkId: string; symbol: string; side: "buy" | "sell"; qty: number }
  | { t: "event"; at: number; orderLinkId: string; event: OrderEvent }
  | { t: "reconciled"; at: number; detail: string };

export interface JournalStore {
  append(entry: JournalEntry): void;
  read(): JournalEntry[];
}

/** File-backed JSONL journal. */
export class FileJournal implements JournalStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: JournalEntry): void {
    // Synchronous append: the journal must be durable BEFORE the action it
    // records is allowed to proceed. An async write that races the order is a
    // journal that can miss the very event a crash would need.
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  read(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n");
    const out: JournalEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn final line from a killed write. Skip it — see the class note.
      }
    }
    return out;
  }
}

/** In-memory journal, for tests and dry runs. */
export class MemoryJournal implements JournalStore {
  private entries: JournalEntry[] = [];
  append(entry: JournalEntry): void {
    this.entries.push(entry);
  }
  read(): JournalEntry[] {
    return [...this.entries];
  }
}

export interface RecoveredState {
  orders: Map<string, OrderRecord>;
  /** Net signed position per symbol, derived from fills. */
  positions: Map<string, number>;
  /** True when the journal ends with a reconciliation marker. */
  lastReconciledAt: number | null;
}

/**
 * Rebuilds engine state from journal entries.
 *
 * Positions are derived from FILLS, exactly as the live engine derives them, so
 * a rebuilt position equals the one the engine held before the crash. A `fill`
 * event whose order was never opened in the journal is skipped: without the
 * open marker we do not know its side, and guessing would corrupt the position.
 */
export function recoverState(entries: readonly JournalEntry[]): RecoveredState {
  const orders = new Map<string, OrderRecord>();
  const positions = new Map<string, number>();
  let lastReconciledAt: number | null = null;

  for (const entry of entries) {
    if (entry.t === "reconciled") {
      lastReconciledAt = entry.at;
      continue;
    }

    if (entry.t === "open") {
      orders.set(
        entry.orderLinkId,
        newOrder({
          orderLinkId: entry.orderLinkId,
          symbol: entry.symbol,
          side: entry.side,
          qty: entry.qty,
        }),
      );
      continue;
    }

    // entry.t === "event"
    const existing = orders.get(entry.orderLinkId);
    if (!existing) continue; // fill/ack for an unknown order — see the note.

    const result = applyOrderEvent(existing, entry.event);
    if (!result.ok) continue; // illegal replay transition; keep prior state.

    orders.set(entry.orderLinkId, result.order);

    if (entry.event.type === "fill") {
      const signed = existing.side === "buy" ? entry.event.qty : -entry.event.qty;
      positions.set(existing.symbol, (positions.get(existing.symbol) ?? 0) + signed);
    }
  }

  return { orders, positions, lastReconciledAt };
}

/**
 * Gates trading until the rebuilt state has been reconciled against the venue.
 *
 * Cold start flow:
 *   1. recoverState() from the journal
 *   2. pull exchange truth, reconcile()
 *   3. markReconciled() — only now may the engine trade
 *
 * `canTrade` is false until step 3, so a bug in the reconcile wiring fails
 * CLOSED (no trading) rather than open.
 */
export class RecoveryGate {
  private reconciled = false;

  get canTrade(): boolean {
    return this.reconciled;
  }

  markReconciled(): void {
    this.reconciled = true;
  }

  block(): void {
    this.reconciled = false;
  }
}
