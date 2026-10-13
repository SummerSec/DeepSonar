import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, managesHostDockerRuntime } from "./config.js";
import { sql } from "./db.js";
import { inc, setGauge } from "./metrics.js";
import { parseOciDigestRef } from "./runtime-images.js";

const execFileP = promisify(execFile);
const PROTECTED_JOB_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
  "failed",
  "timeout",
  "orphan",
] as const;
const IMAGE_GC_COMMAND_TIMEOUT_MS = 120_000;
const IMAGE_GC_MAX_BUFFER = 8 * 1024 * 1024;

type DockerCommand = (...args: string[]) => Promise<string>;

export interface RuntimeImageGcVersion {
  id: string;
  runtimeImageId: string;
  version: string;
  digest: string | null;
  promotedAt: string | Date | null;
  createdAt: string | Date;
  refs: string[];
}

export interface RuntimeImageGcPlan {
  protectedVersionIds: Set<string>;
  candidates: RuntimeImageGcVersion[];
}

function timestamp(value: string | Date | null): number {
  if (value === null) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeKnownRefs(version: RuntimeImageGcVersion): string[] {
  if (!version.digest || !/^sha256:[0-9a-f]{64}$/.test(version.digest)) return [];
  const refs = new Set<string>();
  for (const value of version.refs) {
    try {
      const parsed = parseOciDigestRef(value);
      if (parsed.digest === version.digest) refs.add(parsed.normalized);
    } catch {
      // A DB row without a provable named immutable ref is deliberately not removable.
    }
  }
  return [...refs].sort();
}

export function planRuntimeImageGc(
  versions: RuntimeImageGcVersion[],
  projectPinnedVersionIds: ReadonlySet<string>,
  activeJobVersionIds: ReadonlySet<string>,
): RuntimeImageGcPlan {
  const protectedVersionIds = new Set<string>([
    ...projectPinnedVersionIds,
    ...activeJobVersionIds,
  ]);
  const byProduct = new Map<string, RuntimeImageGcVersion[]>();
  for (const version of versions) {
    if (version.promotedAt) protectedVersionIds.add(version.id);
    const rows = byProduct.get(version.runtimeImageId) ?? [];
    rows.push(version);
    byProduct.set(version.runtimeImageId, rows);
  }
  for (const rows of byProduct.values()) {
    const newest = [...rows].sort((left, right) => {
      const leftRank = timestamp(left.promotedAt) || timestamp(left.createdAt);
      const rightRank = timestamp(right.promotedAt) || timestamp(right.createdAt);
      return rightRank - leftRank || right.id.localeCompare(left.id);
    });
    // Preserve current/latest and one immediate rollback version even if promotion metadata is incomplete.
    for (const version of newest.slice(0, 2)) protectedVersionIds.add(version.id);
  }
  return {
    protectedVersionIds,
    candidates: versions.filter((version) => !protectedVersionIds.has(version.id)),
  };
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", args, {
    shell: false,
    windowsHide: true,
    timeout: IMAGE_GC_COMMAND_TIMEOUT_MS,
    maxBuffer: IMAGE_GC_MAX_BUFFER,
  });
  return stdout.trim();
}

/**
 * #725: 删除错误分类。只有能够可靠确认“目标镜像已不存在”时才归为 `absent`（幂等成功）；
 * 进程级错误（CLI 缺失、超时/被杀）、权限不足与运行时不可达优先判定为真实失败，
 * 无法确认的输出一律 `unknown`（fail closed，仍计入 failed）。
 */
export type RuntimeImageGcErrorKind =
  | "absent"
  | "in_use"
  | "permission"
  | "unreachable"
  | "timeout"
  | "unknown";

interface CommandErrorShape {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  message?: unknown;
}

function commandErrorDetail(error: unknown): string {
  const value = (error ?? {}) as CommandErrorShape;
  return [value.stderr, value.stdout, value.message, typeof error === "string" ? error : ""]
    .map((part) => String(part ?? ""))
    .join("\n");
}

/** Docker：`No such image` / `reference does not exist`；Podman：`image not known`（旧版 `no such image`）。 */
const ABSENT_LINE_PATTERN = /\bno such image\b|\bimage not known\b|\breference does not exist\b/i;
/** Podman 多错误汇总头，例如 `Error: 2 errors occurred:`，本身不携带语义。 */
const MULTI_ERROR_HEADER_PATTERN = /^(?:error:\s*)?\d+ errors? occurred:?$/i;
const PERMISSION_PATTERN = /permission denied|operation not permitted|access denied|\beacces\b|\beperm\b/i;
const UNREACHABLE_PATTERN = new RegExp(
  [
    "cannot connect to (?:the )?docker daemon",
    "is the docker daemon running",
    "error during connect",
    "unable to connect to podman",
    "cannot connect to podman",
    "connection refused",
    "dial unix",
    "no such file or directory",
    "context deadline exceeded",
    "i/o timeout",
  ].join("|"),
  "i",
);
const IN_USE_PATTERN = new RegExp(
  [
    // Docker
    "image is being used by",
    "used by (?:running |stopped )?container",
    "conflict: unable to delete",
    // Podman
    "image is in use by a container",
    "image used by [0-9a-f]{12,}",
  ].join("|"),
  "i",
);

