import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { startKillSwitch } from "./killSwitch.ts";

/**
 * SHIP GATE #1 — the kill switch must work when the trading loop is wedged.
 *
 * §11 lists "a kill switch that lives inside the same loop that can hang" as an
 * anti-pattern, so asserting it merely returns 200 on a healthy process proves
 * nothing at all. The test that matters blocks the main thread outright and
 * shows the switch still answers.
 *
 * The request has to come from a second worker: a main thread stuck in a busy
 * loop cannot issue the fetch that would prove it is stuck.
 */
const TOKEN = "kill-switch-test-token-000000";
const PORT = 8891;

/**
 * Fires an HTTP request from its own thread after `delayMs`, and reports when
 * it completed.
 *
 * The delay is the whole point: it lets the caller start wedging the main
 * thread FIRST, so the request is both issued and served during the window in
 * which the main thread cannot run. Firing immediately would race the wedge and
 * prove nothing.
 */
function requestFromOtherThread(
  url: string,
  init: RequestInit,
  delayMs: number,
): Promise<{ status: number; body: string; startedAt: number; completedAt: number }> {
  const source = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      await new Promise((r) => setTimeout(r, workerData.delayMs));
      const startedAt = Date.now();
      try {
        const res = await fetch(workerData.url, workerData.init);
        const body = await res.text();
        parentPort.postMessage({ status: res.status, body, startedAt, completedAt: Date.now() });
      } catch (e) {
        parentPort.postMessage({ status: -1, body: String(e), startedAt, completedAt: Date.now() });
      }
    })();
  `;

  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { url, init, delayMs } });
    worker.on("message", (m) => {
      void worker.terminate();
      resolve(m as { status: number; body: string; startedAt: number; completedAt: number });
    });
    worker.on("error", reject);
  });
}

/** Occupies the main thread completely — no I/O, no timers, nothing yields. */
function wedgeMainThread(durationMs: number): { start: number; end: number } {
  const start = Date.now();
  // eslint-disable-next-line no-empty
  while (Date.now() - start < durationMs) {}
  return { start, end: Date.now() };
}

test("GATE #1: the kill switch answers while the main thread is wedged", async () => {
  const handle = await startKillSwitch({
    port: PORT,
    token: TOKEN,
    restBase: "https://api-testnet.bybit.com",
    apiKey: "test-key",
    apiSecret: "test-secret",
    dryRun: true, // exercise everything except the venue calls
  });

  try {
    // Arm a request to fire 400ms from now, then immediately wedge the main
    // thread for 2s. The request is therefore issued AND served entirely
    // inside a window where this thread cannot execute a single line.
    const pending = requestFromOtherThread(
      `http://127.0.0.1:${PORT}/kill`,
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
      400,
    );

    const block = wedgeMainThread(2_000);
    const result = await pending;

    assert.equal(result.status, 200, `kill switch did not respond: ${result.body}`);

    // The proof.
    assert.ok(
      result.startedAt >= block.start && result.completedAt <= block.end,
      `request ran [${result.startedAt}, ${result.completedAt}], outside the wedge ` +
        `[${block.start}, ${block.end}] — the test did not actually prove independence`,
    );

    const body = JSON.parse(result.body) as { ok: boolean; steps: unknown[] };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.steps), "the switch must report what it attempted");
  } finally {
    await handle.stop();
  }
});

test("GATE #1: the switch refuses an unauthenticated trigger", async () => {
  const handle = await startKillSwitch({
    port: PORT + 1,
    token: TOKEN,
    restBase: "https://api-testnet.bybit.com",
    apiKey: "k",
    apiSecret: "s",
    dryRun: true,
  });

  try {
    const noToken = await fetch(`http://127.0.0.1:${PORT + 1}/kill`, { method: "POST" });
    assert.equal(noToken.status, 401);

    const wrongToken = await fetch(`http://127.0.0.1:${PORT + 1}/kill`, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-token-aaaaaaaaa" },
    });
    assert.equal(wrongToken.status, 401);
  } finally {
    await handle.stop();
  }
});

test("health is reachable without the trigger credential", async () => {
  // A monitor should be able to verify the switch is alive without holding the
  // credential that can fire it.
  const handle = await startKillSwitch({
    port: PORT + 2,
    token: TOKEN,
    restBase: "https://api-testnet.bybit.com",
    apiKey: "k",
    apiSecret: "s",
    dryRun: true,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 2}/health`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { ok: boolean; armed: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.armed, true);
  } finally {
    await handle.stop();
  }
});

test("triggering disarms, and re-arming is explicit", async () => {
  const handle = await startKillSwitch({
    port: PORT + 3,
    token: TOKEN,
    restBase: "https://api-testnet.bybit.com",
    apiKey: "k",
    apiSecret: "s",
    dryRun: true,
  });

  try {
    const base = `http://127.0.0.1:${PORT + 3}`;
    const auth = { Authorization: `Bearer ${TOKEN}` };

    await fetch(`${base}/kill`, { method: "POST", headers: auth });

    const afterKill = (await (await fetch(`${base}/health`)).json()) as {
      armed: boolean;
      lastTrigger: number | null;
    };
    assert.equal(afterKill.armed, false);
    assert.ok(afterKill.lastTrigger !== null, "the trigger time must be recorded");

    // Coming back online is an operator decision, never automatic.
    await fetch(`${base}/rearm`, { method: "POST", headers: auth });
    const afterRearm = (await (await fetch(`${base}/health`)).json()) as { armed: boolean };
    assert.equal(afterRearm.armed, true);
  } finally {
    await handle.stop();
  }
});

test("the switch cancels orders BEFORE flattening", async () => {
  // Flattening while resting orders are still live can have them fill against
  // the flattening trade and re-open the position that was just closed.
  const handle = await startKillSwitch({
    port: PORT + 4,
    token: TOKEN,
    restBase: "https://api-testnet.bybit.com",
    apiKey: "k",
    apiSecret: "s",
    dryRun: true,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 4}/kill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { steps: Array<{ step: string }> };

    // Bybit has no single "close everything" call, so flattening is
    // list-then-reduce-only-per-symbol. Cancel must still come first.
    assert.deepEqual(
      body.steps.map((s) => s.step),
      ["cancelAll", "listPositions", "closeAll"],
    );
  } finally {
    await handle.stop();
  }
});
