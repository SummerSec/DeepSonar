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
function readConfig(values: Record<string, string> = {}, envFile?: string, quotas = false) {
  const dir = mkdtempSync(join(tmpdir(), "usage-limits-"));
  const env = { ...process.env };
  for (const key of [...keys, ...concurrencyKeys, "DEEPSONAR_OFFLINE_PREFLIGHT"]) delete env[key];
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
        ...(${quotas} ? {quotas:config.limits} : {})}));
    `], { cwd: dir, env, encoding: "utf8", timeout: 15000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
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
