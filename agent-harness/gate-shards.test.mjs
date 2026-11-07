import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GATE_SHARDS,
  GATE_SHARD_RESULT_VARS,
  GATE_SUITE_INVENTORY,
  verifyGateShardResults,
} from "./gate-shards.mjs";

// 本机没有 yaml 依赖：按 `  <jobname>:` 行做文本切片，零依赖读取 ci.yml。
const root = new URL("../", import.meta.url);
const source = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const lines = source.split("\n");

const jobHeaderRe = /^  [A-Za-z0-9_-]+:\s*(#.*)?$/;

function jobSlice(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} 必须存在`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (jobHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const SUITE_RE = /pnpm ci:[A-Za-z0-9:_-]+/g;

function suitesIn(text) {
  return [...text.matchAll(SUITE_RE)].map((match) => match[0]);
}

const READY_FULL_IF = "    if: always() && !cancelled() && needs.changes.outputs.mode == 'ready-full'";

test("5 个分片 job 都存在，needs/if/timeout 正确，services 归属符合约定", () => {
  for (const shard of GATE_SHARDS) {
    const slice = jobSlice(shard);
    assert.ok(slice.includes("    needs: changes"), `${shard}: needs: changes`);
    assert.ok(slice.includes(READY_FULL_IF), `${shard}: ready-full if`);
    assert.ok(slice.includes("    timeout-minutes: 40"), `${shard}: timeout 40`);
    const hasServices = /^ {4}services:[ \t]*$/m.test(slice);
    const hasPostgres = /^ {6}postgres:[ \t]*$/m.test(slice);
    if (["gate-contract", "gate-runtime"].includes(shard)) {
      assert.ok(!hasServices, `${shard} 不声明 services`);
      assert.ok(!hasPostgres, `${shard} 不声明 services.postgres`);
    } else {
      assert.ok(hasServices, `${shard} 必须声明 services`);
      assert.ok(hasPostgres, `${shard} 必须声明 services.postgres`);
    }
  }
});

test("覆盖率：5 个分片的 pnpm ci:* 恰好等于原 gate 套件清单（每个恰好一次）", () => {
  const shardText = GATE_SHARDS.map((shard) => jobSlice(shard)).join("\n");
  const extracted = suitesIn(shardText);
  const expected = GATE_SUITE_INVENTORY.map((entry) => entry.suite);
  assert.equal(extracted.length, expected.length, "套件数量一致");
  assert.deepEqual(extracted.slice().sort(), expected.slice().sort(), "每个原套件恰好覆盖一次，不多不少");
  // setup 前缀各片重复，但不含 pnpm ci:*，不得计入套件集合。
  assert.ok(shardText.includes("pnpm install --frozen-lockfile"));
  assert.ok(shardText.includes("pnpm -r build"));
  assert.ok(!extracted.some((s) => s === "pnpm install --frozen-lockfile" || s === "pnpm -r build"));
  // 逐片归属：每个分片里的套件必须属于该分片。
  for (const shard of GATE_SHARDS) {
    const owned = new Set(GATE_SUITE_INVENTORY.filter((entry) => entry.shard === shard).map((entry) => entry.suite));
    for (const suite of suitesIn(jobSlice(shard))) {
      assert.ok(owned.has(suite), `${suite} 不应出现在 ${shard}`);
    }
  }
});

test("ci-summary 的 needs/env/脚本用 5 个分片替换 gate", () => {
  const slice = jobSlice("ci-summary");
  const needsLine = slice.split("\n").find((line) => /^\s+needs:\s*\[/.test(line));
  assert.ok(needsLine, "ci-summary needs 行存在");
  const needs = needsLine.match(/\[([^\]]*)\]/)[1].split(",").map((item) => item.trim());
  for (const shard of GATE_SHARDS) {
    assert.ok(needs.includes(shard), `needs 含 ${shard}`);
  }
  assert.ok(!needs.includes("gate"), "needs 不含旧的 gate");

  for (const shard of GATE_SHARDS) {
    const varName = GATE_SHARD_RESULT_VARS[shard];
    const envLine = varName + ": ${{ needs." + shard + ".result }}";
    assert.ok(slice.includes(envLine), `env 含 ${varName}`);
    const heavyLine = "check_heavy " + shard + ' "$' + varName + '"';
    assert.ok(slice.includes(heavyLine), `脚本逐个 check_heavy ${shard}`);
  }
  assert.ok(!/^[ \t]+GATE:[ \t]/m.test(slice), "env 不含旧的 GATE:");
  assert.ok(!slice.includes('check_heavy gate "$GATE"'), "脚本不含旧的 check_heavy gate");
  assert.ok(
    slice.includes('EXPECTED_GATE_SHARDS="gate-contract gate-runtime gate-db-core gate-db-domain gate-e2e"'),
    "显式 expected-matrix 校验存在",
  );
});

test("verifyGateShardResults 正例：非 docs-only 全 success、docs-only 全 skipped", () => {
  const success = Object.fromEntries(GATE_SHARDS.map((shard) => [shard, "success"]));
  const skipped = Object.fromEntries(GATE_SHARDS.map((shard) => [shard, "skipped"]));
  assert.deepEqual(verifyGateShardResults({ results: success, docsOnly: false }), { ok: true, shards: GATE_SHARDS });
  assert.deepEqual(verifyGateShardResults({ results: skipped, docsOnly: true }), { ok: true, shards: GATE_SHARDS });
  assert.deepEqual(verifyGateShardResults({ results: success }), { ok: true, shards: GATE_SHARDS });
});

test("#992 controlled probe is manual-only, first-attempt-only and cannot bypass actual runtime suites", () => {
  assert.match(source, /isolation_probe:\s*\n\s*description:[^\n]+\n\s*type: boolean\n\s*default: false/u);
  const runtime = jobSlice("gate-runtime");
  assert.match(runtime, /if: github\.event_name == 'workflow_dispatch' && inputs\.isolation_probe && github\.run_attempt == 1/u);
  assert.ok(runtime.indexOf("CI_ISOLATION_PROBE") > runtime.indexOf("pnpm ci:unit:runtime-sandbox"));
  assert.ok(runtime.includes("          exit 1"));
  assert.ok(!runtime.includes("continue-on-error"));
  for (const shard of GATE_SHARDS.filter((name) => name !== "gate-runtime")) {
    assert.ok(!jobSlice(shard).includes("isolation_probe"), `${shard} remains unaffected`);
  }
});

test("#992 every independent failed shard blocks summary; rerunning that shard restores only its result", () => {
  const success = Object.fromEntries(GATE_SHARDS.map((shard) => [shard, "success"]));
  for (const shard of GATE_SHARDS) {
    for (const result of ["failure", "cancelled", "timed_out", "skipped", "neutral", ""]) {
      const attempt = { ...success, [shard]: result };
      assert.throws(() => verifyGateShardResults({ results: attempt, docsOnly: false }), `${shard}: ${result}`);
      const repaired = { ...attempt, [shard]: "success" };
      assert.equal(verifyGateShardResults({ results: repaired, docsOnly: false }).ok, true);
      assert.deepEqual(Object.entries(attempt).filter(([name]) => name !== shard),
        Object.entries(repaired).filter(([name]) => name !== shard));
    }
    const missing = { ...success };
    delete missing[shard];
    assert.throws(() => verifyGateShardResults({ results: missing, docsOnly: false }), shard);
  }
});

test("verifyGateShardResults fail-closed：缺片/未知分片/空值/异常结果", () => {
  const success = Object.fromEntries(GATE_SHARDS.map((shard) => [shard, "success"]));
  const skipped = Object.fromEntries(GATE_SHARDS.map((shard) => [shard, "skipped"]));

  const missing = { ...success };
  delete missing["gate-e2e"];
  assert.throws(() => verifyGateShardResults({ results: missing, docsOnly: false }), "缺片");

  for (const bad of ["failure", "cancelled", "timed_out"]) {
    assert.throws(
      () => verifyGateShardResults({ results: { ...success, "gate-db-core": bad }, docsOnly: false }),
      bad,
    );
  }
  assert.throws(
    () => verifyGateShardResults({ results: { ...success, "gate-contract": "skipped" }, docsOnly: false }),
    "非 docs-only 的 skipped",
  );
  assert.throws(
    () => verifyGateShardResults({ results: { ...skipped, "gate-e2e": "success" }, docsOnly: true }),
    "docs-only 的 success",
  );
  assert.throws(
    () => verifyGateShardResults({ results: { ...success, "gate-unknown": "success" }, docsOnly: false }),
    "未知分片",
  );
  assert.throws(
    () => verifyGateShardResults({ results: { ...success, "gate-contract": "" }, docsOnly: false }),
    "空值",
  );
  assert.throws(
    () => verifyGateShardResults({ results: { ...success, "gate-contract": undefined }, docsOnly: false }),
    "undefined 结果",
  );
});
