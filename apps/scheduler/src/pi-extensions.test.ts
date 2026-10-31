import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AgentRuntimeProfile,
  PI_EXTENSION_REGISTRY,
  PI_EXTENSION_SANDBOX_PREFIX,
  PI_OBSERVATIONAL_MEMORY_PROVIDER,
  PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH,
  PiObservationalMemoryConfig,
  piObservationalMemorySettings,
  validatePiExtensionIds,
} from "@deepsonar/shared-types";
import {
  assertObservationalMemoryQuota,
  freezeObservationalMemoryQuota,
  freezeObservationalMemoryQuotas,
  freezePiExtensions,
  materializeFrozenPiExtensions,
  observationalMemoryConfig,
  parseFrozenPiExtensions,
  piExtensionLoaderSource,
} from "./pi-extensions.js";

test("RoleConfig 只接受已注册的 Pi 扩展", () => {
  assert.equal(validatePiExtensionIds([], "pi"), null);
  assert.equal(validatePiExtensionIds(["pi-web-access"], "pi"), null);
  assert.match(validatePiExtensionIds(["not-a-real-ext"], "pi") ?? "", /未注册/);
  assert.match(validatePiExtensionIds(["pi-web-access"], "claude-code") ?? "", /仅 agent_cli=pi/);
  assert.match(validatePiExtensionIds(["PI_WEB"], "pi") ?? "", /非法/);
});

test("Job 创建冻结已注册扩展，未注册与不兼容镜像失败", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]?.id, "pi-web-access");
  assert.equal(frozen[0]?.version, PI_EXTENSION_REGISTRY["pi-web-access"].version);
  assert.equal(frozen[0]?.integrity, PI_EXTENSION_REGISTRY["pi-web-access"].integrity);
  assert.equal(frozen[0]?.workspace_path, ".pi/agent/extensions/pi-web-access.ts");
  assert.ok(frozen[0]?.entry_path.startsWith("/opt/deepsonar/pi-extensions/node_modules/"));
  assert.deepEqual(freezePiExtensions([], "claude-code", "deepsonar-base"), []);
  assert.throws(() => freezePiExtensions(["ghost-ext"], "pi", "deepsonar-audit"), /未注册/);
  assert.throws(() => freezePiExtensions(["pi-web-access"], "pi", "deepsonar-base"), /不兼容/);
  assert.throws(() => freezePiExtensions(["pi-web-access"], "pi", "deepsonar-chrome-audit"), /不兼容/);
});

test("冻结快照重放拒绝被改写的入口与未注册 id", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  assert.deepEqual(parseFrozenPiExtensions(frozen), frozen);
  assert.deepEqual(parseFrozenPiExtensions(undefined), []);
  assert.throws(() => parseFrozenPiExtensions([{ ...frozen[0], id: "ghost-ext" }]), /未注册/);
  assert.throws(() => parseFrozenPiExtensions([{ ...frozen[0], entry_path: "/tmp/evil.ts" }]), /入口路径非法/);
  assert.throws(
    () => parseFrozenPiExtensions([{ ...frozen[0], version: "0.0.1" }]),
    /与当前注册表不一致/,
  );
});

test("冻结扩展元数据必须精确匹配注册表且拒绝未知字段/重复 id", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  const extension = frozen[0];
  assert.ok(extension);
  assert.throws(
    () => parseFrozenPiExtensions([{ ...extension, requires_gateway: true }]),
    /PI_EXTENSION_FROZEN_METADATA_MISMATCH:pi-web-access/,
  );
  assert.throws(
    () => parseFrozenPiExtensions([{ ...extension, unexpected: true }]),
    /PI_EXTENSION_FROZEN_FIELD_UNKNOWN:pi-web-access:unexpected/,
  );
  assert.throws(
    () => parseFrozenPiExtensions([{ ...extension, compatible_image_keys: ["deepsonar-audit", "deepsonar-base"] }]),
    /PI_EXTENSION_FROZEN_METADATA_MISMATCH:pi-web-access/,
  );
  assert.throws(
    () => parseFrozenPiExtensions([extension, extension]),
    /PI_EXTENSION_DUPLICATE:pi-web-access/,
  );
});

