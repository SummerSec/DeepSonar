/**
 * Live Kubernetes + Kata shared-assets proof (#162). Independent of isolation smoke.
 * Scheduler owns the PVC; OpenSandbox only mounts it read-only. leftover=0.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import { OPENSANDBOX_POC_CONTRACT, OPENSANDBOX_POC_IMAGE } from "./opensandbox-poc.js";
import {
  findKataWorkload,
  OPENSANDBOX_K8S_NAMESPACE,
  probeKataCluster,
  waitForRemainingJobPods,
  type KubectlJson,
} from "./opensandbox-k8s-poc.js";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_MOUNT_PATH, SHARED_ASSETS_VOLUME_LABEL } from "./runtime-shared.js";

const SEED_NAME = "poc-seed.txt";

export function shouldRunOpenSandboxK8sAssetsPoc(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_SANDBOX_POC === "1"
    && env.OPEN_SANDBOX_POC_K8S === "1"
    && env.OPEN_SANDBOX_POC_K8S_ASSETS === "1";
}

export function sharedAssetsClaimName(jobId: string): string {
  const id = jobId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("OPENSANDBOX_POC_K8S_ASSETS_JOB");
  }
  return `deepsonar-assets-${id}`;
}

export function readDefaultStorageClass(storage: unknown): string {
  const items = storage && typeof storage === "object" && Array.isArray((storage as { items?: unknown }).items)
    ? (storage as { items: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }> }).items
    : [];
  const names = items.map((item) => item.metadata?.name).filter((name): name is string => Boolean(name));
  if (names.length === 0) throw new Error("OPENSANDBOX_POC_K8S_STORAGECLASS_MISSING");
  return names.includes("local-path") ? "local-path" : names[0];
}

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

export function readSeederSucceeded(pod: unknown): boolean {
  return Boolean(
    pod && typeof pod === "object" && "status" in pod
    && (pod as { status?: { phase?: string } }).status?.phase === "Succeeded",
  );
}

function assetsManifests(input: { claimName: string; jobId: string; seederName: string; image: string; storageClass: string }): Record<"pvc" | "seeder", string> {
  return {
    pvc: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${input.claimName}
  namespace: ${OPENSANDBOX_K8S_NAMESPACE}
  labels:
    ${SHARED_ASSETS_VOLUME_LABEL}: "true"
    ${SHARED_ASSETS_JOB_LABEL}: "${input.jobId}"
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ${input.storageClass}
  resources:
    requests:
      storage: 64Mi
`,
    seeder: `apiVersion: v1
kind: Pod
metadata:
  name: ${input.seederName}
  namespace: ${OPENSANDBOX_K8S_NAMESPACE}
  labels:
    ${SHARED_ASSETS_VOLUME_LABEL}: "true"
    ${SHARED_ASSETS_JOB_LABEL}: "${input.jobId}"
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: ${input.image}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo seed > /assets/${SEED_NAME}"]
      volumeMounts:
        - name: assets
          mountPath: /assets
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 128Mi
  volumes:
    - name: assets
      persistentVolumeClaim:
        claimName: ${input.claimName}
`,
  };
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(label);
}

async function deleteNamed(kubectl: KubectlJson, args: string[]): Promise<void> {
  try {
    await kubectl(["get", ...args, "-o", "json"]);
  } catch {
    return;
  }
  await kubectl(["delete", ...args, "-o", "name"]);
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
  const storageClass = readDefaultStorageClass(await kubectl(["get", "storageclass", "-o", "json"]));
  const image = input.image ?? OPENSANDBOX_POC_IMAGE;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const claimName = sharedAssetsClaimName(jobId);
  const seederName = `deepsonar-assets-seeder-${jobId.slice(0, 8)}`;
  const staging = await mkdtemp(path.join(os.tmpdir(), "os-kata-assets-"));
  const manifests = assetsManifests({ claimName, jobId, seederName, image, storageClass });
  for (const [name, body] of Object.entries(manifests)) {
    const manifestPath = path.join(staging, `${name}.yaml`);
    await writeFile(manifestPath, body);
    await kubectl(["apply", "-f", manifestPath, "-o", "json"]);
  }
  const runner = new OpenSandboxRunner(client);
  try {
    await waitFor("OPENSANDBOX_POC_K8S_ASSETS_SEEDER", async () => (
      readSeederSucceeded(await kubectl(["get", "pod", seederName, "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]))
    ), timeoutMs);
    await deleteNamed(kubectl, ["pod", seederName, "-n", OPENSANDBOX_K8S_NAMESPACE]);
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
    await deleteNamed(kubectl, ["pod", seederName, "-n", OPENSANDBOX_K8S_NAMESPACE]).catch(() => {});
    await deleteNamed(kubectl, ["pvc", claimName, "-n", OPENSANDBOX_K8S_NAMESPACE]).catch(() => {});
    const leftoverPvcs = findRemainingJobClaims(
      await kubectl(["get", "pvc", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]).catch(() => ({ items: [] })),
      jobId,
    );
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (leftoverPvcs > 0) throw new Error(`OPENSANDBOX_POC_K8S_PVC_LEFTOVER: ${leftoverPvcs}`);
  }
}
