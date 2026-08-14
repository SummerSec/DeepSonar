import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL, assertSharedAssetsVolumeOwnership } from "./agentbox.js";

const execFileP = promisify(execFile);
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_VOLUME_NAME_RE = /^deepsonar-assets-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const VOLUME_REMOVE_MAX_ATTEMPTS = 3;
const VOLUME_REMOVE_RETRY_BASE_DELAY_MS = 100;
const OCI_NAME_COMPONENT_RE = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const IMMUTABLE_OCI_REF_RE = new RegExp(
  `^(?:${OCI_NAME_COMPONENT_RE}(?::[0-9]+)?/)*${OCI_NAME_COMPONENT_RE}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`,
);

export const DEFAULT_SHARED_ASSETS_HELPER_IMAGE =
  "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

type DockerCommand = (...args: string[]) => Promise<string>;
type Sleep = (delayMs: number) => Promise<void>;

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export interface SharedAssetVolumeFile {
  sourcePath: string;
  relativePath: string;
}

export interface SharedAssetsVolumeManager {
  prepare(input: { jobId: string; files: SharedAssetVolumeFile[]; catalog: unknown }): Promise<string | null>;
  removeForJob(jobId: string): Promise<void>;
  listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string }>>;
}

function volumeName(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new Error("invalid shared-assets Job id");
  return `deepsonar-assets-${jobId.toLowerCase()}`;
}

function jobIdFromVolumeName(name: string): string | null {
  return MANAGED_VOLUME_NAME_RE.exec(name)?.[1] ?? null;
}

interface SharedAssetsVolumeInspection {
  Name?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Labels?: unknown;
  CreatedAt?: unknown;
}

function isManagedInspection(
  inspected: SharedAssetsVolumeInspection,
  name: string,
  jobId: string,
): boolean {
  if (inspected.Name !== name || inspected.Driver !== "local" || inspected.Scope !== "local") return false;
  const labelsValue = inspected.Labels;
  if (labelsValue !== undefined && labelsValue !== null && (typeof labelsValue !== "object" || Array.isArray(labelsValue))) {
    return false;
  }
  const labels = labelsValue && typeof labelsValue === "object"
    ? labelsValue as Record<string, unknown>
    : {};
  if (labels[SHARED_ASSETS_VOLUME_LABEL] !== undefined && labels[SHARED_ASSETS_VOLUME_LABEL] !== "true") return false;
  const labeledJobId = labels[SHARED_ASSETS_JOB_LABEL];
  if (labeledJobId !== undefined && (typeof labeledJobId !== "string" || !JOB_ID_RE.test(labeledJobId) || labeledJobId.toLowerCase() !== jobId)) {
    return false;
  }
  return true;
}

function isMissingVolumeError(error: unknown): boolean {
  const detail = error && typeof error === "object" && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return /no such volume|no volume with name .* found|volume .* (?:not found|does not exist)/i.test(`${message}\n${detail}`);
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 320 || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid shared-assets volume path");
  }
  return normalized;
}

export class NoopSharedAssetsVolumeManager implements SharedAssetsVolumeManager {
  async prepare(): Promise<null> { return null; }
  async removeForJob(): Promise<void> {}
  async listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string }>> { return []; }
}

export class DockerSharedAssetsVolumeManager implements SharedAssetsVolumeManager {
  constructor(
    private readonly helperImage: string,
    private readonly executeDocker: DockerCommand = docker,
    private readonly wait: Sleep = sleep,
  ) {
    if (!IMMUTABLE_OCI_REF_RE.test(helperImage)) {
      throw new Error("共享资产 helper 镜像必须是带小写 sha256 digest 的不可变 OCI 引用");
    }
  }

