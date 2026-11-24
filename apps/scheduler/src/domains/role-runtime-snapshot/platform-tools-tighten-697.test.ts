import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLegacyPlatformTools, resolvePlatformTools, resolvePlatformToolsTightened, requiredPlatformTools } from "@deepsonar/shared-types";

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

test("#1219 混合新旧键时项目仍只能收紧，不能因全局新键覆盖项目旧键而放开", () => {
  // 升级后全局显式开启新名，项目此前用旧名显式关闭：项目收紧必须保留。
  const tightened = resolvePlatformToolsTightened("explore", "role",
    { read_project_knowledge: true }, { read_project_memory: false });
  assert.equal(tightened.includes("read_project_knowledge"), false,
    "项目用旧键做过的关闭不能丢掉");
  // 全局用旧名关闭，项目用新名打开也不行（全局关闭不能被项目打开）。
  const globalOff = resolvePlatformToolsTightened("explore", "role",
    { read_project_memory: false }, { read_project_knowledge: true });
  assert.equal(globalOff.includes("read_project_knowledge"), false);
  // 两层都开启时才保留。
  const bothOn = resolvePlatformToolsTightened("explore", "role",
    { read_project_knowledge: true }, { read_project_knowledge: true });
  assert.ok(bothOn.includes("read_project_knowledge"));
});

test("#1219 项目旧数据里的 false 不能关掉终态必需工具", () => {
  const required = requiredPlatformTools("role");
  // 导入路径可能绕过编辑校验写入任意映射，运行时仍要保住必需工具。
  const tools = resolvePlatformToolsTightened("explore", "role", {},
    { mark_job_done: false, ack_human_message: false, emit_finding: false });
  for (const name of required) assert.ok(tools.includes(name), `${name} 必须保留`);
  assert.equal(tools.includes("emit_finding"), false, "非必需工具仍按项目配置收紧");
});

test("#1219 保存前把旧工具键归一化成新键，新键优先、未知键保留给白名单拒绝", () => {
  // 旧键的显式关闭迁移到新键：编辑页改一项无关设置后不会把读取重新打开。
  assert.deepEqual(normalizeLegacyPlatformTools({ read_project_memory: false }), { read_project_knowledge: false });
  // 新键已显式设置时以新键为准，旧键被丢弃。
  assert.deepEqual(normalizeLegacyPlatformTools({ read_project_memory: false, read_project_knowledge: true }),
    { read_project_knowledge: true });
  // 未知键原样保留，交给白名单校验拒绝。
  const unknown = normalizeLegacyPlatformTools({ totally_unknown_tool: true } as never);
  assert.deepEqual(unknown, { totally_unknown_tool: true });
});
