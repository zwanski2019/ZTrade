import type { InstrumentInfo } from "@ztrade/shared";
import { logger } from "../bus.js";

/**
 * Per-symbol trading rules, cached in memory.
 *
 * These are NOT uniform across instruments — BTCUSDT trades in steps of 0.001
 * while SOLUSDT uses 0.1 and some alts use whole units. Assuming a single step
 * size produces quantities the exchange rejects outright, so the engine must
 * read the real values before sizing an order.
 *
 * The fallback below is deliberately conservative and only used when the
 * instruments endpoint is unreachable; it is logged loudly because trading on
 * guessed step sizes is a good way to have every order bounce.
 */
const FALLBACK: Omit<InstrumentInfo, "symbol"> = {
  tickSize: 0.01,
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1_000_000,
  minNotional: 5,
  maxLeverage: 10,
};

const cache = new Map<string, InstrumentInfo>();
let lastRefresh = 0;
const TTL_MS = 6 * 60 * 60 * 1000;

export function cachedInstrument(symbol: string): InstrumentInfo | null {
  return cache.get(symbol) ?? null;
}

export function instrumentOrFallback(symbol: string): InstrumentInfo {
  const hit = cache.get(symbol);
  if (hit) return hit;
  return { symbol, ...FALLBACK };
}

export function isStale(): boolean {
  return Date.now() - lastRefresh > TTL_MS;
}

interface RawInstrument {
  symbol: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: {
    qtyStep?: string;
    minOrderQty?: string;
    maxOrderQty?: string;
    minNotionalValue?: string;
  };
  leverageFilter?: { maxLeverage?: string };
}

/**
 * Loads instrument rules for the given symbols. Public endpoint — no
 * credentials needed, which is why paper mode can size orders correctly too.
 */
export async function loadInstruments(
  fetchInstruments: () => Promise<RawInstrument[]>,
  symbols: string[],
): Promise<void> {
  let raw: RawInstrument[];
  try {
    raw = await fetchInstruments();
  } catch (err) {
    logger.error(
      `Could not load instrument rules (${(err as Error).message}). ` +
        "Falling back to conservative defaults — orders may be rejected.",
    );
    return;
  }

  const wanted = new Set(symbols);
  let loaded = 0;

  for (const item of raw) {
    if (wanted.size > 0 && !wanted.has(item.symbol)) continue;

    const info: InstrumentInfo = {
      symbol: item.symbol,
      tickSize: numberOr(item.priceFilter?.tickSize, FALLBACK.tickSize),
      qtyStep: numberOr(item.lotSizeFilter?.qtyStep, FALLBACK.qtyStep),
      minOrderQty: numberOr(item.lotSizeFilter?.minOrderQty, FALLBACK.minOrderQty),
      maxOrderQty: numberOr(item.lotSizeFilter?.maxOrderQty, FALLBACK.maxOrderQty),
      minNotional: numberOr(
        item.lotSizeFilter?.minNotionalValue,
        FALLBACK.minNotional,
      ),
      maxLeverage: numberOr(item.leverageFilter?.maxLeverage, FALLBACK.maxLeverage),
    };

    cache.set(info.symbol, info);
    loaded += 1;
  }

  lastRefresh = Date.now();

  const missing = symbols.filter((s) => !cache.has(s));
  if (missing.length > 0) {
    logger.warn(
      `No instrument rules found for: ${missing.join(", ")}. ` +
        "Check the symbols are valid linear perpetuals.",
    );
  }
  if (loaded > 0) logger.info(`Loaded trading rules for ${loaded} instrument(s)`);
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Test seam — lets unit tests populate the cache without a network call. */
export function __setInstrumentForTest(info: InstrumentInfo): void {
  cache.set(info.symbol, info);
}
