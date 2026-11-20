import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const keys = ["DEEPSONAR_JOB_TOKEN_MAX_REQUESTS", "DEEPSONAR_REPAIR_MAX_TOKENS",
  "DEEPSONAR_HUB_MAX_ROUNDS", "DEEPSONAR_GRAPH_QUERY_MAX_CALLS", "DEEPSONAR_GRAPH_QUERY_MAX_BYTES"];
const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const concurrencyKeys = ["MAX_GLOBAL_JOBS", "MAX_JOBS_PER_PROJECT", "PROVISION_CONCURRENCY"];
const circuitKeys = ["OPENSANDBOX_CREATE_CIRCUIT_FAILURES", "OPENSANDBOX_CREATE_CIRCUIT_WINDOW_SECS",
  "OPENSANDBOX_CREATE_CIRCUIT_COOLDOWN_SECS", "OPENSANDBOX_CREATE_CIRCUIT_MAX_COOLDOWN_SECS"];
function readConfig(values: Record<string, string> = {}, envFile?: string, quotas = false, circuit = false) {
  const dir = mkdtempSync(join(tmpdir(), "usage-limits-"));
  const env = { ...process.env };
  for (const key of [...keys, ...concurrencyKeys, ...circuitKeys, "DEEPSONAR_OFFLINE_PREFLIGHT"]) delete env[key];
  if (envFile !== undefined) {
    for (const match of envFile.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)) delete env[match[1]];
    writeFileSync(join(dir, ".env"), envFile);
  }
  Object.assign(env, values);
  try {
    return spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
      const {config,configInputErrors}=await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
      console.log(JSON.stringify({requests:config.gateway.maxRequests,repair:config.gateway.repairMaxTokens,
        rounds:config.hub.maxRounds,calls:config.graph.queryMaxCalls,bytes:config.graph.queryMaxBytes,errors:[...configInputErrors],
        ...(${quotas} ? {quotas:config.limits} : {}),
        ...(${circuit} ? {circuit:config.runtime.openSandbox.createCircuit} : {})}));
    `], { cwd: dir, env, encoding: "utf8", timeout: 15000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("create circuit defaults and explicit bounded positive settings cannot disable protection", () => {
  const defaults = readConfig({}, undefined, false, true);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout).circuit,
    { failuresToTrip: 2, windowMs: 300_000, cooldownMs: 30_000, maxCooldownMs: 300_000 });
  const configured = readConfig(Object.fromEntries(circuitKeys.map((key, index) => [key, [3, 10, 2, 8][index]!.toString()])),
    undefined, false, true);
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout).circuit,
    { failuresToTrip: 3, windowMs: 10_000, cooldownMs: 2_000, maxCooldownMs: 8_000 });
  const blank = readConfig(Object.fromEntries(circuitKeys.map(key => [key, "  "])), undefined, false, true);
  assert.equal(blank.status, 0, blank.stderr);
  assert.deepEqual(JSON.parse(blank.stdout).circuit, JSON.parse(defaults.stdout).circuit);
  assert.equal(JSON.parse(blank.stdout).errors.some((key: string) => circuitKeys.includes(key)), false);
  const maximum = readConfig(Object.fromEntries(circuitKeys.map((key, index) => [key, [100, 3600, 300, 300][index]!.toString()])),
    undefined, false, true);
  assert.equal(maximum.status, 0, maximum.stderr);
  assert.deepEqual(JSON.parse(maximum.stdout).circuit,
    { failuresToTrip: 100, windowMs: 3_600_000, cooldownMs: 300_000, maxCooldownMs: 300_000 });
  const minimum = readConfig(Object.fromEntries(circuitKeys.map(key => [key, "1"])), undefined, false, true);
  assert.equal(minimum.status, 0, minimum.stderr);
  assert.deepEqual(JSON.parse(minimum.stdout).circuit,
    { failuresToTrip: 1, windowMs: 1000, cooldownMs: 1000, maxCooldownMs: 1000 });
  for (const [index, key] of circuitKeys.entries()) {
    for (const value of ["0", "-1", "1.5", [101, 3601, 301, 301][index]!.toString(), "private-invalid"]) {
      const rejected = readConfig({ [key]: value }, undefined, false, true);
      assert.notEqual(rejected.status, 0, key);
      assert.ok(rejected.stderr.includes(key), rejected.stderr);
      assert.equal(rejected.stderr.includes("private-invalid"), false);
    }
    const offline = readConfig({ [key]: "0", DEEPSONAR_OFFLINE_PREFLIGHT: "1" }, undefined, false, true);
    assert.equal(offline.status, 0, offline.stderr);
    assert.ok(JSON.parse(offline.stdout).errors.includes(key));
    assert.ok(Object.values(JSON.parse(offline.stdout).circuit).every(value => Number(value) > 0));
  }
  const reversed = readConfig({ [circuitKeys[2]!]: "60", [circuitKeys[3]!]: "30" }, undefined, false, true);
  assert.notEqual(reversed.status, 0);
  assert.ok(reversed.stderr.includes(circuitKeys[3]!));
  const offlineReversed = readConfig({ [circuitKeys[2]!]: "60", [circuitKeys[3]!]: "30",
    DEEPSONAR_OFFLINE_PREFLIGHT: "1" }, undefined, false, true);
  assert.equal(offlineReversed.status, 0, offlineReversed.stderr);
  const result = JSON.parse(offlineReversed.stdout);
  assert.ok(result.errors.includes(circuitKeys[3]!));
  assert.ok(result.circuit.maxCooldownMs >= result.circuit.cooldownMs);
});
test("usage limits are unlimited when absent, blank or explicitly zero", () => {
  for (const value of [undefined, "", "  ", "0"]) {
    const run = readConfig(value === undefined ? {} : Object.fromEntries(keys.map(key => [key, value])));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { requests: 0, repair: 0, rounds: 0, calls: 0, bytes: 0, errors: [] });
  }
});
test("explicit positive usage limits and Hub unlimited alias are preserved", () => {
  const run = readConfig(Object.fromEntries(keys.map(key => [key, "17"])));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { requests: 17, repair: 17, rounds: 17, calls: 17, bytes: 17, errors: [] });
  const unlimited = readConfig({ DEEPSONAR_HUB_MAX_ROUNDS: "unlimited" });
  assert.equal(unlimited.status, 0, unlimited.stderr);
  assert.equal(JSON.parse(unlimited.stdout).rounds, 0);
});
test("malformed explicit usage limits reject startup without echoing raw values", () => {
  for (const key of keys) for (const value of ["-1", "1.5", "Infinity", "secret-invalid", "9007199254740992"]) {
    const run = readConfig({ [key]: value });
    assert.notEqual(run.status, 0, key);
    assert.ok(run.stderr.includes(key), run.stderr);
    assert.equal(run.stderr.includes("secret-invalid"), false);
  }
});
test("offline preflight records invalid quota field for sanitized blocking output", () => {
  const run = readConfig({ DEEPSONAR_OFFLINE_PREFLIGHT: "1", DEEPSONAR_JOB_TOKEN_MAX_REQUESTS: "bad" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(run.stdout).errors.includes("DEEPSONAR_JOB_TOKEN_MAX_REQUESTS"));
});


test("complete .env.example loads with unlimited usage defaults and strict overrides", () => {
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  const run = readConfig({}, example, true);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual([result.quotas.maxGlobalJobs, result.quotas.maxJobsPerProject, result.quotas.maxConcurrentProvisioning], [null, null, null]);
  assert.deepEqual([result.requests, result.repair, result.rounds, result.calls, result.bytes], [0, 0, 0, 0, 0]);
  assert.equal(result.errors.some((key: string) => keys.includes(key)), false);
  const configured = readConfig({ DEEPSONAR_HUB_MAX_ROUNDS: "17" }, example);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).rounds, 17, "process env still takes precedence over the example");
  const invalid = readConfig({}, example.replace(/^DEEPSONAR_HUB_MAX_ROUNDS=.*$/m, "DEEPSONAR_HUB_MAX_ROUNDS=invalid-explicit-limit"));
  assert.notEqual(invalid.status, 0);
  assert.ok(invalid.stderr.includes("DEEPSONAR_HUB_MAX_ROUNDS"));
  assert.equal(invalid.stderr.includes("invalid-explicit-limit"), false);
});

test("job concurrency defaults are null, explicit env caps survive and malformed input fails closed", () => {
  for (const value of [undefined, "", "  "]) {
    const run = readConfig(value === undefined ? {} : Object.fromEntries(concurrencyKeys.map(key => [key, value])), undefined, true);
    assert.equal(run.status, 0, run.stderr);
    const limits = JSON.parse(run.stdout).quotas;
    assert.deepEqual([limits.maxGlobalJobs, limits.maxJobsPerProject, limits.maxConcurrentProvisioning], [null, null, null]);
  }
  const finite = readConfig(Object.fromEntries(concurrencyKeys.map(key => [key, "7"])), undefined, true);
  assert.equal(finite.status, 0, finite.stderr);
  const limits = JSON.parse(finite.stdout).quotas;
  assert.deepEqual([limits.maxGlobalJobs, limits.maxJobsPerProject, limits.maxConcurrentProvisioning], [7, 7, 7]);
  for (const key of concurrencyKeys) for (const value of ["0", "-1", "1.5", "1001", "private-invalid"]) {
    const run = readConfig({ [key]: value });
    assert.notEqual(run.status, 0, key);
    assert.ok(run.stderr.includes(key));
    assert.equal(run.stderr.includes("private-invalid"), false);
    const offline = readConfig({ [key]: value, DEEPSONAR_OFFLINE_PREFLIGHT: "1" });
    assert.equal(offline.status, 0, offline.stderr);
    assert.ok(JSON.parse(offline.stdout).errors.includes(key));
  }
});
