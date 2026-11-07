import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertCurrentRuntimeImageKey, RETIRED_RUNTIME_IMAGE_KEYS, RuntimeImageRetiredError } from "@deepsonar/shared-types";
import { currentRuntimeImageRegistry } from "./runtime-image-retirement.js";
import {
  loadRuntimeImageRegistry, parseRegistry, registryWithEnvOverrides,
  requestRuntimeImagePreparation, resetRemoteRuntimeImageRegistryCacheForTests,
  runRuntimeImagePreparationTask, runtimeImageHttpError, startRuntimeImagePull,
  type RuntimeImagePullTask,
} from "./runtime-images.js";

const digest = `sha256:${"c".repeat(64)}`;
const imageRef = `ghcr.io/example/retirement-fixture@${digest}`;

test("frozen historical Job re-execution has an independent retirement fence before provision", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const identityGuard = source.indexOf('if (useReal && (typeof snapshot.runtime_image?.image_key !== "string" || !snapshot.runtime_image.image_key.trim()))');
  assert.ok(identityGuard > source.indexOf("const snapshot = job.agent_snapshot_json"));
  assert.ok(identityGuard < source.indexOf("const runtimeImageKey ="), "real execution requires current frozen identity before the historical key alias is read");
  const identityFence = source.slice(identityGuard, source.indexOf("const runtimeImageKey =", identityGuard));
  assert.match(identityFence, /throw new Error\("RUNTIME_IMAGE_SNAPSHOT_INVALID:/);
  assert.doesNotMatch(identityFence, /image_ref|runtime_image_key|RoleConfig/, "neither frozen ref nor old alias/current config can synthesize identity");
  assert.ok(identityGuard < source.indexOf("provisionAttempted = true"));
  const guard = source.indexOf("assertCurrentRuntimeImageKey(runtimeImageKey)");
  assert.ok(guard > source.indexOf("const runtimeImageKey ="));
  assert.ok(guard < source.indexOf("provisionAttempted = true"));
  assert.ok(guard < source.indexOf("runner.provision(provisionInput)"));
  // Behavioral key rejection is covered below; this asserts the actual new-execution wiring,
  // including historical snapshots for which the optional CLI capability validator returns early.
});

async function oldCatalog() {
  const raw = JSON.parse(await readFile(new URL("../../../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
  const supported = structuredClone(raw.images);
  raw.images.push(...RETIRED_RUNTIME_IMAGE_KEYS.map((image_key) => ({ ...structuredClone(raw.images[0]), image_key, versions: [] })));
  return { raw, supported };
}

test("validate original old catalog before current-product projection; preserve all other products and provenance", async () => {
  const { raw, supported } = await oldCatalog();
  const original = parseRegistry(raw);
  const tagged = { ...original, source: "upload" as const, fallback: false, stale: true, error: "fixture", checked_at: "2026-11-07T00:00:00Z" };
  const before = structuredClone(tagged);
  const projected = currentRuntimeImageRegistry(tagged);
  assert.equal(supported.length, 11, "retirement branch keeps all eleven current products");
  assert.deepEqual(projected.images, parseRegistry({ ...raw, images: supported }).images);
  for (const image of projected.images) assert.doesNotThrow(() => assertCurrentRuntimeImageKey(image.image_key));
  assert.deepEqual(projected.excluded_retired_image_keys, [...RETIRED_RUNTIME_IMAGE_KEYS]);
  assert.deepEqual(tagged, before, "never mutate the original validated asset");
  assert.deepEqual(registryWithEnvOverrides(tagged), projected);
  for (const field of ["source", "fallback", "stale", "error", "checked_at", "platform", "platform_version", "min_runtime_image"] as const) {
    assert.deepEqual(projected[field], tagged[field]);
  }
  raw.images.at(-1).versions = [{ version: "invalid", image_ref: "mutable:tag" }];
  assert.throws(() => parseRegistry(raw), "invalid retired entries must not be dropped before raw validation");
});

test("old remote-only products cannot be merged back into the current catalog", async () => {
  const { raw } = await oldCatalog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(raw), { status: 200 });
  resetRemoteRuntimeImageRegistryCacheForTests();
  try {
    const catalog = await loadRuntimeImageRegistry({ refreshRemote: true });
    assert.equal(catalog.source, "remote");
    assert.equal(catalog.fallback, false);
    assert.equal(catalog.images.length, 11);
    assert.deepEqual(catalog.excluded_retired_image_keys, [...RETIRED_RUNTIME_IMAGE_KEYS]);
    assert.deepEqual((await loadRuntimeImageRegistry()).images, catalog.images);
  } finally {
    globalThis.fetch = originalFetch;
    resetRemoteRuntimeImageRegistryCacheForTests();
  }
});

test("new pull/preparation and old queued preparation fail before external inspection or pull", async () => {
  let externalCalls = 0;
  for (const image_key of RETIRED_RUNTIME_IMAGE_KEYS) {
    await assert.rejects(startRuntimeImagePull({ image_keys: [image_key] }), RuntimeImageRetiredError);
    await assert.rejects(startRuntimeImagePull({ items: [{ image_key, image_ref: imageRef }] }), RuntimeImageRetiredError);
    await assert.rejects(requestRuntimeImagePreparation([{ image_key, image_ref: imageRef }], "fixture", {
      inspect: async () => { externalCalls += 1; return { exists: true }; },
      prepare: async () => { externalCalls += 1; throw new Error("must not pull"); },
    }), RuntimeImageRetiredError);
    const task: RuntimeImagePullTask = {
      task_id: `retired-${image_key}`, purpose: "fixture", status: "queued", started_at: null, finished_at: null,
      total: 1, completed: 0, succeeded: 0, failed: 0,
      items: [{ image_key, image_ref: imageRef, status: "queued", error: null }],
    };
    await runRuntimeImagePreparationTask(task, async () => { externalCalls += 1; throw new Error("must not pull"); });
    assert.equal(task.status, "failed");
    assert.equal(task.items[0]?.error_code, "RUNTIME_IMAGE_RETIRED");
    assert.equal(externalCalls, 0);
    assert.deepEqual(runtimeImageHttpError(new RuntimeImageRetiredError(image_key)), {
      statusCode: 410, body: { error: `runtime image product is retired: ${image_key}`, error_code: "RUNTIME_IMAGE_RETIRED", image_key },
    });
  }
  assert.deepEqual(await requestRuntimeImagePreparation([{ image_key: "vendor-tool", image_ref: imageRef }], "fixture", {
    inspect: async () => ({ exists: true, repo_digests: [imageRef] }),
  }), { ready: true });
});
