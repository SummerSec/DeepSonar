import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSystemRoutes } from "./domains/system/routes.js";
import { activateRuntimeImageConfiguration } from "./runtime-image-config-activation.js";
import { createRuntimeImageWarmupCoordinator, DISPATCHER_DISABLED_LOG_AFTER } from "./runtime-image-warmup.js";
import {
  defaultRuntimeImageKey,
  isStartupRequiredRuntimeImage,
  requestRuntimeImagePreparation,
  resolveStartupRuntimeImages,
  RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR,
  RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR,
  withSharedAssetsHelperRef,
} from "./runtime-images.js";
import type { sql } from "./db.js";
import { classifyDispatcherFailure } from "./dispatcher.js";
import { RuntimeImageNotReadyError } from "./runtime-images.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("/health remains live and reports ready=false while warmup is pending", async () => {
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "preparing", ready: false, attempt: 1, required: 3, error: null, retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: false, started_at: null }),
    officialImageWarnings: () => [],
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().ready, false);
  assert.equal(typeof response.json().version, "string");
  assert.equal(response.json().runtime_images.status, "preparing");
  assert.equal(response.json().dispatcher.enabled, false);
  await app.close();
});

test("/health version uses DEEPSONAR_IMAGE_TAG when DEEPSONAR_VERSION is unset", async () => {
  const previousTag = process.env.DEEPSONAR_IMAGE_TAG;
  const previousVersion = process.env.DEEPSONAR_VERSION;
  delete process.env.DEEPSONAR_VERSION;
  process.env.DEEPSONAR_IMAGE_TAG = "0.1.37";
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "ready", ready: true, attempt: 1, required: 3, error: null, retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: true, started_at: "2026-01-01T00:00:00.000Z" }),
    officialImageWarnings: () => [],
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().version, "0.1.37");
  } finally {
    await app.close();
    if (previousTag === undefined) delete process.env.DEEPSONAR_IMAGE_TAG;
    else process.env.DEEPSONAR_IMAGE_TAG = previousTag;
    if (previousVersion === undefined) delete process.env.DEEPSONAR_VERSION;
    else process.env.DEEPSONAR_VERSION = previousVersion;
  }
});

test("/health ready requires both warmup and dispatcher", async () => {
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "ready", ready: true, attempt: 1, required: 3, error: null, retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: false, started_at: null }),
    officialImageWarnings: () => [],
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ready, false);
  assert.equal(typeof response.json().version, "string");
  assert.equal(response.json().dispatcher.enabled, false);
  await app.close();
});

test("/health ready fails closed when OpenSandbox server is down", async () => {
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "ready", ready: true, attempt: 1, required: 3, error: null, retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: true, started_at: "2026-01-01T00:00:00.000Z" }),
    officialImageWarnings: () => [],
    openSandboxStatus: () => ({
      level: "error",
      domain: "127.0.0.1:8080",
      checkedAt: "2026-01-01T00:00:00.000Z",
      error: "opensandbox health timed out",
    }),
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().ready, false);
  assert.deepEqual(response.json().opensandbox, {
    level: "error",
    domain: "127.0.0.1:8080",
    ready: false,
  });
  assert.equal(JSON.stringify(response.json()).includes("timed out"), false);
  await app.close();
});

test("warmup starts without blocking liveness and enables dispatch only after preparation", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let dispatchStarts = 0;
  const coordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => [{ image_ref: "base" }],
    prepare: async () => blocked,
    onReady: () => { dispatchStarts += 1; },
  });
  coordinator.start();
  assert.equal(coordinator.status().status, "preparing");
  assert.equal(dispatchStarts, 0);
  release();
  await flush();
  assert.equal(coordinator.status().ready, true);
  assert.equal(dispatchStarts, 1);
});

test("consecutive warmup failures emit dispatcher-disabled error after threshold", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  let attempts = 0;
  let coordinator!: ReturnType<typeof createRuntimeImageWarmupCoordinator>;
  coordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => [{ image_ref: "base" }],
    prepare: async () => {
      attempts += 1;
      if (attempts >= DISPATCHER_DISABLED_LOG_AFTER) coordinator.stop();
      throw new Error("missing opt-in image");
    },
    onReady: () => {},
    retryDelaysMs: [1],
    sleep: async () => {},
    log: (level, message) => { logs.push({ level, message }); },
  });
  coordinator.start();
  await flush();
  assert.equal(attempts, DISPATCHER_DISABLED_LOG_AFTER);
  assert.ok(logs.some((item) => item.level === "error" && /dispatcher disabled/.test(item.message)));
});

