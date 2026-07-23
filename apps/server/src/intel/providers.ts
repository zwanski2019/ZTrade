import { logger } from "../bus.js";

/**
 * Clients for free, key-free public market data.
 *
 * Rules every provider here follows:
 *   - No API key, no account, no paid tier. If it needs a key it does not
 *     belong in this file.
 *   - Short timeout and a cache. These are courtesy-rate-limited public
 *     endpoints; hammering them gets the IP blocked, and the data barely
 *     changes between calls anyway.
 *   - Failure returns null, never throws. Intelligence is an ENHANCEMENT to
 *     the engine — if a sentiment endpoint is down the bot must keep trading
 *     on price alone, not stop.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const value = await fetcher();
  if (value === null) {
    // Serve stale data rather than nothing when a provider is briefly down.
    return hit ? (hit.value as T) : null;
  }

  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function getJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "ztrade/0.3" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`Intel provider ${new URL(url).host} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn(`Intel provider ${new URL(url).host} unreachable: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Crypto Fear & Greed Index — alternative.me
// ---------------------------------------------------------------------------

export interface FearGreed {
  /** 0 (extreme fear) .. 100 (extreme greed). */
  value: number;
  classification: string;
  at: number;
}

/**
 * Updates once a day, so a 30 minute cache is generous.
 *
 * Treat this as a weak, slow-moving contrarian input. It is a composite of
 * volatility, momentum, social media and search trends — useful at the
 * extremes, close to noise in the middle.
 */
