/**
 * Scheduler-owned shared assets on Kubernetes. Creates a labeled PVC, seeds it
 * from the trusted host, then OpenSandbox mounts it read-only.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL } from "./runtime-shared.js";
import {
  managedSharedAssetsVolumeName,
  type SharedAssetVolumeFile,
  type SharedAssetsVolumeManager,
} from "./shared-assets-volume.js";

const DEFAULT_NAMESPACE = "deepsonar-opensandbox";

const execFileP = promisify(execFile);
const IMMUTABLE_OCI_REF_RE = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?\/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;

export type KubectlExec = (args: string[]) => Promise<string>;

function defaultKubectl(kubeconfig: string): KubectlExec {
  return async (args) => {
    const { stdout } = await execFileP("kubectl", args, {
      env: { ...process.env, KUBECONFIG: kubeconfig },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  };
}

function parseJson(text: string): unknown {
  if (!text) return {};
  return (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) as unknown : { raw: text };
}

export function readDefaultStorageClass(storage: unknown): string {
  const items = storage && typeof storage === "object" && Array.isArray((storage as { items?: unknown }).items)
    ? (storage as { items: Array<{ metadata?: { name?: string } }> }).items
    : [];
  const names = items.map((item) => item.metadata?.name).filter((name): name is string => Boolean(name));
  if (names.length === 0) throw new Error("OPENSANDBOX_POC_K8S_STORAGECLASS_MISSING");
  return names.includes("local-path") ? "local-path" : names[0];
}

function readPhase(resource: unknown): string {
  return resource && typeof resource === "object" && "status" in resource
    ? String((resource as { status?: { phase?: unknown } }).status?.phase ?? "")
    : "";
}

function isMissing(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /not found|NotFound/i.test(detail);
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 320 || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid shared-assets volume path");
  }
  return normalized;
}

function seederName(jobId: string): string {
  return `deepsonar-assets-seeder-${jobId.slice(0, 8)}`;
}

export class KubernetesSharedAssetsVolumeManager implements SharedAssetsVolumeManager {
  private readonly namespace: string;
  private readonly helperImage: string;
  private readonly kubectl: KubectlExec;

  constructor(input: { namespace?: string; helperImage: string; kubeconfig?: string; kubectl?: KubectlExec }) {
    if (!IMMUTABLE_OCI_REF_RE.test(input.helperImage)) {
      throw new Error("共享资产 helper 镜像必须是带小写 sha256 digest 的不可变 OCI 引用");
    }
    this.namespace = input.namespace ?? DEFAULT_NAMESPACE;
    this.helperImage = input.helperImage;
    this.kubectl = input.kubectl ?? defaultKubectl(input.kubeconfig ?? "");
    if (!input.kubectl && !input.kubeconfig?.trim()) {
      throw new Error("OPEN_SANDBOX_KUBECONFIG 或 KUBECONFIG 在 Kubernetes 共享资产路径上必填");
    }
  }

  async prepare(input: { jobId: string; files: SharedAssetVolumeFile[]; catalog: unknown }): Promise<string | null> {
    if (input.files.length === 0) return null;
    const name = managedSharedAssetsVolumeName(input.jobId);
    const jobId = name.slice("deepsonar-assets-".length);
    const seed = seederName(jobId);
    await this.removeForJob(jobId);
    const storageClass = readDefaultStorageClass(parseJson(await this.kubectl(["get", "storageclass", "-o", "json"])));
    const staging = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-k8s-"));
    try {
      for (const file of input.files) {
        const relative = safeRelativePath(file.relativePath);
        const target = path.join(staging, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(file.sourcePath, target, { force: false, errorOnExist: true });
      }
      await writeFile(path.join(staging, "catalog.json"), `${JSON.stringify(input.catalog, null, 2)}\n`, { flag: "wx" });
      const pvcPath = path.join(staging, "pvc.yaml");
      const seederPath = path.join(staging, "seeder.yaml");
      await writeFile(pvcPath, this.pvcManifest(name, jobId, storageClass));
      await writeFile(seederPath, this.seederManifest(name, jobId, seed));
      await this.kubectl(["apply", "-f", pvcPath, "-o", "json"]);
      await this.kubectl(["apply", "-f", seederPath, "-o", "json"]);
      await this.waitPhase(["pod", seed], "Running");
      await this.kubectl(["cp", `${staging}/.`, `${this.namespace}/${seed}:/assets`]);
      await this.deleteNamed(["pod", seed]);
      return name;
    } catch (error) {
      await this.deleteNamed(["pod", seed]).catch(() => {});
      await this.deleteNamed(["pvc", name]).catch(() => {});
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async removeForJob(jobId: string): Promise<void> {
    const name = managedSharedAssetsVolumeName(jobId);
    let pvc: unknown;
    try {
      pvc = parseJson(await this.kubectl(["get", "pvc", name, "-n", this.namespace, "-o", "json"]));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const labels = pvc && typeof pvc === "object" && "metadata" in pvc
      ? (pvc as { metadata?: { labels?: Record<string, string> } }).metadata?.labels ?? {}
      : {};
    if (labels[SHARED_ASSETS_VOLUME_LABEL] !== "true" || labels[SHARED_ASSETS_JOB_LABEL] !== name.slice("deepsonar-assets-".length)) {
      throw new Error("共享资产 PVC 不是该 Job 的调度器管理卷");
    }
    await this.deleteNamed(["pvc", name]);
  }

  async listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string }>> {
    const listed = parseJson(await this.kubectl([
      "get", "pvc", "-n", this.namespace, "-l", `${SHARED_ASSETS_VOLUME_LABEL}=true`, "-o", "json",
    ]));
    const items = listed && typeof listed === "object" && Array.isArray((listed as { items?: unknown }).items)
      ? (listed as { items: Array<{ metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: string } }> }).items
      : [];
    return items.flatMap((item) => {
      const volumeName = item.metadata?.name ?? "";
      const jobId = item.metadata?.labels?.[SHARED_ASSETS_JOB_LABEL] ?? "";
      if (!volumeName || jobId !== volumeName.slice("deepsonar-assets-".length)) return [];
      return [{
        volumeName,
        jobId,
        ...(item.metadata?.creationTimestamp ? { createdAt: item.metadata.creationTimestamp } : {}),
      }];
    });
  }

  private pvcManifest(name: string, jobId: string, storageClass: string): string {
    return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}
  namespace: ${this.namespace}
  labels:
    ${SHARED_ASSETS_VOLUME_LABEL}: "true"
    ${SHARED_ASSETS_JOB_LABEL}: "${jobId}"
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: 64Mi
`;
  }

  private seederManifest(claimName: string, jobId: string, seed: string): string {
    return `apiVersion: v1
kind: Pod
metadata:
  name: ${seed}
  namespace: ${this.namespace}
  labels:
    ${SHARED_ASSETS_VOLUME_LABEL}: "true"
    ${SHARED_ASSETS_JOB_LABEL}: "${jobId}"
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: ${this.helperImage}
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
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
        claimName: ${claimName}
`;
  }

  private async waitPhase(resource: string[], phase: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const current = readPhase(parseJson(await this.kubectl(["get", ...resource, "-n", this.namespace, "-o", "json"])));
      if (current === phase) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`OPENSANDBOX_K8S_ASSETS_WAIT: ${resource.join("/")} ${phase}`);
  }

  private async deleteNamed(resource: string[]): Promise<void> {
    try {
      await this.kubectl(["get", ...resource, "-n", this.namespace, "-o", "json"]);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await this.kubectl(["delete", ...resource, "-n", this.namespace, "-o", "name"]);
  }
}