test("warmup failure stays live, exposes a sanitized failure and retries", async () => {
  let attempts = 0;
  let releaseRetry!: () => void;
  const retry = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const coordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => [{ image_ref: "base" }],
    prepare: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("authorization=secret-token");
    },
    onReady: () => {},
    retryDelaysMs: [1],
    sleep: async () => retry,
  });
  coordinator.start();
  await flush();
  assert.equal(coordinator.status().status, "failed");
  assert.doesNotMatch(coordinator.status().error ?? "", /secret-token/);
  releaseRetry();
  await flush();
  assert.equal(coordinator.status().ready, true);
  assert.equal(attempts, 2);
});

test("warmup runs afterPrepare before enabling dispatch", async () => {
  const order: string[] = [];
  const coordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => [{ image_ref: "base", image_key: "deepsonar-base" }],
    prepare: async () => { order.push("prepare"); },
    afterPrepare: async (refs) => {
      assert.equal(refs[0]?.image_key, "deepsonar-base");
      order.push("preheat");
    },
    onReady: () => { order.push("ready"); },
  });
  coordinator.start();
  await flush();
  assert.deepEqual(order, ["prepare", "preheat", "ready"]);
});

test("startup effective set prepares Base, Audit and Kali once each", async () => {
  const prepared: string[] = [];
  const coordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => [
      { image_ref: "base" }, { image_ref: "audit" }, { image_ref: "kali" }, { image_ref: "base" },
    ],
    prepare: async (ref) => { prepared.push(ref); },
    onReady: () => {},
  });
  coordinator.start();
  await flush();
  assert.deepEqual(prepared, ["base", "audit", "kali"]);
  assert.equal(coordinator.status().required, 3);
});

function officialMeta(projectOptIn = false) {
  return { official: true, project_opt_in: projectOptIn, enabled: true };
}

test("startup resolver derives Base, Audit and Kali from inherit-global role defaults", async () => {
  const snapshots = await resolveStartupRuntimeImages({} as typeof sql, "aliyun-acr", {
    listRoles: async () => [
      { name: "explore", runtime_image_key: null },
      { name: "audit", runtime_image_key: "deepsonar-audit" },
      { name: "test", runtime_image_key: "deepsonar-kali-minimal" },
      { name: "report", runtime_image_key: null },
    ],
    lookupImage: async () => officialMeta(false),
    resolve: async (_db, _projectId, roleName, configuredKey) => {
      const key = configuredKey ?? defaultRuntimeImageKey(roleName);
      const digestChar = key === "deepsonar-base" ? "a" : key === "deepsonar-audit" ? "b" : "c";
      return {
        runtime_image_id: key,
        runtime_image_version_id: key,
        image_key: key,
        image_ref: `registry.invalid/${key}@sha256:${digestChar.repeat(64)}`,
        image_digest: `sha256:${digestChar.repeat(64)}`,
        tools_manifest_sha256: null,
        admission_scan_id: null,
        contract_version: "v1",
        source_kind: "official",
        trust_status: "trusted",
      };
    },
  });
  assert.deepEqual(new Set(snapshots.map((item) => item.image_key)), new Set([
    "deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal",
  ]));
});

test("startup resolver skips project-opt-in images and still requires official defaults", async () => {
  const resolved: string[] = [];
  const snapshots = await resolveStartupRuntimeImages({} as typeof sql, "aliyun-acr", {
    listRoles: async () => [
      { name: "explore", runtime_image_key: null },
      { name: "audit", runtime_image_key: "deepsonar-audit" },
      { name: "test", runtime_image_key: "deepsonar-kali-minimal" },
      { name: "openharmony-audit", runtime_image_key: "deepsonar-openharmony-audit" },
    ],
    lookupImage: async (imageKey) => officialMeta(imageKey === "deepsonar-openharmony-audit"),
    resolve: async (_db, _projectId, roleName, configuredKey) => {
      const key = configuredKey ?? defaultRuntimeImageKey(roleName);
      resolved.push(key);
      if (key === "deepsonar-openharmony-audit") {
        throw new Error(`角色 ${roleName} 没有可用的可信运行镜像版本（key=${key}）；请先准入 digest 并为项目启用`);
      }
      const digestChar = key === "deepsonar-base" ? "a" : key === "deepsonar-audit" ? "b" : "c";
      return {
        runtime_image_id: key,
        runtime_image_version_id: key,
        image_key: key,
        image_ref: `registry.invalid/${key}@sha256:${digestChar.repeat(64)}`,
        image_digest: `sha256:${digestChar.repeat(64)}`,
        tools_manifest_sha256: null,
        admission_scan_id: null,
        contract_version: "v1",
        source_kind: "official",
        trust_status: "trusted",
      };
    },
  });
  assert.deepEqual(resolved, ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal"]);
  assert.deepEqual(new Set(snapshots.map((item) => item.image_key)), new Set([
    "deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal",
  ]));
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: true, enabled: true }), false);
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: false, enabled: true }), true);
});

