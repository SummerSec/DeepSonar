import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSystemRoutes } from "./domains/system/routes.js";
import { activateRuntimeImageConfiguration } from "./runtime-image-config-activation.js";
import { createRuntimeImageWarmupCoordinator } from "./runtime-image-warmup.js";
import { defaultRuntimeImageKey, requestRuntimeImagePreparation, resolveStartupRuntimeImages } from "./runtime-images.js";
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
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().ready, false);
  assert.equal(response.json().runtime_images.status, "preparing");
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

test("startup resolver derives Base, Audit and Kali from inherit-global role defaults", async () => {
  const snapshots = await resolveStartupRuntimeImages({} as typeof sql, "aliyun-acr", {
    listRoles: async () => [
      { name: "explore", runtime_image_key: null },
      { name: "audit", runtime_image_key: "deepsonar-audit" },
      { name: "test", runtime_image_key: "deepsonar-kali-minimal" },
      { name: "report", runtime_image_key: null },
    ],
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
