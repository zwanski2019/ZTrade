import test from "node:test";
import assert from "node:assert/strict";
import { overallSeverity, renderDoctorReport, runDoctor } from "./doctor.ts";
import type { KeyPermissions } from "./keyScope.ts";

const safeKey: KeyPermissions = {
  canTrade: true, canWithdraw: false, canTransfer: false, canRead: true,
  ipWhitelist: ["1.2.3.4"], raw: [],
};

test("a clean setup reports all ok", () => {
  const checks = runDoctor({
    keyPermissions: safeKey,
    bindAddress: "127.0.0.1:8788",
    authEnabled: true,
    clockSkewMs: 50,
    dependencyCount: 40,
  });
  assert.equal(overallSeverity(checks), "ok");
});

test("a withdrawal key fails the whole report", () => {
  const checks = runDoctor({ keyPermissions: { ...safeKey, canWithdraw: true } });
  assert.equal(overallSeverity(checks), "fail");
  assert.ok(checks.some((c) => c.name === "api-key-scope" && c.severity === "fail"));
});

test("a public bind with no auth is a fail", () => {
  const checks = runDoctor({ bindAddress: "0.0.0.0:8788", authEnabled: false });
  assert.equal(overallSeverity(checks), "fail");
  assert.ok(checks.some((c) => c.name === "network-exposure" && c.severity === "fail"));
});

test("a public bind WITH auth is only a warning", () => {
  const checks = runDoctor({ bindAddress: "0.0.0.0:8788", authEnabled: true });
  const net = checks.find((c) => c.name === "network-exposure")!;
  assert.equal(net.severity, "warn");
});

test("disabled auth is always a fail", () => {
  const checks = runDoctor({ authEnabled: false, bindAddress: "127.0.0.1:8788" });
  assert.ok(checks.some((c) => c.name === "control-plane-auth" && c.severity === "fail"));
});

test("large clock skew fails, small skew warns", () => {
  assert.equal(overallSeverity(runDoctor({ clockSkewMs: 6000 })), "fail");
  assert.equal(overallSeverity(runDoctor({ clockSkewMs: 2000 })), "warn");
  assert.equal(overallSeverity(runDoctor({ clockSkewMs: 100 })), "ok");
});

test("plaintext secret env vars produce a warning", () => {
  const checks = runDoctor({ plaintextSecretEnvVars: ["BYBIT_API_SECRET"] });
  assert.ok(checks.some((c) => c.name === "plaintext-secrets" && c.severity === "warn"));
});

test("dependency surface over budget warns", () => {
  assert.ok(runDoctor({ dependencyCount: 900 }).some((c) => c.severity === "warn"));
  assert.ok(runDoctor({ dependencyCount: 40 }).every((c) => c.name !== "dependency-surface" || c.severity === "ok"));
});

test("the rendered report leads with the overall verdict", () => {
  const failReport = renderDoctorReport(runDoctor({ keyPermissions: { ...safeKey, canWithdraw: true } }));
  assert.match(failReport, /ISSUES FOUND/);
  const okReport = renderDoctorReport(runDoctor({ keyPermissions: safeKey, authEnabled: true, bindAddress: "127.0.0.1:1" }));
  assert.match(okReport, /all clear/);
});

test("no credentials is fine — public-data mode", () => {
  const checks = runDoctor({ keyPermissions: null, bindAddress: "127.0.0.1:8788", authEnabled: true });
  assert.equal(overallSeverity(checks), "ok");
});