test("async preparation returns immediately and leaves persistence to an explicit retry", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const imageRef = `example.invalid/runtime@${digest}`;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const result = await requestRuntimeImagePreparation(
    [{ image_key: "runtime", image_ref: imageRef }],
    "test",
    { inspect: async () => ({ exists: false }), prepare: async () => blocked },
  );
  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.match(result.task.status, /queued|running/);
  release();
  await flush();
  assert.equal(result.task.status, "succeeded");
});

test("HTTP activation returns 202 and does not persist while preparation is pending", async () => {
  const app = Fastify();
  let persisted = 0;
  app.patch("/channel", async (_req, reply) => {
    const result = await activateRuntimeImageConfiguration({
      refs: [{ image_key: "base", image_ref: `example.invalid/base@sha256:${"b".repeat(64)}` }],
      purpose: "channel:test",
      persist: async () => { persisted += 1; return true; },
      requestPreparation: async () => ({
        ready: false,
        task: {
          task_id: "task", purpose: "channel:test", status: "running", started_at: null,
          finished_at: null, total: 1, completed: 0, items: [],
        },
      }),
    });
    if (result.status === "preparing") return reply.code(202).send(result);
    return reply.send(result);
  });
  const response = await app.inject({ method: "PATCH", url: "/channel" });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().saved, false);
  assert.equal(persisted, 0);
  await app.close();
});

test("Dispatcher classifies missing local images with a stable metric and persisted reason", () => {
  const result = classifyDispatcherFailure(new RuntimeImageNotReadyError("registry.invalid/base@sha256:deadbeef"));
  assert.equal(result.reason, "runtime_image_not_ready");
  assert.match(result.message, /^runtime_image_not_ready:/);
});

test("/health.runtime_images.error 区分通道超时兜底与 digest not found", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "failed",
      ready: false,
      attempt: 2,
      required: 3,
      error: `冻结 runtime image 拉取失败（${digest}）：${RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR}: timeout awaiting response headers`,
      retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: false, started_at: null }),
    officialImageWarnings: () => [],
  });
  const timeoutHealth = await app.inject({ method: "GET", url: "/health" });
  assert.match(timeoutHealth.json().runtime_images.error, /channel timed out, same-digest fallback attempted/);
  assert.doesNotMatch(timeoutHealth.json().runtime_images.error, /digest not found/);
  await app.close();

  const missing = Fastify();
  registerSystemRoutes(missing, {
    runtimeImageStatus: () => ({
      status: "failed",
      ready: false,
      attempt: 2,
      required: 3,
      error: `冻结 runtime image 拉取失败（${digest}）：${RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR}: manifest unknown`,
      retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: false, started_at: null }),
    officialImageWarnings: () => [],
  });
  const missingHealth = await missing.inject({ method: "GET", url: "/health" });
  assert.match(missingHealth.json().runtime_images.error, /digest not found/);
  assert.doesNotMatch(missingHealth.json().runtime_images.error, /same-digest fallback attempted/);
  await missing.close();
});

test("/health surfaces official default image revoked as a warning", async () => {
  const app = Fastify();
  registerSystemRoutes(app, {
    runtimeImageStatus: () => ({
      status: "ready", ready: true, attempt: 1, required: 3, error: null, retry_at: null,
    }),
    dispatcherStatus: () => ({ enabled: true, started_at: "2026-01-01T00:00:00.000Z" }),
    officialImageWarnings: () => ["official default image deepsonar-base revoked"],
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().runtime_images.official_trust_warnings, [
    "official default image deepsonar-base revoked",
  ]);
  await app.close();
});

test("startup warmup 解析结果包含共享资产 helper", async () => {
  const helper = `docker.io/library/busybox@sha256:${"e".repeat(64)}`;
  const snapshots = await resolveStartupRuntimeImages({} as typeof sql, "aliyun-acr", {
    listRoles: async () => [
      { name: "explore", runtime_image_key: null },
      { name: "audit", runtime_image_key: "deepsonar-audit" },
      { name: "test", runtime_image_key: "deepsonar-kali-minimal" },
    ],
    lookupImage: async () => officialMeta(false),
    resolve: async (_db, _projectId, roleName, configuredKey) => {
      const key = configuredKey ?? defaultRuntimeImageKey(roleName);
      const digestChar = key === "deepsonar-base" ? "a" : key === "deepsonar-audit" ? "b" : "c";
      return {
        runtime_image_id: key,
        runtime_image_version_id: key,
        image_key: key,
        image_ref: `registry.invalid/${key}@sha256:${digestChar.repeat(64)}`,
        image_digest: `sha256:${digestChar.repeat(64)}`,
        tools_manifest_sha256: null,
        admission_scan_id: null,
        contract_version: "v1",
        source_kind: "official",
        trust_status: "trusted",
      };
    },
  });
  const refs = withSharedAssetsHelperRef(snapshots, helper);
  assert.equal(refs.at(-1)?.image_key, "shared-assets-helper");
  assert.equal(refs.at(-1)?.image_ref, helper);
  assert.equal(new Set(refs.map((item) => item.image_ref)).size, 4);
});