/**
 * “不存在”必须由运行时的每一条错误行共同确认；混入任何其他错误（例如 Podman 多错误汇总里
 * 夹带的权限或存储错误）都不算已不存在。
 */
function isConfirmedAbsent(error: unknown): boolean {
  const value = (error ?? {}) as CommandErrorShape;
  const stderr = String(value.stderr ?? "").trim();
  const source = stderr || String(value.message ?? (typeof error === "string" ? error : "")).trim();
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*•-]+/, "").trim())
    .filter((line) => line.length > 0)
    // Node execFile 的 message 首行是 `Command failed: <cmd>`，不是运行时输出。
    .filter((line) => !/^command failed:/i.test(line))
    .filter((line) => !MULTI_ERROR_HEADER_PATTERN.test(line));
  return lines.length > 0 && lines.every((line) => ABSENT_LINE_PATTERN.test(line));
}

export function classifyRuntimeImageGcError(error: unknown): RuntimeImageGcErrorKind {
  const value = (error ?? {}) as CommandErrorShape;
  if (value.killed === true || (typeof value.signal === "string" && value.signal) || value.code === "ETIMEDOUT") {
    return "timeout";
  }
  // 字符串 code 是 spawn/系统调用失败（ENOENT=CLI 不存在、EACCES 等），从来不是运行时“镜像不存在”。
  if (typeof value.code === "string") {
    if (value.code === "EACCES" || value.code === "EPERM") return "permission";
    if (value.code === "ENOENT" || value.code === "ECONNREFUSED") return "unreachable";
    return "unknown";
  }
  if (typeof value.code === "number" && value.code === 0) return "unknown";
  const detail = commandErrorDetail(error);
  if (PERMISSION_PATTERN.test(detail)) return "permission";
  if (UNREACHABLE_PATTERN.test(detail)) return "unreachable";
  if (IN_USE_PATTERN.test(detail)) return "in_use";
  if (isConfirmedAbsent(error)) return "absent";
  return "unknown";
}

