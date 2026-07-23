#!/usr/bin/env node
/**
 * Ship gate #5 — prove secrets never reach a log sink.
 *
 * Boots the real server with sentinel credentials, exercises the endpoints
 * most likely to echo config back, and fails if a sentinel appears anywhere in
 * stdout or stderr.
 *
 * This is deliberately an END-TO-END scan rather than a unit test of the
 * redactor. The redactor is already unit-tested; what this catches is the
 * thing unit tests structurally cannot — a `console.log(config)` added later,
 * a dependency that dumps its own request headers, an unhandled rejection that
 * stringifies the whole client. Those are how keys actually leak.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENTINELS = {
  BYBIT_API_KEY: "SENTINELKEYaaaaaaaaaaaaaaaaaaaa1111",
  BYBIT_API_SECRET: "SENTINELSECRETbbbbbbbbbbbbbbbbbbbb2222",
  TELEGRAM_BOT_TOKEN: "999999999:SENTINELTELEGRAMccccccccccccccccccc",
  ZTRADE_API_TOKEN: "SENTINELAPITOKENdddddddddddddddddddd",
};

const dataDir = mkdtempSync(join(tmpdir(), "ztrade-logscan-"));
const PORT = 8799;

const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: new URL("../apps/server", import.meta.url).pathname,
  env: {
    ...process.env,
    ...SENTINELS,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATABASE_PATH: join(dataDir, "scan.db"),
    ZTRADE_NETWORK: "TESTNET",
    ZTRADE_TRADING_ENABLED: "false",
    ZTRADE_AUTH_ENABLED: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let captured = "";
child.stdout.on("data", (c) => (captured += c.toString()));
child.stderr.on("data", (c) => (captured += c.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(code) {
  child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}

await sleep(14_000);

const base = `http://127.0.0.1:${PORT}`;
const auth = { Authorization: `Bearer ${SENTINELS.ZTRADE_API_TOKEN}` };

// Hit the surfaces most likely to echo configuration or credentials back.
const probes = [
  fetch(`${base}/api/health`).catch(() => null),
  fetch(`${base}/api/settings`, { headers: auth }).catch(() => null),
  fetch(`${base}/api/status`, { headers: auth }).catch(() => null),
  // Unauthenticated call: the 401 path must not echo the expected token.
  fetch(`${base}/api/settings`).catch(() => null),
  // Malformed body, to exercise the error handler.
  fetch(`${base}/api/strategies`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{not json",
  }).catch(() => null),
  // Credential test: forces the code path that actually uses the key.
  fetch(`${base}/api/settings/exchange/test`, { method: "POST", headers: auth }).catch(() => null),
];

const responses = await Promise.all(probes);
const bodies = await Promise.all(
  responses.map((r) => (r ? r.text().catch(() => "") : Promise.resolve(""))),
);

await sleep(3_000);

// Scan BOTH the process logs and every response body: a key echoed to an HTTP
// client is exactly as leaked as one written to stdout.
const haystack = `${captured}\n${bodies.join("\n")}`;

let failed = false;
for (const [name, value] of Object.entries(SENTINELS)) {
  if (haystack.includes(value)) {
    console.error(`LEAK: ${name} appeared in logs or an HTTP response`);
    for (const line of haystack.split("\n")) {
      if (line.includes(value)) console.error(`  → ${line.slice(0, 200)}`);
    }
    failed = true;
  }
}

if (failed) {
  console.error("\nGATE #5 FAILED — a secret reached a log sink or a client.");
  finish(1);
}

console.log(
  `GATE #5 passed — none of the ${Object.keys(SENTINELS).length} sentinels ` +
    `appeared in ${haystack.length} bytes of log and response output.`,
);
finish(0);