export async function fetchFearGreed(): Promise<FearGreed | null> {
  return cached("fng", 30 * 60_000, async () => {
    const data = await getJson<{
      data?: Array<{ value?: string; value_classification?: string; timestamp?: string }>;
    }>("https://api.alternative.me/fng/?limit=1");

    const entry = data?.data?.[0];
    if (!entry?.value) return null;

    const value = Number(entry.value);
    if (!Number.isFinite(value)) return null;

    return {
      value,
      classification: entry.value_classification ?? "Unknown",
      at: Number(entry.timestamp ?? 0) * 1000 || Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// Binance USD-M futures — funding & open interest (public, no key)
// ---------------------------------------------------------------------------

export interface FundingSnapshot {
  symbol: string;
  /** Per-interval funding rate as a fraction, e.g. 0.0001 === 0.01%. */
  fundingRate: number;
  markPrice: number;
  indexPrice: number;
  nextFundingTime: number;
}

export async function fetchBinanceFunding(symbol: string): Promise<FundingSnapshot | null> {
  return cached(`binance-funding:${symbol}`, 60_000, async () => {
    const data = await getJson<{
      symbol?: string;
      markPrice?: string;
      indexPrice?: string;
      lastFundingRate?: string;
      nextFundingTime?: number;
    }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);

    if (!data?.symbol) return null;

    const rate = Number(data.lastFundingRate);
    if (!Number.isFinite(rate)) return null;

    return {
      symbol: data.symbol,
      fundingRate: rate,
      markPrice: Number(data.markPrice) || 0,
      indexPrice: Number(data.indexPrice) || 0,
      nextFundingTime: Number(data.nextFundingTime) || 0,
    };
  });
}

export interface OpenInterestSnapshot {
  symbol: string;
  openInterest: number;
  at: number;
}

export async function fetchBinanceOpenInterest(
  symbol: string,
): Promise<OpenInterestSnapshot | null> {
  return cached(`binance-oi:${symbol}`, 60_000, async () => {
    const data = await getJson<{ symbol?: string; openInterest?: string; time?: number }>(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
    );

    if (!data?.symbol) return null;
    const oi = Number(data.openInterest);
    if (!Number.isFinite(oi)) return null;

    return { symbol: data.symbol, openInterest: oi, at: data.time ?? Date.now() };
  });
}

/** Historical open interest, used to measure whether OI is rising or falling. */
export async function fetchBinanceOpenInterestHistory(
  symbol: string,
  period = "5m",
  limit = 12,
): Promise<number[] | null> {
  return cached(`binance-oi-hist:${symbol}:${period}`, 5 * 60_000, async () => {
    const data = await getJson<Array<{ sumOpenInterest?: string }>>(
      `https://fapi.binance.com/futures/data/openInterestHist` +
        `?symbol=${symbol}&period=${period}&limit=${limit}`,
    );
    if (!Array.isArray(data) || data.length === 0) return null;

    const series = data
      .map((d) => Number(d.sumOpenInterest))
      .filter((n) => Number.isFinite(n));
    return series.length > 0 ? series : null;
  });
}

/**
 * Long/short account ratio across Binance traders.
 * A crowded book is a contrarian input, not a directional one.
 */
export async function fetchLongShortRatio(
  symbol: string,
  period = "5m",
): Promise<number | null> {
  return cached(`binance-lsr:${symbol}:${period}`, 5 * 60_000, async () => {
    const data = await getJson<Array<{ longShortRatio?: string }>>(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio` +
        `?symbol=${symbol}&period=${period}&limit=1`,
    );
    const ratio = Number(data?.[0]?.longShortRatio);
    return Number.isFinite(ratio) ? ratio : null;
  });
}

// ---------------------------------------------------------------------------
// Cross-exchange spot consensus — Coinbase & Kraken (public, no key)
// ---------------------------------------------------------------------------

export interface VenuePrice {
  venue: string;
  price: number;
}

async function fetchCoinbase(base: string): Promise<VenuePrice | null> {
  const data = await getJson<{ price?: string }>(
    `https://api.exchange.coinbase.com/products/${base}-USD/ticker`,
  );
  const price = Number(data?.price);
  return Number.isFinite(price) && price > 0 ? { venue: "coinbase", price } : null;
}

async function fetchKraken(pair: string): Promise<VenuePrice | null> {
  const data = await getJson<{ result?: Record<string, { c?: string[] }> }>(
    `https://api.kraken.com/0/public/Ticker?pair=${pair}`,
  );
  const first = data?.result ? Object.values(data.result)[0] : undefined;
  const price = Number(first?.c?.[0]);
  return Number.isFinite(price) && price > 0 ? { venue: "kraken", price } : null;
}

/** Kraken uses legacy asset codes for the majors. */
const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  XRP: "XRPUSD",
  ADA: "ADAUSD",
  DOT: "DOTUSD",
  LINK: "LINKUSD",
  AVAX: "AVAXUSD",
};

/**
 * Independent price references for a base asset.
 *
 * The point is not precision — it is having a second opinion. If our exchange
 * disagrees with every other venue, the feed is stale or the book is broken,
 * and that is exactly when a bot should stop trading rather than act on it.
 */
export async function fetchConsensusPrices(base: string): Promise<VenuePrice[]> {
  return (
    (await cached(`consensus:${base}`, 30_000, async () => {
      const krakenPair = KRAKEN_PAIRS[base];

      const results = await Promise.all([
        fetchCoinbase(base),
        krakenPair ? fetchKraken(krakenPair) : Promise.resolve(null),
      ]);

      const prices = results.filter((r): r is VenuePrice => r !== null);
      return prices.length > 0 ? prices : null;
    })) ?? []
  );
}

// ---------------------------------------------------------------------------
// CoinGecko — global market structure (public, no key)
// ---------------------------------------------------------------------------

export interface GlobalMarket {
  btcDominance: number;
  totalMarketCapUsd: number;
  /** 24h change in total market cap, as a percentage. */
  marketCapChangePct24h: number;
}

export async function fetchGlobalMarket(): Promise<GlobalMarket | null> {
  return cached("global", 10 * 60_000, async () => {
    const data = await getJson<{
      data?: {
        market_cap_percentage?: Record<string, number>;
        total_market_cap?: Record<string, number>;
        market_cap_change_percentage_24h_usd?: number;
      };
    }>("https://api.coingecko.com/api/v3/global");

    const global = data?.data;
    if (!global) return null;

    const dominance = global.market_cap_percentage?.btc;
    if (!Number.isFinite(dominance)) return null;

    return {
      btcDominance: dominance as number,
      totalMarketCapUsd: global.total_market_cap?.usd ?? 0,
      marketCapChangePct24h: global.market_cap_change_percentage_24h_usd ?? 0,
    };
  });
}

/** Test seam: drop cached values so a test can control provider responses. */
export function __clearIntelCache(): void {
  cache.clear();
}
