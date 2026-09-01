/**
 * Live Kubernetes + Kata shared-assets proof (#162). Independent of isolation smoke.
 * Uses KubernetesSharedAssetsVolumeManager so the product path, not a one-off
 * seeder, owns the PVC. leftover=0.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KubernetesSharedAssetsVolumeManager, readDefaultStorageClass } from "./kubernetes-shared-assets-volume.js";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import {
  findKataWorkload,
  OPENSANDBOX_K8S_NAMESPACE,
  probeKataCluster,
  waitForRemainingJobPods,
  type KubectlJson,
} from "./opensandbox-k8s-poc.js";
import { OPENSANDBOX_POC_CONTRACT, OPENSANDBOX_POC_IMAGE } from "./opensandbox-poc.js";
import { SHARED_ASSETS_MOUNT_PATH } from "./runtime-shared.js";
import { managedSharedAssetsVolumeName } from "./shared-assets-volume.js";

const SEED_NAME = "poc-seed.txt";

export function shouldRunOpenSandboxK8sAssetsPoc(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_SANDBOX_POC === "1"
    && env.OPEN_SANDBOX_POC_K8S === "1"
    && env.OPEN_SANDBOX_POC_K8S_ASSETS === "1";
}

export function sharedAssetsClaimName(jobId: string): string {
  return managedSharedAssetsVolumeName(jobId);
}

export { readDefaultStorageClass };

export function readPvcPhase(pvc: unknown): string {
  return pvc && typeof pvc === "object" && "status" in pvc
    ? String((pvc as { status?: { phase?: unknown } }).status?.phase ?? "")
    : "";
}

export function findRemainingJobClaims(pvcs: unknown, jobId: string): number {
  const items = pvcs && typeof pvcs === "object" && Array.isArray((pvcs as { items?: unknown }).items)
    ? (pvcs as { items: unknown[] }).items
    : [];
  return items.filter((item) => JSON.stringify(item).includes(jobId)).length;
}

function kubectlExec(kubectl: KubectlJson) {
  return async (args: string[]) => {
    const value = await kubectl(args);
    if (value && typeof value === "object" && "raw" in value) return String((value as { raw?: unknown }).raw ?? "");
    return JSON.stringify(value ?? {});
  };
}

export async function runOpenSandboxK8sAssetsPoc(
  client: OpenSandboxClient,
  kubectl: KubectlJson,
  input: { image?: string; expectedContract?: string; timeoutMs?: number },
): Promise<{
  kata: true;
  mounted: true;
  seedOk: true;
  readonly: true;
  leftovers: 0;
  leftoverPods: 0;
  leftoverPvcs: 0;
}> {
  await probeKataCluster(kubectl);
  readDefaultStorageClass(await kubectl(["get", "storageclass", "-o", "json"]));
  const image = input.image ?? OPENSANDBOX_POC_IMAGE;
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const staging = await mkdtemp(path.join(os.tmpdir(), "os-kata-assets-"));
  const seedPath = path.join(staging, SEED_NAME);
  await writeFile(seedPath, "seed\n");
  const assets = new KubernetesSharedAssetsVolumeManager({
    namespace: OPENSANDBOX_K8S_NAMESPACE,
    helperImage: image,
    kubectl: kubectlExec(kubectl),
  });
  const claimName = await assets.prepare({
    jobId,
    files: [{ sourcePath: seedPath, relativePath: SEED_NAME }],
    catalog: { jobId },
  });
  if (!claimName) throw new Error("OPENSANDBOX_POC_K8S_ASSETS_PREPARE");
  const runner = new OpenSandboxRunner(client);
  try {
    const handle = await runner.provision({
      jobId,
      attemptId,
      image,
      network: "none",
      expectedContract: input.expectedContract ?? OPENSANDBOX_POC_CONTRACT,
      kubernetesResources: true,
      sharedAssetsMount: { volumeName: claimName },
      limits: { cpu: 0.3, memoryMiB: 256, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
    });
    try {
      findKataWorkload(
        await kubectl(["get", "pods", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
        jobId,
      );
      const host = await runner.ensureHost(handle);
      const mounted = await host.run(`test -d ${SHARED_ASSETS_MOUNT_PATH} && echo mounted`, { timeoutMs: 8_000 });
      if (mounted.exitCode !== 0 || !mounted.stdout.includes("mounted")) {
        throw new Error(`OPENSANDBOX_POC_K8S_ASSETS_UNMOUNTED: ${mounted.stderr.trim() || mounted.stdout.trim()}`);
      }
      const seed = await host.run(`cat ${SHARED_ASSETS_MOUNT_PATH}/${SEED_NAME}`, { timeoutMs: 8_000 });
      if (seed.exitCode !== 0 || !seed.stdout.includes("seed")) {
        throw new Error(`OPENSANDBOX_POC_K8S_ASSETS_SEED: ${seed.stderr.trim() || seed.stdout.trim()}`);
      }
      const write = await host.run(`touch ${SHARED_ASSETS_MOUNT_PATH}/poc-write`, { timeoutMs: 8_000 });
      if (write.exitCode === 0) throw new Error("OPENSANDBOX_POC_K8S_ASSETS_WRITABLE");
    } finally {
      await runner.destroy(handle).catch(() => {});
      const leftovers = await runner.listResources({ jobId, attemptId });
      if (leftovers.length > 0) {
        throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
      }
      const remaining = await waitForRemainingJobPods(kubectl, jobId);
      if (remaining > 0) throw new Error(`OPENSANDBOX_POC_KATA_POD_LEFTOVER: ${remaining}`);
    }
    return {
      kata: true,
      mounted: true,
      seedOk: true,
      readonly: true,
      leftovers: 0,
      leftoverPods: 0,
      leftoverPvcs: 0,
    };
  } finally {
    await assets.removeForJob(jobId).catch(() => {});
    const leftoverPvcs = findRemainingJobClaims(
      await kubectl(["get", "pvc", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]).catch(() => ({ items: [] })),
      jobId,
    );
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (leftoverPvcs > 0) throw new Error(`OPENSANDBOX_POC_K8S_PVC_LEFTOVER: ${leftoverPvcs}`);
  }
}
