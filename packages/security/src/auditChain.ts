import { createHash } from "node:crypto";

/**
 * Append-only, tamper-evident audit log (§8).
 *
 * Every entry commits to the previous one:
 *
 *     h_n = SHA256(h_{n-1} || canonical(entry_n))
 *
 * Editing, reordering, or deleting any historical entry breaks the chain from
 * that point forward, and `verify()` reports the exact index where it broke.
 * This is the forensic record: if an account behaves anomalously, this is what
 * distinguishes "the strategy did it" from "someone changed the record".
 *
 * It does NOT protect against an attacker who can rewrite the whole file — for
 * that the head hash must be published somewhere they do not control (§8
 * mentions a separate store; the head is exposed here for exactly that).
 */
export const GENESIS = "0".repeat(64);

export interface AuditEntryInput {
  /** Event-time millis. Passed in, never read from a clock, so replays match. */
  at: number;
  action: string;
  detail: string;
  actor: string | null;
  /** Correlation id linking this to one decision's whole lifecycle. */
  correlationId?: string;
}

export interface ChainedAuditEntry extends AuditEntryInput {
  seq: number;
  prevHash: string;
  hash: string;
}

/**
 * Canonical serialisation.
 *
 * Field order is fixed and explicit rather than relying on JSON.stringify's
 * insertion order — otherwise the same logical entry could hash differently
 * depending on how the object happened to be constructed, and verification
 * would fail for no reason.
 */
export function canonicalise(entry: AuditEntryInput & { seq: number }): string {
  return JSON.stringify([
    entry.seq,
    entry.at,
    entry.action,
    entry.detail,
    entry.actor ?? null,
    entry.correlationId ?? null,
  ]);
}

export function hashEntry(prevHash: string, entry: AuditEntryInput & { seq: number }): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalise(entry))
    .digest("hex");
}

export type VerifyResult =
  | { valid: true; head: string; length: number }
  | { valid: false; brokenAt: number; reason: string };

/**
 * In-memory chain builder. Persistence is the caller's job — this type only
 * owns the cryptographic linkage so it can be unit-tested in isolation.
 */
export class AuditChain {
  private entries: ChainedAuditEntry[] = [];

  constructor(seed: ChainedAuditEntry[] = []) {
    this.entries = [...seed];
  }

  get head(): string {
    return this.entries.at(-1)?.hash ?? GENESIS;
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly ChainedAuditEntry[] {
    return this.entries;
  }

  append(input: AuditEntryInput): ChainedAuditEntry {
    const seq = this.entries.length;
    const prevHash = this.head;
    const withSeq = { ...input, seq };

    const entry: ChainedAuditEntry = {
      ...withSeq,
      prevHash,
      hash: hashEntry(prevHash, withSeq),
    };

    this.entries.push(entry);
    return entry;
  }

  verify(): VerifyResult {
    return verifyChain(this.entries);
  }
}

/**
 * Recomputes the whole chain and reports the first divergence.
 *
 * Checks both linkage (does prevHash point at the actual predecessor?) and
 * content (does the recorded hash match a recomputation?). A mutation to a
 * field changes the content hash; a reordering changes the linkage. Both are
 * caught, and the index tells you where to look.
 */
export function verifyChain(entries: readonly ChainedAuditEntry[]): VerifyResult {
  let prevHash = GENESIS;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.seq !== i) {
      return { valid: false, brokenAt: i, reason: `Sequence gap: expected ${i}, found ${entry.seq}` };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: "Chain linkage broken — entry reordered or removed" };
    }

    const expected = hashEntry(prevHash, entry);
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: i, reason: "Entry content was modified after it was written" };
    }

    prevHash = entry.hash;
  }

  return { valid: true, head: prevHash, length: entries.length };
}
