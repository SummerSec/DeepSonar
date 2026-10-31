import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL } from "./runtime-shared.js";
import { KubernetesSharedAssetsVolumeManager, readDefaultStorageClass } from "./kubernetes-shared-assets-volume.js";
import { DEFAULT_SHARED_ASSETS_HELPER_IMAGE, managedSharedAssetsVolumeName } from "./shared-assets-volume.js";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const claim = managedSharedAssetsVolumeName(jobId);
const helperImage = DEFAULT_SHARED_ASSETS_HELPER_IMAGE;

function ownedPvc() {
  return JSON.stringify({
    metadata: {
      name: claim,
      labels: { [SHARED_ASSETS_VOLUME_LABEL]: "true", [SHARED_ASSETS_JOB_LABEL]: jobId },
      creationTimestamp: "2026-08-28T00:00:00Z",
    },
    status: { phase: "Bound" },
  });
}

async function sourceFile(): Promise<{ directory: string; sourcePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-k8s-assets-unit-"));
  const sourcePath = path.join(directory, "fixture.txt");
  await writeFile(sourcePath, "fixture\n", "utf8");
  return { directory, sourcePath };
}

test("Kubernetes shared-assets manager requires an immutable helper digest and kubeconfig", () => {
  assert.throws(
    () => new KubernetesSharedAssetsVolumeManager({ helperImage: "busybox:latest", kubeconfig: "/tmp/kube" }),
    /不可变 OCI 引用/,
  );
  assert.throws(
    () => new KubernetesSharedAssetsVolumeManager({ helperImage }),
    /KUBECONFIG/,
  );
  assert.doesNotThrow(() => new KubernetesSharedAssetsVolumeManager({
    helperImage,
    kubectl: async () => "{}",
  }));
  assert.equal(readDefaultStorageClass({ items: [{ metadata: { name: "local-path" } }] }), "local-path");
});

test("Kubernetes shared-assets manager seeds a labeled PVC then lists and removes it", async () => {
  const calls: string[][] = [];
  const kubectl = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "storageclass") {
      return JSON.stringify({ items: [{ metadata: { name: "local-path" } }] });
    }
    if (args[0] === "get" && args[1] === "pod") {
      return JSON.stringify({ status: { phase: "Running" } });
    }
    if (args[0] === "get" && args[1] === "pvc" && args[2] === claim) {
      return ownedPvc();
    }
    if (args[0] === "get" && args[1] === "pvc" && args.includes("-l")) {
      return JSON.stringify({ items: [JSON.parse(ownedPvc())] });
    }
    return "{}";
  };
  const manager = new KubernetesSharedAssetsVolumeManager({ helperImage, kubectl });
  const { directory, sourcePath } = await sourceFile();
  try {
    const name = await manager.prepare({
      jobId,
      files: [{ sourcePath, relativePath: "project/fixture.txt" }],
      catalog: { version: 1 },
    });
    assert.equal(name, claim);
    assert.ok(calls.some((args) => args[0] === "apply"));
    assert.ok(calls.some((args) => args[0] === "cp" && args[2]?.endsWith(":/assets")));
    const listed = await manager.listManaged();
    assert.deepEqual(listed, [{ volumeName: claim, jobId, createdAt: "2026-08-28T00:00:00Z" }]);
    await manager.removeForJob(jobId);
    assert.ok(calls.some((args) => args[0] === "delete" && args[1] === "pvc"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Kubernetes shared-assets manager refuses a PVC it does not own", async () => {
  const manager = new KubernetesSharedAssetsVolumeManager({
    helperImage,
    kubectl: async (args) => {
      if (args[0] === "get" && args[1] === "pvc") {
        return JSON.stringify({ metadata: { name: claim, labels: { [SHARED_ASSETS_VOLUME_LABEL]: "true", [SHARED_ASSETS_JOB_LABEL]: "other" } } });
      }
      return "{}";
    },
  });
  await assert.rejects(() => manager.removeForJob(jobId), /调度器管理卷/);
});
