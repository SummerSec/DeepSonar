import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlatformTools, resolvePlatformToolsTightened } from "@deepsonar/shared-types";

test("#697 global disables emit_finding; empty project {} must not reopen", () => {
  const globalCfg = { emit_finding: false } as const;
  const globalOnly = resolvePlatformTools("audit", "role", globalCfg);
  assert.equal(globalOnly.includes("emit_finding"), false);

  // Whole-row project {} used to expand to all tools; tightened AND keeps global false.
  const tightened = resolvePlatformToolsTightened("audit", "role", globalCfg, {});
  assert.equal(tightened.includes("emit_finding"), false);
  assert.deepEqual(tightened, globalOnly);

  // Project may add further falses.
  const tighter = resolvePlatformToolsTightened("audit", "role", globalCfg, { emit_progress: false });
  assert.equal(tighter.includes("emit_finding"), false);
  assert.equal(tighter.includes("emit_progress"), false);
  assert.ok(tighter.includes("mark_job_done"));
});

test("#697 no project row keeps global resolution", () => {
  const tools = resolvePlatformToolsTightened("audit", "role", { emit_finding: false }, null);
  assert.equal(tools.includes("emit_finding"), false);
  assert.ok(tools.includes("mark_job_done"));
});

test("#1219 升级前关掉的旧名读取不会在新名上默认打开", () => {
  // 升级前保存的全局配置：读取被显式关闭（旧名）。
  const globalDisabled = { read_project_memory: false } as const;
  const globalResolved = resolvePlatformTools("explore", "role", globalDisabled);
  assert.equal(globalResolved.includes("read_project_knowledge"), false,
    "旧的关闭决定必须沿用到新名，升级后不能默认打开知识读取");
  assert.equal(globalResolved.includes("read_project_memory"), false,
    "新 Job 的可选工具里不出现旧名");
  // 项目只能进一步收紧：全局关掉时，项目再传 {} 也不能打开。
  const tightened = resolvePlatformToolsTightened("explore", "role", globalDisabled, {});
  assert.equal(tightened.includes("read_project_knowledge"), false);
  // 项目自己关掉旧名同样生效。
  const projectDisabled = resolvePlatformToolsTightened("explore", "role", {}, { read_project_memory: false });
  assert.equal(projectDisabled.includes("read_project_knowledge"), false);
  // 没有历史配置的角色照常拿到新名，且只有新名。
  const fresh = resolvePlatformTools("explore", "role", {});
  assert.ok(fresh.includes("read_project_knowledge"));
  assert.equal(fresh.includes("read_project_memory"), false);
  // 显式为旧名打开也同样迁移到新名。
  const enabled = resolvePlatformTools("explore", "role", { read_project_memory: true });
  assert.ok(enabled.includes("read_project_knowledge"));
});
