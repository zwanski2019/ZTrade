import test from "node:test";
import assert from "node:assert/strict";
import { shouldTrip } from "./circuitBreaker.ts";
import { defaultCircuitBreaker, type CircuitBreakerConfig } from "@ztrade/shared";

const cfg: CircuitBreakerConfig = { ...defaultCircuitBreaker };

const quiet = { consecutiveLosses: 0, realisedPnlToday: 0, dayStartEquity: 10_000 };

test("does not trip on a clean slate", () => {
  assert.equal(shouldTrip(cfg, quiet), null);
});

test("does not trip while under both limits", () => {
  assert.equal(
    shouldTrip(cfg, {
      consecutiveLosses: 3, // limit is 4
      realisedPnlToday: -400, // 4% of 10k, limit is 5%
      dayStartEquity: 10_000,
    }),
    null,
  );
});

test("trips on the configured consecutive-loss count", () => {
  const reason = shouldTrip(cfg, { ...quiet, consecutiveLosses: 4 });
  assert.match(String(reason), /consecutive losing trades/);
});

test("trips once the daily loss percentage is reached", () => {
  const reason = shouldTrip(cfg, {
    consecutiveLosses: 0,
    realisedPnlToday: -500, // exactly 5% of 10k
    dayStartEquity: 10_000,
  });
  assert.match(String(reason), /Daily loss/);
});

test("a profitable day never trips the loss limit", () => {
  assert.equal(
    shouldTrip(cfg, {
      consecutiveLosses: 0,
      realisedPnlToday: 5_000,
      dayStartEquity: 10_000,
    }),
    null,
  );
});

test("disabled breaker never trips", () => {
  const off: CircuitBreakerConfig = { ...cfg, enabled: false };
  assert.equal(
    shouldTrip(off, {
      consecutiveLosses: 99,
      realisedPnlToday: -9_999,
      dayStartEquity: 10_000,
    }),
    null,
  );
});

test("a zero limit disables that individual check", () => {
  const noStreakLimit: CircuitBreakerConfig = { ...cfg, maxConsecutiveLosses: 0 };
  assert.equal(shouldTrip(noStreakLimit, { ...quiet, consecutiveLosses: 50 }), null);

  const noLossLimit: CircuitBreakerConfig = { ...cfg, maxDailyLossPct: 0 };
  assert.equal(
    shouldTrip(noLossLimit, {
      consecutiveLosses: 0,
      realisedPnlToday: -9_999,
      dayStartEquity: 10_000,
    }),
    null,
  );
});

test("unknown starting equity cannot trip the percentage check", () => {
  // Dividing by a zero denominator would otherwise produce Infinity and halt
  // trading permanently on the first loss.
  assert.equal(
    shouldTrip(cfg, {
      consecutiveLosses: 0,
      realisedPnlToday: -100,
      dayStartEquity: 0,
    }),
    null,
  );
});

test("the streak check takes precedence when both limits are breached", () => {
  const reason = shouldTrip(cfg, {
    consecutiveLosses: 10,
    realisedPnlToday: -5_000,
    dayStartEquity: 10_000,
  });
  assert.match(String(reason), /consecutive losing trades/);
});