test("物化只生成注册路径 stub，禁网时跳过出网扩展", () => {
  const frozen = freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit");
  const allowed = materializeFrozenPiExtensions(frozen, true);
  assert.equal(allowed.paths.length, 1);
  assert.ok(allowed.paths[0]?.startsWith(PI_EXTENSION_SANDBOX_PREFIX));
  assert.equal(allowed.files[0]?.path, ".pi/agent/extensions/pi-web-access.ts");
  assert.match(allowed.files[0]?.content ?? "", /export \{ default \} from "\/opt\/deepsonar\/pi-extensions\/node_modules\/pi-web-access\/index\.ts"/);
  assert.equal(allowed.skipped.length, 0);
  const denied = materializeFrozenPiExtensions(frozen, false);
  assert.deepEqual(denied.paths, []);
  assert.deepEqual(denied.files, []);
  assert.deepEqual(denied.skipped, [{ id: "pi-web-access", reason: "requires_egress" }]);
});

test("扩展入口与 RoleConfig 上传路径均拒绝穿越", () => {
  assert.throws(() => piExtensionLoaderSource("/tmp/evil.ts"), /PI_EXTENSION_ENTRY_PATH_INVALID/);
  assert.throws(
    () => piExtensionLoaderSource("/opt/deepsonar/pi-extensions/node_modules/../escape.ts"),
    /PI_EXTENSION_ENTRY_PATH_INVALID/,
  );
  const core = readFileSync(new URL("./role-config-validation.ts", import.meta.url), "utf8");
  assert.match(core, /Pi 扩展只能通过 Hub 角色能力组合声明已注册扩展（pi_extension_ids），不能上传扩展源码/);
  assert.match(core, /\.pi\\\/agent\\\/extensions/);
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(executor, /materializeFrozenPiExtensions/);
  assert.match(executor, /piExtensions: piExtensionInjection\.paths/);
  assert.doesNotMatch(executor, /filter\(\(file\) => file\.path\.startsWith\("\.pi\/agent\/extensions\/"\)\)/);
});

function frozenObservationalMemory(imageKey = "deepsonar-base") {
  const [extension] = freezePiExtensions(["pi-observational-memory"], "pi", imageKey, {
    provider: "openai",
    model: "gpt-5.6",
    thinking: "low",
    contextWindowTokens: 128_000,
  });
  assert.ok(extension);
  return extension;
}

test("observational memory is opt-in, provider-isolated, and rejects unknown config fields", () => {
  assert.deepEqual(freezePiExtensions([], "pi", "deepsonar-base"), []);
  assert.equal(observationalMemoryConfig([]), null);

  const extension = frozenObservationalMemory();
  const config = observationalMemoryConfig([extension]);
  assert.ok(config);
  assert.equal(config.model.provider, PI_OBSERVATIONAL_MEMORY_PROVIDER);
  assert.equal(config.model.id, config.source_model);
  assert.notEqual(config.model.provider, config.source_provider);
  assert.equal(config.passive, false);
  assert.equal(config.showWorkerNotifications, false);
  assert.equal(config.debugLog, false);
  assert.throws(
    () => PiObservationalMemoryConfig.parse({ ...config, unsupported_knob: true }),
    /unrecognized key/i,
  );
  assert.throws(
    () => PiObservationalMemoryConfig.parse({
      ...config,
      model: { ...config.model, id: "other-model" },
    }),
    /must match source_model/,
  );
});

test("observational memory materialization is Gateway-gated and hashes ordered stubs", () => {
  const frozen = freezePiExtensions(["pi-web-access", "pi-observational-memory"], "pi", "deepsonar-audit", {
    provider: "openai",
    model: "gpt-5.6",
    thinking: "low",
  });
  assert.throws(
    () => materializeFrozenPiExtensions(frozen, true, { gatewayAvailable: false }),
    /PI_EXTENSION_GATEWAY_REQUIRED:pi-observational-memory/,
  );

  const materialized = materializeFrozenPiExtensions(frozen, false, { gatewayAvailable: true });
  assert.deepEqual(materialized.skipped, [{ id: "pi-web-access", reason: "requires_egress" }]);
  assert.equal(materialized.files.length, 1);
  assert.equal(materialized.injected.length, 1);
  const file = materialized.files[0];
  assert.ok(file);
  assert.equal(file.path, ".pi/agent/extensions/pi-observational-memory.ts");
  assert.match(file.content, new RegExp(PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH.replaceAll("/", "\\/")));
  assert.match(file.content, /createGovernedObservationalMemoryExtension\(frozenConfig\)/);
  assert.match(file.content, /"source_model": "gpt-5\.6"/);
  assert.equal(
    file.content_sha256,
    createHash("sha256").update(file.content, "utf8").digest("hex"),
  );

  const ordered = materializeFrozenPiExtensions(frozen, true, { gatewayAvailable: true });
  assert.deepEqual(ordered.files.map((item) => item.path), [
    ".pi/agent/extensions/pi-web-access.ts",
    ".pi/agent/extensions/pi-observational-memory.ts",
  ]);
  assert.deepEqual(ordered.injected.map((item) => item.id), ["pi-web-access", "pi-observational-memory"]);
});

