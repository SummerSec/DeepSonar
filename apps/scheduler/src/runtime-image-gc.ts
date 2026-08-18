import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { sql } from "./db.js";
import { inc, setGauge } from "./metrics.js";
import { parseOciDigestRef } from "./runtime-images.js";

const execFileP = promisify(execFile);
const ACTIVE_OR_QUEUED_JOB_STATUSES = ["pending", "claimed", "provisioning", "running", "waiting_human"] as const;
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

function isNoSuchImage(error: unknown): boolean {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const detail = [value?.stderr, value?.stdout, value?.message, error]
    .map((part) => String(part ?? ""))
    .join("\n");
  return /no such image|image .* (?:not found|does not exist)/i.test(detail);
}

function isImageInUse(error: unknown): boolean {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const detail = [value?.stderr, value?.stdout, value?.message, error]
    .map((part) => String(part ?? ""))
    .join("\n");
  return /image is being used by|used by (?:running )?container|conflict: unable to delete/i.test(detail);
}

export interface RuntimeImageGcExecutionResult {
  candidates: number;
  removed: number;
  retainedInUse: number;
  failed: number;
  unsafeRef: number;
}

export async function executeRuntimeImageGcPlan(
  plan: RuntimeImageGcPlan,
  executeDocker: DockerCommand = docker,
): Promise<RuntimeImageGcExecutionResult> {
  let removed = 0;
  let retainedInUse = 0;
  let failed = 0;
  let unsafeRef = 0;
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
        if ((await executeDocker("ps", "-aq", "--filter", `ancestor=${ref}`)).trim()) {
          inUse = true;
          break;
        }
      }
      if (inUse) {
        retainedInUse += 1;
        continue;
      }
      let removedAny = false;
      for (const ref of refs) {
        try {
          await executeDocker("image", "rm", ref);
          removedAny = true;
        } catch (error) {
          if (!isNoSuchImage(error)) throw error;
        }
      }
      if (removedAny) {
        removed += 1;
        inc("deepsonar_runtime_image_gc_removed_total");
      }
    } catch (error) {
      // docker image rm is intentionally non-force; a container race therefore retains the image.
      if (isImageInUse(error)) {
        retainedInUse += 1;
      } else {
        failed += 1;
        inc("deepsonar_runtime_image_gc_failures_total", { reason: "docker" });
      }
      console.error(
        `[runtime-image-gc] retained ${candidate.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  setGauge("deepsonar_runtime_image_gc_candidates", plan.candidates.length);
  setGauge("deepsonar_runtime_image_gc_retained_in_use", retainedInUse);
  return { candidates: plan.candidates.length, removed, retainedInUse, failed, unsafeRef };
}

export async function runtimeImageGcOnce(
  executeDocker: DockerCommand = docker,
): Promise<RuntimeImageGcExecutionResult> {
  const [versionRows, projectPins, activeJobRefs] = await Promise.all([
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
    sql<Array<{ selected_version_id: string }>>`
      SELECT DISTINCT selected_version_id
      FROM project_runtime_images
      WHERE selected_version_id IS NOT NULL`,
    sql<Array<{ version_id: string }>>`
      SELECT DISTINCT agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' AS version_id
      FROM jobs
      WHERE status = ANY(${[...ACTIVE_OR_QUEUED_JOB_STATUSES]})
        AND agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' IS NOT NULL`,
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
    new Set(activeJobRefs.map((row) => String(row.version_id))),
  );
  return executeRuntimeImageGcPlan(plan, executeDocker);
}

let gcRunning = false;

export function startRuntimeImageGc(): () => void {
  if (
    config.images.gcIntervalSec === 0
    || config.runtime.agentMode !== "real"
    || config.runtime.provider !== "local-docker"
  ) {
    return () => {};
  }
  const run = () => {
    if (gcRunning) return;
    gcRunning = true;
    void runtimeImageGcOnce()
      .then((result) => {
        if (result.candidates + result.failed + result.unsafeRef > 0) {
          console.log("[runtime-image-gc]", result);
        }
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
