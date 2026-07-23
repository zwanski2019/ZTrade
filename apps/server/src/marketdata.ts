import type { MarketEvent, OrderBookSnapshot } from "@ztrade/core";
import { BybitIngestion, createWebSocket } from "@ztrade/ingestion";
import { FeatureStore, type SymbolFeatures } from "@ztrade/features";
import { config } from "./config.js";
import { logger } from "./bus.js";

/**
 * Phase 1 read-only market data service.
 *
 * Runs the new ingestion spine alongside the legacy engine and emits NO orders
 * — it exists to prove data integrity against the live venue and to feed the
 * dashboard's live book. The legacy engine is untouched and still owns trading.
 *
 * The two do not share state deliberately: this is the migration seam. When
 * the engine moves onto the spine it consumes these normalised events instead
 * of its own REST polling, and this service stops being read-only.
 */
const BYBIT_WS = {
  MAINNET: "wss://stream.bybit.com/v5/public/linear",
  TESTNET: "wss://stream-testnet.bybit.com/v5/public/linear",
} as const;

export interface BookView {
  symbol: string;
  status: string;
  /** Null while the book is stale — the UI must render that, not a price. */
  book: OrderBookSnapshot | null;
  reason: string | null;
  updateId: number;
  stats: { snapshots: number; deltas: number; gaps: number; crossed: number };
}

export interface MarketDataSnapshot {
  running: boolean;
  network: string;
  symbols: string[];
  books: BookView[];
  features: SymbolFeatures[];
  ingestion: ReturnType<BybitIngestion["snapshot"]> | null;
}

class MarketDataService {
  private ingestion: BybitIngestion | null = null;
  private readonly features = new FeatureStore();
  private symbols: string[] = [];

  get running(): boolean {
    return this.ingestion !== null;
  }

  start(symbols: string[]): void {
    if (this.ingestion) this.stop();
    if (symbols.length === 0) return;

    this.symbols = symbols;
    this.ingestion = new BybitIngestion({
      url: config.isTestnet ? BYBIT_WS.TESTNET : BYBIT_WS.MAINNET,
      symbols,
      intervals: ["1"],
      socketFactory: createWebSocket,
      onEvent: (event: MarketEvent) => this.features.onEvent(event),
      onLog: (level, message) => {
        if (level === "error") logger.error(`[md] ${message}`);
        else if (level === "warn") logger.warn(`[md] ${message}`);
        else logger.info(`[md] ${message}`);
      },
    });

    this.ingestion.start();
    logger.info(`Market data ingestion started for ${symbols.join(", ")}`);
  }

  stop(): void {
    this.ingestion?.stop();
    this.ingestion = null;
  }

  /**
   * Propagates book staleness into the feature store.
   *
   * Called on every read rather than on a timer: a feature consumer must never
   * see microstructure values derived from a book that has gone stale since the
   * last update.
   */
  private syncStaleness(): void {
    if (!this.ingestion) return;
    for (const symbol of this.symbols) {
      const book = this.ingestion.book(symbol);
      if (book && !book.isHealthy) this.features.markBookStale(symbol);
    }
  }

  snapshot(depth = 15): MarketDataSnapshot {
    this.syncStaleness();

    const books: BookView[] = [];
    for (const symbol of this.symbols) {
      const book = this.ingestion?.book(symbol);
      if (!book) continue;

      const view = book.snapshot();
      books.push({
        symbol,
        status: book.status,
        book: view
          ? { bids: view.bids.slice(0, depth), asks: view.asks.slice(0, depth) }
          : null,
        reason: book.reason,
        updateId: book.updateId,
        stats: {
          snapshots: book.stats.snapshots,
          deltas: book.stats.deltas,
          gaps: book.stats.gaps,
          crossed: book.stats.crossed,
        },
      });
    }

    return {
      running: this.running,
      network: config.network,
      symbols: this.symbols,
      books,
      features: this.symbols
        .map((s) => this.features.get(s))
        .filter((f): f is SymbolFeatures => f !== null),
      ingestion: this.ingestion?.snapshot() ?? null,
    };
  }
}

export const marketData = new MarketDataService();