test("finite observational-memory allocation is explicit, bounded, and frozen to Job limits", () => {
  const extension = frozenObservationalMemory();
  const config = observationalMemoryConfig([extension]);
  assert.ok(config);
  const finite = freezeObservationalMemoryQuota(config, 10, {
    DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "7",
    DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
  });
  assert.deepEqual(finite.request_budget, {
    total_requests: 10,
    main_requests: 7,
    background_requests: 3,
  });
  assertObservationalMemoryQuota([{ ...extension, observational_memory: finite }], 10);
  assert.throws(
    () => assertObservationalMemoryQuota([{ ...extension, observational_memory: finite }], 11),
    /PI_OM_TOTAL_REQUESTS_MISMATCH/,
  );
  assert.throws(
    () => freezeObservationalMemoryQuota(config, 10, {}),
    /PI_OM_FINITE_ALLOCATION_REQUIRED/,
  );
  assert.throws(
    () => freezeObservationalMemoryQuota(config, 10, {
      DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "bad",
      DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
    }),
    /PI_OM_PLATFORM_ENV_INVALID:DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS/,
  );
  assert.throws(
    () => freezeObservationalMemoryQuota(config, 10, {
      DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "8",
      DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
    }),
    /PI_OM_ALLOCATION_EXCEEDS_TOTAL/,
  );
  assert.throws(
    () => freezeObservationalMemoryQuota(config, 10, {
      DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "7",
      DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
      DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT: "4",
      DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT: "0",
    }),
    /PI_OM_BACKGROUND_REQUEST_LIMIT_EXCEEDS_ALLOCATION/,
  );
});

test("unlimited Job request totals do not invent an OM allocation", () => {
  const extension = frozenObservationalMemory();
  const config = observationalMemoryConfig([extension]);
  assert.ok(config);
  const unlimited = freezeObservationalMemoryQuota(config, 0, {});
  assert.equal(unlimited.request_budget, undefined);
  assert.equal(unlimited.background_limits, undefined);
  const explicitZeroLimits = freezeObservationalMemoryQuota(config, undefined, {
    DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT: "0",
    DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT: "0",
  });
  assert.deepEqual(explicitZeroLimits.background_limits, { max_requests: 0, max_tokens: 0 });
});

test("background dimensions are independently optional without changing the shared numeric contract", () => {
  const extension = frozenObservationalMemory();
  const config = extension.observational_memory!;
  assert.deepEqual(freezeObservationalMemoryQuota(config, 0, {
    DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT: "1200",
  }).background_limits, { max_requests: 0, max_tokens: 1200 });
  assert.deepEqual(freezeObservationalMemoryQuota(config, 0, {
    DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT: "2",
  }).background_limits, { max_requests: 2, max_tokens: 0 });
  const finite = freezeObservationalMemoryQuota(config, 10, {
    DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "7",
    DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
    DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT: "1200",
  });
  assert.deepEqual(finite.background_limits, { max_requests: 0, max_tokens: 1200 });
  assertObservationalMemoryQuota([{ ...extension, observational_memory: finite }], 10);
  for (const value of ["", "-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(() => freezeObservationalMemoryQuota(config, 0, {
      DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT: value,
    }), /PI_OM_PLATFORM_ENV_INVALID/);
  }
});

test("frozen configuration rejects unsupported knobs and caller authority at every nested boundary", () => {
  const config = frozenObservationalMemory().observational_memory!;
  for (const patch of [
    { passive: true },
    { debugLog: true },
    { showWorkerNotifications: true },
    { observeAfterTokens: 0 },
    { reflectAfterTokens: 0.5 },
    { compactAfterTokensRatio: 1 },
    { observerChunkMaxTokens: Number.POSITIVE_INFINITY },
    { observationsPoolTargetTokens: config.observationsPoolMaxTokens },
    { model: { ...config.model, provider: "direct-provider" } },
    { model: { ...config.model, token: "caller-authority" } },
    { request_budget: { total_requests: 10, main_requests: 7, background_requests: 3, workload: "main" } },
    { background_limits: { max_requests: 0, max_tokens: 0, job_id: "caller-job" } },
  ]) {
    assert.equal(PiObservationalMemoryConfig.safeParse({ ...config, ...patch }).success, false);
  }
  const settings = piObservationalMemorySettings(config);
  assert.equal(settings.observeAfterTokens, 10_000);
  assert.equal(settings.observerChunkMaxTokens, 25_600);
  assert.equal(settings.includeSourceContent, undefined);
  assert.equal(settings.request_budget, undefined);
  assert.equal(settings.background_limits, undefined);
});

