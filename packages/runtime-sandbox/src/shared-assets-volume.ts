import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL, assertSharedAssetsVolumeOwnership } from "./runtime-shared.js";

const execFileP = promisify(execFile);
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_VOLUME_NAME_RE = /^deepsonar-assets-g([0-9a-f]{32})$/;
const VOLUME_REMOVE_MAX_ATTEMPTS = 3;
const VOLUME_REMOVE_RETRY_BASE_DELAY_MS = 100;
export const SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS = 60_000;
export const SHARED_ASSETS_GENERATION_LABEL = "deepsonar.shared_assets.generation";
const OCI_NAME_COMPONENT_RE = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const IMMUTABLE_OCI_REF_RE = new RegExp(
  `^(?:${OCI_NAME_COMPONENT_RE}(?::[0-9]+)?/)*${OCI_NAME_COMPONENT_RE}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`,
);

export const DEFAULT_SHARED_ASSETS_HELPER_IMAGE =
  "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";

/** Docker CLI 超时与普通命令失败使用稳定、可观测的错误类别区分。 */
export class DockerCommandTimeoutError extends Error {
  readonly code = "DOCKER_COMMAND_TIMEOUT";
  readonly command: readonly string[];
  readonly timeoutMs: number;

  constructor(command: readonly string[], timeoutMs: number, cause?: unknown) {
    super(`Docker 命令超时（${timeoutMs}ms）：docker ${command.join(" ")}`);
    this.name = "DockerCommandTimeoutError";
    this.command = [...command];
    this.timeoutMs = timeoutMs;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 识别 Node child_process 与测试替身产生的命令超时错误。 */
export function isDockerCommandTimeout(error: unknown): boolean {
  if (error instanceof DockerCommandTimeoutError) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; name?: unknown; killed?: unknown; signal?: unknown };
  return value.code === "ETIMEDOUT"
    || value.name === "TimeoutError"
    || (value.killed === true && value.signal === "SIGTERM");
}

async function docker(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("docker", args, {
      timeout: SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (isDockerCommandTimeout(error)) {
      throw new DockerCommandTimeoutError(args, SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS, error);
    }
    throw error;
  }
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

type AssertCurrent = () => Promise<void>;
interface PreparationInput {
  jobId: string;
  files: SharedAssetVolumeFile[];
  catalog: unknown;
  generation?: string;
  assertCurrent?: AssertCurrent;
}

export interface SharedAssetsVolumeManager {
  prepare(input: PreparationInput): Promise<string | null>;
  removeForJob(jobId: string, expectedGeneration?: string, assertCurrent?: AssertCurrent): Promise<void>;
  listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string; generation?: string }>>;
}

export function managedSharedAssetsVolumeName(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new Error("invalid shared-assets Job id");
  return `deepsonar-assets-${jobId.toLowerCase()}`;
}

function volumeName(generation: string): string {
  if (!JOB_ID_RE.test(generation)) throw new Error("invalid shared-assets generation");
  return `deepsonar-assets-g${generation.toLowerCase().replaceAll("-", "")}`;
}

function helperName(generation: string): string {
  return `deepsonar-assets-writer-g${generation.toLowerCase().replaceAll("-", "")}`;
}

interface SharedAssetsVolumeInspection {
  Name?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Labels?: unknown;
  CreatedAt?: unknown;
}

function generationOf(labels: unknown): string | null {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return null;
  const generation = (labels as Record<string, unknown>)[SHARED_ASSETS_GENERATION_LABEL];
  return typeof generation === "string" && JOB_ID_RE.test(generation) ? generation : null;
}

function isManagedInspection(inspected: SharedAssetsVolumeInspection, name: string, jobId: string): boolean {
  try {
    assertSharedAssetsVolumeOwnership(inspected, name, jobId);
    const generation = generationOf(inspected.Labels);
    return generation !== null && volumeName(generation) === name;
  } catch {
    return false;
  }
}

function isMissingResourceError(error: unknown, kind: "volume" | "container", name: string): boolean {
  if (isDockerCommandTimeout(error)) return false;
  const stderr = error && typeof error === "object" && "stderr" in error
    ? (error as { stderr?: unknown }).stderr : undefined;
  const detail = typeof stderr === "string" && stderr.trim()
    ? stderr : error instanceof Error ? error.message : "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only an exact daemon diagnostic for this resource is authoritative absence.
  const patterns = [
    `^(?:Error response from daemon: |Error: )?(?:get ${escaped}: no such ${kind}|no such ${kind}:? ["']?${escaped}["']?)$`,
    `^(?:Error response from daemon: |Error: )no ${kind} with (?:name(?: or ID)?|ID) ["']?${escaped}["']? found(?:: no such ${kind})?$`,
  ];
  return patterns.some((pattern) => new RegExp(pattern, "i").test(detail.trim()));
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

  async prepare(input: PreparationInput): Promise<string | null> {
    if (input.files.length === 0) return null;
    const generation = (input.generation ?? randomUUID()).toLowerCase();
    const name = volumeName(generation);
    managedSharedAssetsVolumeName(input.jobId); // Validate Job identity without using it as a Docker resource name.
    const canonicalJobId = input.jobId.toLowerCase();
    const helper = helperName(generation);
    const permit = input.assertCurrent;
    await this.executeDocker("image", "inspect", this.helperImage);
    const labels = [
      "--label", `${SHARED_ASSETS_VOLUME_LABEL}=true`,
      "--label", `${SHARED_ASSETS_JOB_LABEL}=${canonicalJobId}`,
      "--label", `${SHARED_ASSETS_GENERATION_LABEL}=${generation}`,
    ];
    // Stage bytes before creating a volume that a helper could implicitly recreate.
    const staging = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-"));
    let helperCleanupRequired = false;
    let volumeCleanupRequired = false;
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
      await permit?.();
      volumeCleanupRequired = true; // A timed-out create can still have created our labeled volume.
      await this.executeDocker("volume", "create", "--driver", "local", ...labels, name);
      await this.requireVolume(name, canonicalJobId, generation);
      await permit?.();
      helperCleanupRequired = true;
      await this.executeDocker(
        "create", "--pull=never", "--name", helper, ...labels, "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--read-only", "-v", `${name}:/assets`,
        this.helperImage,
      );
      const writer = await this.inspectHelper(canonicalJobId, generation);
      if (!writer) throw new Error("shared assets helper disappeared during prepare");
      // Reject an implicit, unlabeled replacement before copying any bytes.
      await this.requireVolume(name, canonicalJobId, generation);
      await permit?.();
      await this.executeDocker("cp", `${staging}${path.sep}.`, `${writer.id}:/assets`);
      await this.requireVolume(name, canonicalJobId, generation);
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
    if (helperCleanupRequired) {
      try {
        await this.removeHelper(canonicalJobId, generation, permit);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
        volumeCleanupRequired = true;
      }
    }
    if (!primaryFailed && !cleanupFailed) {
      try {
        await this.requireVolume(name, canonicalJobId, generation);
        await permit?.();
        volumeCleanupRequired = false;
      } catch (error) {
        primaryFailed = true;
        primaryError = error;
      }
    }
    if (volumeCleanupRequired) {
      try {
        await this.removeVolumeWithRetry(name, canonicalJobId, generation, permit);
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
    if (primaryFailed && cleanupFailed) {
      throw new AggregateError([primaryError, cleanupError], "shared assets preparation and cleanup failed", { cause: primaryError });
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
    return name;
  }

  /** Scheduler callers must hold the Job lifecycle lock and re-check the Attempt first. */
  async removeForJob(jobId: string, expectedGeneration?: string, assertCurrent?: AssertCurrent): Promise<void> {
    managedSharedAssetsVolumeName(jobId);
    const canonicalJobId = jobId.toLowerCase();
    // Freeze names before checking the permit. Never adopt generations discovered after lock loss.
    const resources = expectedGeneration === undefined
      ? (await this.listManaged()).filter((item) => item.jobId === canonicalJobId)
      : [{ volumeName: volumeName(expectedGeneration), generation: expectedGeneration.toLowerCase() }];
    await assertCurrent?.();
    for (const resource of resources) {
      const generation = resource.generation!;
      const inspected = await this.inspectOwnedVolume(resource.volumeName, canonicalJobId, generation);
      await this.removeHelper(canonicalJobId, generation, assertCurrent);
      if (inspected) await this.removeVolumeWithRetry(resource.volumeName, canonicalJobId, generation, assertCurrent);
    }
  }

  private async inspectOwnedVolume(name: string, jobId: string, generation?: string): Promise<Record<string, unknown> | null> {
    const inspected = await this.inspectVolumeWithRetry(name);
    if (!inspected) return null;
    if (!isManagedInspection(inspected, name, jobId)) {
      throw new Error("共享资产卷不是该 Job 的本地调度器管理卷");
    }
    if (generation !== undefined && generationOf(inspected.Labels) !== generation) {
      throw new Error("shared assets volume generation changed");
    }
    return inspected;
  }

  private async requireVolume(name: string, jobId: string, generation: string): Promise<void> {
    if (!(await this.inspectOwnedVolume(name, jobId, generation))) {
      throw new Error("shared assets volume disappeared during prepare");
    }
  }

  private async inspectHelper(jobId: string, generation: string): Promise<{ id: string } | null> {
    const helper = helperName(generation);
    const inspected = await this.inspectResourceWithRetry("container", helper);
    if (!inspected) return null;
    const labels = (inspected.Config as { Labels?: Record<string, unknown> } | undefined)?.Labels;
    const observedGeneration = generationOf(labels);
    if (typeof inspected.Id !== "string" || !/^[0-9a-f]{64}$/i.test(inspected.Id)
      || (inspected.Name !== helper && inspected.Name !== `/${helper}`)
      || labels?.[SHARED_ASSETS_VOLUME_LABEL] !== "true" || labels?.[SHARED_ASSETS_JOB_LABEL] !== jobId
      || !observedGeneration || (generation !== undefined && generation !== observedGeneration)) {
      throw new Error("shared assets helper is not owned by this Job/generation");
    }
    return { id: inspected.Id };
  }

  private async removeHelper(jobId: string, generation: string, assertCurrent?: AssertCurrent): Promise<void> {
    const helper = await this.inspectHelper(jobId, generation);
    // Delete by daemon identity, never a name that could now identify a replacement.
    if (!helper) return;
    await assertCurrent?.();
    try {
      await this.executeDocker("rm", "-f", helper.id);
    } catch (error) {
      if (!isMissingResourceError(error, "container", helper.id)) throw error;
    }
  }

  async listManaged(): Promise<Array<{ volumeName: string; jobId: string; createdAt?: string; generation?: string }>> {
    const [labeledNames, prefixedNames] = await Promise.all([
      this.executeDocker("volume", "ls", "--filter", `label=${SHARED_ASSETS_VOLUME_LABEL}=true`, "--format", "{{.Name}}"),
      this.executeDocker("volume", "ls", "--filter", "name=deepsonar-assets-", "--format", "{{.Name}}"),
    ]);
    const names = new Set([
      ...labeledNames.split(/\r?\n/).filter(Boolean),
      ...prefixedNames.split(/\r?\n/).filter(Boolean),
    ]);
    const result: Array<{ volumeName: string; jobId: string; createdAt?: string; generation?: string }> = [];
    for (const name of names) {
      if (!MANAGED_VOLUME_NAME_RE.test(name)) continue;
      const inspected = await this.inspectVolumeWithRetry(name);
      const jobId = (inspected?.Labels as Record<string, unknown> | undefined)?.[SHARED_ASSETS_JOB_LABEL];
      if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)
        || !inspected || !isManagedInspection(inspected, name, jobId)) continue;
      result.push({
        volumeName: name,
        jobId,
        generation: generationOf(inspected.Labels)!,
        ...(typeof inspected.CreatedAt === "string" ? { createdAt: inspected.CreatedAt } : {}),
      });
    }
    return result;
  }

  private async removeVolumeWithRetry(name: string, jobId: string, generation: string, assertCurrent?: AssertCurrent): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= VOLUME_REMOVE_MAX_ATTEMPTS; attempt += 1) {
      // Ownership is re-read before EVERY remove, including retries after a busy volume.
      if (!(await this.inspectOwnedVolume(name, jobId, generation))) return;
      await assertCurrent?.();
      try {
        await this.executeDocker("volume", "rm", name); // Never force-detach a mounted volume.
        return;
      } catch (error) {
        if (isMissingResourceError(error, "volume", name)) return;
        lastError = error;
        if (attempt < VOLUME_REMOVE_MAX_ATTEMPTS) {
          await this.wait(VOLUME_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  private inspectVolumeWithRetry(name: string): Promise<Record<string, unknown> | null> {
    return this.inspectResourceWithRetry("volume", name);
  }

  private async inspectResourceWithRetry(kind: "volume" | "container", name: string): Promise<Record<string, unknown> | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= VOLUME_REMOVE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const inspected: unknown = JSON.parse(await this.executeDocker(kind, "inspect", name, "--format", "{{json .}}"));
        if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)) throw new Error(`invalid ${kind} inspect response`);
        return inspected as Record<string, unknown>;
      } catch (error) {
        if (isMissingResourceError(error, kind, name)) return null;
        lastError = error;
        if (attempt < VOLUME_REMOVE_MAX_ATTEMPTS) {
          await this.wait(VOLUME_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }
}