  async prepare(input: { jobId: string; files: SharedAssetVolumeFile[]; catalog: unknown }): Promise<string | null> {
    if (input.files.length === 0) return null;
    await this.executeDocker("image", "inspect", this.helperImage);
    const name = volumeName(input.jobId);
    const canonicalJobId = name.slice("deepsonar-assets-".length);
    const helper = `deepsonar-assets-writer-${canonicalJobId}`;
    await this.executeDocker("rm", "-f", helper).catch(() => "");
    await this.removeForJob(canonicalJobId);
    await this.executeDocker("volume", "create", "--driver", "local", "--label", `${SHARED_ASSETS_VOLUME_LABEL}=true`, "--label", `${SHARED_ASSETS_JOB_LABEL}=${canonicalJobId}`, name);
    const inspected = JSON.parse(await this.executeDocker("volume", "inspect", name, "--format", "{{json .}}")) as Record<string, unknown>;
    assertSharedAssetsVolumeOwnership(inspected, name, canonicalJobId);

    const staging = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-"));
    let helperCleanupRequired = false;
    let volumeCleanupRequired = true;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      for (const file of input.files) {
        const relative = safeRelativePath(file.relativePath);
        const target = path.join(staging, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(file.sourcePath, target, { force: false, errorOnExist: true });
      }
      await writeFile(path.join(staging, "catalog.json"), `${JSON.stringify(input.catalog, null, 2)}\n`, { flag: "wx" });
      helperCleanupRequired = true;
      await this.executeDocker(
        "create", "--pull=never", "--name", helper, "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--read-only", "-v", `${name}:/assets`,
        this.helperImage,
      );
      await this.executeDocker("cp", `${staging}${path.sep}.`, `${helper}:/assets`);
      volumeCleanupRequired = false;
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
    if (helperCleanupRequired) {
      try {
        await this.executeDocker("rm", "-f", helper);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
        volumeCleanupRequired = true;
      }
    }
    if (volumeCleanupRequired) {
      try {
        await this.removeVolumeWithRetry(name);
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }
    try {
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
    return name;
  }

  async removeForJob(jobId: string): Promise<void> {
    const name = volumeName(jobId);
    const inspected = await this.inspectVolumeWithRetry(name);
    if (!inspected) return;
    const canonicalJobId = name.slice("deepsonar-assets-".length);
    if (!isManagedInspection(inspected, name, canonicalJobId)) {
      throw new Error("共享资产卷不是该 Job 的本地调度器管理卷");
    }
    await this.removeVolumeWithRetry(name);
  }

  async listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string }>> {
    const [labeledNames, prefixedNames] = await Promise.all([
      this.executeDocker("volume", "ls", "--filter", `label=${SHARED_ASSETS_VOLUME_LABEL}=true`, "--format", "{{.Name}}"),
      this.executeDocker("volume", "ls", "--filter", "name=deepsonar-assets-", "--format", "{{.Name}}"),
    ]);
    const names = new Set([
      ...labeledNames.split(/\r?\n/).filter(Boolean),
      ...prefixedNames.split(/\r?\n/).filter(Boolean),
    ]);
    const result: Array<{ volumeName: string; jobId: string; createdAt?: string }> = [];
    for (const name of names) {
      const jobId = jobIdFromVolumeName(name);
      if (!jobId) continue;
      let inspected: SharedAssetsVolumeInspection;
      try {
        inspected = JSON.parse(await this.executeDocker("volume", "inspect", name, "--format", "{{json .}}")) as SharedAssetsVolumeInspection;
      } catch {
        continue;
      }
      if (!isManagedInspection(inspected, name, jobId)) continue;
      result.push({
        volumeName: name,
        jobId,
        ...(typeof inspected.CreatedAt === "string" ? { createdAt: inspected.CreatedAt } : {}),
      });
    }
    return result;
  }

  private async removeVolumeWithRetry(name: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= VOLUME_REMOVE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.executeDocker("volume", "rm", "-f", name);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < VOLUME_REMOVE_MAX_ATTEMPTS) {
          await this.wait(VOLUME_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  private async inspectVolumeWithRetry(name: string): Promise<Record<string, unknown> | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= VOLUME_REMOVE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return JSON.parse(
          await this.executeDocker("volume", "inspect", name, "--format", "{{json .}}"),
        ) as Record<string, unknown>;
      } catch (error) {
        if (isMissingVolumeError(error)) return null;
        lastError = error;
        if (attempt < VOLUME_REMOVE_MAX_ATTEMPTS) {
          await this.wait(VOLUME_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }
}