class RuntimeImageGcCommandError extends Error {
  constructor(
    readonly kind: RuntimeImageGcErrorKind,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

export interface RuntimeImageGcExecutionResult {
  candidates: number;
  /** 本轮确实删除了至少一个 DB 已知不可变引用的版本数。 */
  deleted: number;
  /** 所有已知引用都被运行时明确确认为不存在的版本数（幂等成功，不计入 failed）。 */
  alreadyAbsent: number;
  retainedInUse: number;
  failed: number;
  unsafeRef: number;
}

export async function executeRuntimeImageGcPlan(
  plan: RuntimeImageGcPlan,
  executeDocker: DockerCommand = docker,
): Promise<RuntimeImageGcExecutionResult> {
  let deleted = 0;
  let alreadyAbsent = 0;
  let retainedInUse = 0;
  let failed = 0;
  let unsafeRef = 0;
  const run = async (...args: string[]): Promise<string> => {
    try {
      return await executeDocker(...args);
    } catch (error) {
      throw new RuntimeImageGcCommandError(classifyRuntimeImageGcError(error), error);
    }
  };
  for (const candidate of plan.candidates) {
    const refs = safeKnownRefs(candidate);
    if (refs.length === 0) {
      unsafeRef += 1;
      inc("deepsonar_runtime_image_gc_failures_total", { reason: "unsafe_ref" });
      continue;
    }
    try {
      let inUse = false;
      for (const ref of refs) {
        let containers: string;
        try {
          containers = await run("ps", "-aq", "--filter", `ancestor=${ref}`);
        } catch (error) {
          // 镜像已不存在时部分运行时会让 ancestor 过滤报错；继续走非 force 删除，
          // 真实占用仍由运行时拒绝删除来兜底。
          if (error instanceof RuntimeImageGcCommandError && error.kind === "absent") continue;
          throw error;
        }
        if (containers.trim()) {
          inUse = true;
          break;
        }
      }
      if (inUse) {
        retainedInUse += 1;
        continue;
      }
      let removedRefs = 0;
      for (const ref of refs) {
        try {
          await run("image", "rm", ref);
          removedRefs += 1;
        } catch (error) {
          // 检查后被并发删除，或同一镜像的另一个引用已在前一步一并移除。
          if (error instanceof RuntimeImageGcCommandError && error.kind === "absent") continue;
          throw error;
        }
      }
      if (removedRefs > 0) {
        deleted += 1;
        inc("deepsonar_runtime_image_gc_removed_total");
      } else {
        alreadyAbsent += 1;
        inc("deepsonar_runtime_image_gc_already_absent_total");
      }
    } catch (error) {
      const kind = error instanceof RuntimeImageGcCommandError ? error.kind : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      // docker image rm is intentionally non-force; a container race therefore retains the image.
      if (kind === "in_use") {
        retainedInUse += 1;
        console.warn(`[runtime-image-gc] retained ${candidate.id} (in_use):`, message);
      } else {
        failed += 1;
        inc("deepsonar_runtime_image_gc_failures_total", { reason: "docker" });
        console.error(`[runtime-image-gc] retained ${candidate.id} (${kind}):`, message);
      }
    }
  }
  setGauge("deepsonar_runtime_image_gc_candidates", plan.candidates.length);
  setGauge("deepsonar_runtime_image_gc_retained_in_use", retainedInUse);
  return {
    candidates: plan.candidates.length,
    deleted,
    alreadyAbsent,
    retainedInUse,
    failed,
    unsafeRef,
  };
}

/**
 * 汇总日志级别：真实失败/不安全引用用 warn；有实际删除或占用保留用 info；
 * 只有 alreadyAbsent（重复启动的常态）降为 debug，避免把已达成的清理目标报成故障。
 */
export function runtimeImageGcSummaryLevel(
  result: RuntimeImageGcExecutionResult,
): "warn" | "info" | "debug" | null {
  if (result.failed + result.unsafeRef > 0) return "warn";
  if (result.deleted + result.retainedInUse > 0) return "info";
  if (result.alreadyAbsent > 0) return "debug";
  return null;
}

export function formatRuntimeImageGcSummary(result: RuntimeImageGcExecutionResult): string {
  return [
    `candidates=${result.candidates}`,
    `deleted=${result.deleted}`,
    `alreadyAbsent=${result.alreadyAbsent}`,
    `retainedInUse=${result.retainedInUse}`,
    `failed=${result.failed}`,
    `unsafeRef=${result.unsafeRef}`,
  ].join(" ");
}

export async function runtimeImageGcOnce(
  executeDocker: DockerCommand = docker,
): Promise<RuntimeImageGcExecutionResult> {
  // #691: project pins removed; protect only live Job snapshots + active scans + promoted/recent.
  const projectPins: Array<{ selected_version_id: string }> = [];
  const [versionRows, jobRefs, activeScanRefs] = await Promise.all([
    sql<Array<{
      id: string;
      runtime_image_id: string;
      version: string;
      digest: string | null;
      promoted_at: string | Date | null;
      created_at: string | Date;
      refs: unknown;
    }>>`
      SELECT v.id, v.runtime_image_id, v.version, v.digest, v.promoted_at, v.created_at,
             COALESCE(
               jsonb_agg(DISTINCT known.ref) FILTER (WHERE known.ref IS NOT NULL),
               '[]'::jsonb
             ) AS refs
      FROM runtime_image_versions v
      LEFT JOIN LATERAL (
        SELECT v.image_ref AS ref
        UNION SELECT v.resolved_ref
        UNION SELECT r.image_ref FROM runtime_image_version_refs r WHERE r.version_id = v.id
        UNION SELECT r.resolved_ref FROM runtime_image_version_refs r WHERE r.version_id = v.id
      ) known ON true
      GROUP BY v.id`,
    sql<Array<{ version_id: string }>>`
      SELECT DISTINCT agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' AS version_id
      FROM jobs
      WHERE status = ANY(${[...PROTECTED_JOB_STATUSES]})
        AND agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' IS NOT NULL`,
    sql<Array<{ version_id: string }>>`
      SELECT DISTINCT runtime_image_version_id AS version_id
      FROM runtime_image_scans
      WHERE status IN ('queued','claimed','running')`,
  ]);
  const versions: RuntimeImageGcVersion[] = versionRows.map((row) => ({
    id: String(row.id),
    runtimeImageId: String(row.runtime_image_id),
    version: String(row.version),
    digest: row.digest ? String(row.digest) : null,
    promotedAt: row.promoted_at ?? null,
    createdAt: row.created_at,
    refs: Array.isArray(row.refs) ? row.refs.filter((value): value is string => typeof value === "string") : [],
  }));
  const plan = planRuntimeImageGc(
    versions,
    new Set(projectPins.map((row) => String(row.selected_version_id))),
    new Set([...jobRefs, ...activeScanRefs].map((row) => String(row.version_id))),
  );
  return executeRuntimeImageGcPlan(plan, executeDocker);
}

let gcRunning = false;

export function startRuntimeImageGc(): () => void {
  if (
    config.images.gcIntervalSec === 0
    || !managesHostDockerRuntime()
  ) {
    return () => {};
  }
  const run = () => {
    if (gcRunning) return;
    gcRunning = true;
    void runtimeImageGcOnce()
      .then((result) => {
        const level = runtimeImageGcSummaryLevel(result);
        if (!level) return;
        const line = `[runtime-image-gc] summary ${formatRuntimeImageGcSummary(result)}`;
        if (level === "warn") console.warn(line);
        else if (level === "info") console.log(line);
        else console.debug(line);
      })
      .catch((error) => {
        inc("deepsonar_runtime_image_gc_failures_total", { reason: "reconcile" });
        console.error("[runtime-image-gc]", error);
      })
      .finally(() => {
        gcRunning = false;
      });
  };
  run();
  const timer = setInterval(run, config.images.gcIntervalSec * 1000);
  return () => clearInterval(timer);
}
