/**
 * @ztrade/core — the boundary package.
 *
 * ZERO exchange dependencies by design (§7). If an import of a venue SDK ever
 * appears here, the normalisation boundary has been breached and adding a
 * second exchange stops being an adapter change.
 */
export * from "./clock.ts";
export * from "./events.ts";
export * from "./ids.ts";
export * from "./bus.ts";
export * from "./intent.ts";