test("finite allocation rejects one-request totals, malformed frozen budgets, and refreezing", () => {
  const extension = frozenObservationalMemory();
  const config = extension.observational_memory!;
  assert.throws(() => freezeObservationalMemoryQuota(config, 1, {
    DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "1",
    DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "1",
  }), /PI_OM_ALLOCATION_EXCEEDS_TOTAL/);
  const finite = freezeObservationalMemoryQuota(config, 10, {
    DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "7",
    DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3",
  });
  assert.throws(() => freezeObservationalMemoryQuota(finite, 10, {}), /PI_OM_QUOTA_NOT_PLATFORM_OWNED/);
  assert.throws(() => assertObservationalMemoryQuota([extension], 10), /PI_OM_FINITE_ALLOCATION_MISSING/);
  assert.throws(() => assertObservationalMemoryQuota([{ ...extension, observational_memory: finite }], 0), /PI_OM_UNEXPECTED_FINITE_QUOTA/);
  assert.throws(() => assertObservationalMemoryQuota([extension], -1), /PI_OM_TOTAL_REQUESTS_INVALID/);
  assert.throws(() => assertObservationalMemoryQuota([{
    ...extension,
    observational_memory: { ...config, request_budget: { total_requests: 10, main_requests: -7, background_requests: 3 } },
  }], 10));
});

test("quotas freeze into new snapshots without mutating the prepared extension or disabled jobs", () => {
  const extension = frozenObservationalMemory();
  const prepared = structuredClone(extension);
  const env = { DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS: "7", DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS: "3" };
  const [finite] = freezeObservationalMemoryQuotas([extension], 10, env);
  assert.ok(finite);
  env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS = "9";
  assert.equal(finite.observational_memory?.request_budget?.background_requests, 3);
  assert.deepEqual(extension, prepared);
  assert.deepEqual(freezeObservationalMemoryQuotas([], 1, {}), []);
  assert.deepEqual(freezeObservationalMemoryQuotas(
    freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit"), 1, {},
  ), freezePiExtensions(["pi-web-access"], "pi", "deepsonar-audit"));
  const before = materializeFrozenPiExtensions([extension], false, { gatewayAvailable: true });
  const after = materializeFrozenPiExtensions([finite], false, { gatewayAvailable: true });
  assert.notEqual(before.files[0]?.content_sha256, after.files[0]?.content_sha256);
});

test("runtime profiles bind OM to the same Job model, Pi route, and admitted extension identity", () => {
  const extension = frozenObservationalMemory();
  const config = extension.observational_memory!;
  const profile = AgentRuntimeProfile.parse({
    schema: "deepsonar.agent-runtime-profile/v1", profile_version: 1, agent_cli: "pi",
    provider_ref: { credential_id: "fixture-credential", provider: "openai" },
    model_ref: config.source_model, reasoning_effort: "low", context_window_tokens: 128_000,
    extensions: [{ id: extension.id, version: extension.version, integrity: extension.integrity }],
    system_prompt_ref: null, env_refs: [],
    native_options: { claude_code: null, dsh: null, pi: {
      model: config.source_model, provider: config.source_provider,
      extensions: [extension.id], observational_memory: config,
    } },
    resolution_order: ["global", "project", "role", "task", "job"],
    profile_fingerprint: `sha256:${"0".repeat(64)}`,
  });
  for (const patch of [
    { agent_cli: "claude-code" },
    { model_ref: "other-model" },
    { extensions: [] },
    { extensions: [{ ...profile.extensions[0], integrity: "unadmitted" }] },
    { native_options: { ...profile.native_options, pi: { ...profile.native_options.pi, provider: "other-route" } } },
    { native_options: { ...profile.native_options, pi: { ...profile.native_options.pi, model: "other-model" } } },
    { native_options: { ...profile.native_options, pi: { ...profile.native_options.pi, extensions: [] } } },
  ]) assert.equal(AgentRuntimeProfile.safeParse({ ...profile, ...patch }).success, false);
});
