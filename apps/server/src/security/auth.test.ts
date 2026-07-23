import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env must be set before the module graph loads `config`.
const dir = mkdtempSync(join(tmpdir(), "ztrade-auth-test-"));
process.env.DATABASE_PATH = join(dir, "test.db");
process.env.CORS_ORIGIN = "http://localhost:5173,https://ztrade.example.com";

const { isAllowedOrigin } = await import("./auth.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a configured origin is allowed", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("https://ztrade.example.com"), true);
});

test("loopback aliases of a configured origin are allowed", () => {
  // The operator configured localhost but typed 127.0.0.1 into the address bar.
  // Same machine, same port — rejecting it is a confusing dead end.
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isAllowedOrigin("http://[::1]:5173"), true);
});

test("a different port is still rejected", () => {
  assert.equal(isAllowedOrigin("http://localhost:9999"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999"), false);
});

test("a different scheme is rejected", () => {
  assert.equal(isAllowedOrigin("https://localhost:5173"), false);
});

test("an unrelated site is rejected", () => {
  assert.equal(isAllowedOrigin("https://evil.example.com"), false);
  assert.equal(isAllowedOrigin("http://ztrade.example.com"), false);
});

test("loopback collapsing does not let a real host impersonate localhost", () => {
  // A public host that merely mentions loopback in its name must not match.
  assert.equal(isAllowedOrigin("http://localhost.evil.com:5173"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com:5173"), false);
});

test("a missing Origin is allowed for non-browser clients", () => {
  // curl and the test suite send no Origin; browsers always do.
  assert.equal(isAllowedOrigin(undefined), true);
});

test("a malformed Origin is rejected rather than throwing", () => {
  assert.equal(isAllowedOrigin("not a url"), false);
});
