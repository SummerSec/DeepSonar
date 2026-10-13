import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRuntimeImagesOnNodes } from "./runtime-image-reconcile.js";
import { resetRuntimeImagePullTask } from "./runtime-images.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REF = `ghcr.io/example/base@${DIGEST}`;

test("reconcile reports local missing digests and marks remote inspect unsupported", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: false,
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["job_frozen"],
    }],
    inspect: async () => ({ exists: false }),
    listWorkers: () => [{ id: "worker-a", kind: "remote" }],
  });
  const local = result.nodes.find((node) => node.node_kind === "local");
  assert.ok(local);
  assert.equal(local?.missing.length, 1);
  assert.equal(local?.items[0]?.local_present, false);
  assert.equal(local?.items[0]?.reasons.includes("job_frozen"), true);
  assert.equal(result.nodes.find((node) => node.node_id === "worker-a")?.inspect, "unsupported");
  assert.equal(result.repair_task, null);
  resetRuntimeImagePullTask();
});

test("reconcile repair starts targeted pull for missing digests only", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: true,
    listWorkers: () => [],
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["latest", "job_frozen"],
    }],
    inspect: async () => ({ exists: false }),
  });
  assert.ok(result.repair_task);
  assert.equal(result.repair_task?.purpose, "admin_targeted");
  assert.equal(result.repair_task?.total, 1);
  assert.equal(result.repair_task?.items[0]?.image_ref, IMAGE_REF);
  assert.equal(result.repair_task?.items[0]?.target_digest, DIGEST);
  resetRuntimeImagePullTask();
});

test("reconcile does not pull when local already matches digest", async () => {
  resetRuntimeImagePullTask();
  const result = await reconcileRuntimeImagesOnNodes({
    repair: true,
    listWorkers: () => [],
    loadNeeds: () => [{
      image_key: "deepsonar-base",
      image_ref: IMAGE_REF,
      digest: DIGEST,
      version_id: "ver-1",
      reasons: ["latest"],
    }],
    inspect: async (ref) => {
      if (ref === IMAGE_REF || ref === DIGEST) {
        return { exists: true, repo_digests: [IMAGE_REF], image_id: DIGEST };
      }
      return { exists: false };
    },
  });
  assert.equal(result.repair_task, null);
  assert.equal(result.nodes[0]?.missing.length, 0);
  assert.equal(result.nodes[0]?.items[0]?.local_present, true);
  resetRuntimeImagePullTask();
});

test("reconcile enumerates registry remote nodes without inspecting or repairing them", async () => {
  const result = await reconcileRuntimeImagesOnNodes({
    repair: true,
    loadNeeds: () => [{ image_key: "deepsonar-base", image_ref: IMAGE_REF, digest: DIGEST, version_id: "ver-1", reasons: ["latest"] }],
    inspect: async () => ({ exists: true, repo_digests: [IMAGE_REF] }),
    listWorkers: () => [
      { id: "local", kind: "local" },
      { id: "other-local", kind: "local" },
      { id: "worker-online", kind: "remote" },
      { id: "worker-stale", kind: "remote" },
      { id: "worker-unavailable", kind: "remote" },
      { id: "worker-online", kind: "remote" },
    ],
  });
  assert.equal(result.repair_task, null);
  const remotes = result.nodes.filter((node) => node.node_kind === "remote");
  assert.deepEqual(remotes.map((node) => node.node_id), ["worker-online", "worker-stale", "worker-unavailable"]);
  for (const remote of remotes) {
    assert.equal(remote.inspect, "unsupported");
    assert.match(remote.inspect_error!, /not a substitute/);
    assert.deepEqual(remote.items, []);
    assert.deepEqual(remote.missing, []);
  }
});

test("registry enumeration failure is not silently reported as zero remote nodes", async () => {
  await assert.rejects(reconcileRuntimeImagesOnNodes({
    loadNeeds: () => [],
    listWorkers: async () => { throw new Error("worker registry unavailable"); },
  }), /worker registry unavailable/);
});

test("production reconcile defaults to the worker registry used by dispatch", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./runtime-image-reconcile.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ listWorkerNodes \} from "\.\/domains\/worker-nodes\/registry\.js"/);
  assert.match(source, /\(input\.listWorkers \?\? listWorkerNodes\)\(\)/);
});
