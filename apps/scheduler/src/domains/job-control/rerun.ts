import {
  DISPATCH_CLAIM_ADVISORY_KEY,
  parseRelatedFindingIds,
  resolveAgentSnapshotForJob,
  type AgentRuntimeSnapshot,
} from "../../core.js";
import { sql } from "../../db.js";
import { runner } from "../../runtime.js";
import { markAttemptInterrupted } from "../job-attempt/index.js";
import {
  createSqlJobLifecycleApplication,
  RESUMABLE_JOB_STATUSES,
} from "../job-lifecycle/index.js";
import {
  freezeAgentSnapshotNetworkPolicy,
  SnapshotUnresolvableError,
} from "../role-runtime-snapshot/index.js";
import { recordJobSharedAssets } from "../shared-assets/index.js";
import { assertFrozenRuntimeImageLocal } from "../../runtime-images.js";
import { runtimeImageKeyFromSnapshot } from "../job-lifecycle/stall-policy.js";

export const SNAPSHOT_STALE = "SNAPSHOT_STALE" as const;
export const JOB_NOT_RESUMABLE = "JOB_NOT_RESUMABLE" as const;
export { SnapshotUnresolvableError };

type SnapshotObject = Record<string, unknown>;

type GovernedSnapshotIdentity = {
  agent_cli: string | null;
  model: string | null;
  upstream_model: string | null;
  credential_id: string | null;
  credential_provider: string | null;
  dsh_task_mode: string | null;
  reasoning: string | null;
  context_window_tokens: number | null;
  runtime_adapter_id: string | null;
  runtime_adapter_version: string | null;
  runtime_image_key: string | null;
  runtime_image_digest: string | null;
  runtime_contract_version: string | null;
};

export type SnapshotStaleDetail = {
  job_id: string;
  stale_fields: string[];
  resolution_error?: string;
};

export type RequeueJobResult =
  | {
      kind: "ok";
      job: Record<string, unknown>;
      from_status: string;
      snapshot_refreshed: boolean;
      previous_sandbox_id: string | null;
    }
  | { kind: "not_found" }
  | { kind: "not_resumable"; status: string }
  | { kind: "snapshot_stale"; detail: SnapshotStaleDetail };

const resumableStatuses = new Set<string>(RESUMABLE_JOB_STATUSES);

function objectValue(value: unknown): SnapshotObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SnapshotObject
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Project only the governed execution identity. Mutable timestamps, RoleConfig
 * versions, catalog revisions, content hashes, and shared-asset revisions are
 * intentionally excluded: they do not determine whether the old CLI/model
 * identity is still the currently selected one.
 */
export function governedSnapshotIdentity(snapshot: unknown): GovernedSnapshotIdentity {
  const value = objectValue(snapshot);
  const runtime = objectValue(value.agent_runtime);
  const image = objectValue(value.runtime_image);
  return {
    agent_cli: nullableString(value.agent_cli),
    model: nullableString(value.model),
    upstream_model: nullableString(value.upstream_model),
    credential_id: nullableString(value.credential_id),
    credential_provider: nullableString(value.credential_provider),
    dsh_task_mode: nullableString(value.dsh_task_mode),
    reasoning: nullableString(value.reasoning),
    context_window_tokens: nullableNumber(value.context_window_tokens),
    runtime_adapter_id: nullableString(runtime.adapter_id),
    runtime_adapter_version: nullableString(runtime.adapter_version),
    runtime_image_key: nullableString(image.image_key ?? value.runtime_image_key),
    runtime_image_digest: nullableString(image.image_digest),
    runtime_contract_version: nullableString(image.contract_version),
  };
}

export function snapshotIdentityDrift(oldSnapshot: unknown, currentSnapshot: unknown): string[] {
  const oldIdentity = governedSnapshotIdentity(oldSnapshot);
  const currentIdentity = governedSnapshotIdentity(currentSnapshot);
  return (Object.keys(currentIdentity) as Array<keyof GovernedSnapshotIdentity>)
    .filter((key) => oldIdentity[key] !== currentIdentity[key]);
}

function safeResolutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 500) || "current snapshot resolution failed";
}

export function isSnapshotUnresolvableError(error: unknown): error is SnapshotUnresolvableError {
  for (let current: unknown = error; current; current = current instanceof Error ? current.cause : undefined) {
    if (current instanceof SnapshotUnresolvableError) return true;
    if (current instanceof Error && current.name === "SnapshotUnresolvableError") return true;
  }
  return false;
}

export function currentSnapshotUnresolvableBody(error: unknown) {
  return {
    error: "当前受治理运行配置无法解析；请修复 RoleConfig、Credential 或运行镜像配置后重试",
    error_code: SNAPSHOT_STALE,
    stale_fields: ["current_snapshot_unresolvable"],
    resolution_error: safeResolutionError(error),
    next_action: "fix-current-configuration" as const,
  };
}

export async function frozenSnapshotStaleDetail(
  tx: typeof sql,
  job: Record<string, unknown>,
): Promise<SnapshotStaleDetail | null> {
  const jobId = String(job.id);
  try {
    const currentSnapshot = await resolveCurrentSnapshotForExistingJob(tx, job);
    const staleFields = snapshotIdentityDrift(job.agent_snapshot_json, currentSnapshot);
    return staleFields.length > 0 ? { job_id: jobId, stale_fields: staleFields } : null;
  } catch (error) {
    return {
      job_id: jobId,
      stale_fields: ["current_snapshot_unresolvable"],
      resolution_error: safeResolutionError(error),
    };
  }
}

/** Hub 冻结的 image_key 是该 Job 的镜像身份；resume/rerun 不得掉回角色缺省。 */
export function frozenRuntimeImageOverride(snapshot: unknown): { runtimeImageKey: string } | undefined {
  const key = runtimeImageKeyFromSnapshot(snapshot);
  return key ? { runtimeImageKey: key } : undefined;
}

export async function resolveCurrentSnapshotForExistingJob(
  tx: typeof sql,
  job: Record<string, unknown>,
): Promise<AgentRuntimeSnapshot> {
  const payload = objectValue(job.payload_json);
  const findingIds = [
    ...new Set([
      ...(job.finding_id ? [String(job.finding_id).toLowerCase()] : []),
      ...parseRelatedFindingIds(payload),
    ]),
  ];
  return freezeAgentSnapshotNetworkPolicy(
    tx,
    String(job.canvas_id),
    await resolveAgentSnapshotForJob(
      tx,
      String(job.project_id),
      String(job.type),
      findingIds,
      frozenRuntimeImageOverride(job.agent_snapshot_json),
    ),
  );
}

export async function revokeOldRuntimeGrants(tx: typeof sql, jobId: string, reason: string): Promise<void> {
  await tx`
    UPDATE job_tokens
    SET status = 'revoked', revoked_at = now(), revoke_reason = ${reason}
    WHERE job_id = ${jobId} AND status = 'active'`;
  await tx`
    UPDATE job_capability_tokens
    SET revoked_at = now(), revoke_reason = ${reason}
    WHERE job_id = ${jobId} AND revoked_at IS NULL`;
}

async function resetReportState(tx: typeof sql, jobId: string): Promise<void> {
  await tx`
    UPDATE task_reports SET status = 'pending', error = NULL, updated_at = now()
    WHERE report_job_id = ${jobId} AND status = 'failed'`;
  await tx`
    UPDATE finding_reports SET status = 'pending', error = NULL, updated_at = now()
    WHERE report_job_id = ${jobId} AND status = 'failed'`;
}

/**
 * Re-enqueue one recoverable Job. Both modes resolve the complete current
 * snapshot under the dispatcher admission lock. resume rejects identity drift
 * and retains the old snapshot; rerun-current atomically installs the newly
 * resolved snapshot before exposing pending to Dispatcher.
 */
export async function requeueJob(
  jobId: string,
  mode: "resume-frozen" | "rerun-current",
): Promise<RequeueJobResult> {
  const result = await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof sql;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;

    const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
    if (!locator) return { kind: "not_found" as const };
    if (!locator.canvas_id) {
      return {
        kind: "snapshot_stale" as const,
        detail: {
          job_id: jobId,
          stale_fields: ["canvas_id"],
          resolution_error: "Job 缺少 canvas_id，无法按当前任务策略解析快照",
        },
      };
    }

    // Canonical mutable-domain order: Canvas first, then Job. The dispatcher
    // advisory lock is already held, so no pending Job can be claimed between
    // snapshot replacement and the status transition.
    const [canvas] = await tx`
      SELECT id FROM canvases WHERE id = ${String(locator.canvas_id)} FOR UPDATE`;
    if (!canvas) {
      return {
        kind: "snapshot_stale" as const,
        detail: {
          job_id: jobId,
          stale_fields: ["canvas_id"],
          resolution_error: "Job 所属 Canvas 不存在",
        },
      };
    }
    const [job] = await tx`
      SELECT id, project_id, canvas_id, finding_id, type, status, payload_json,
             agent_snapshot_json, sandbox_id, priority
      FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if (!job) return { kind: "not_found" as const };
    const status = String(job.status);
    if (!resumableStatuses.has(status)) {
      return { kind: "not_resumable" as const, status };
    }

    let currentSnapshot: AgentRuntimeSnapshot;
    try {
      currentSnapshot = await resolveCurrentSnapshotForExistingJob(tx, job as Record<string, unknown>);
    } catch (error) {
      return {
        kind: "snapshot_stale" as const,
        detail: {
          job_id: jobId,
          stale_fields: ["current_snapshot_unresolvable"],
          resolution_error: safeResolutionError(error),
        },
      };
    }

    const staleFields = snapshotIdentityDrift(job.agent_snapshot_json, currentSnapshot);
    if (mode === "resume-frozen" && staleFields.length > 0) {
      return {
        kind: "snapshot_stale" as const,
        detail: { job_id: jobId, stale_fields: staleFields },
      };
    }

    await assertFrozenRuntimeImageLocal(
      (mode === "rerun-current" ? currentSnapshot : job.agent_snapshot_json) as Record<string, unknown>,
    );

    // waiting_human may still own the previous active Attempt. Close it as an
    // interrupted execution and preserve every settled/unknown effect; the
    // next dispatcher claim must create a new Attempt.
    await markAttemptInterrupted(
      tx,
      jobId,
      mode === "rerun-current" ? "按当前配置重新执行" : "使用旧冻结快照重新执行",
    );
    await revokeOldRuntimeGrants(tx, jobId, mode);

    if (mode === "rerun-current") {
      await tx`DELETE FROM job_shared_asset_versions WHERE job_id = ${jobId}`;
      await recordJobSharedAssets(tx, jobId, currentSnapshot.shared_assets ?? []);
    }

    const transitioned = await createSqlJobLifecycleApplication(tx).transitionJob(jobId, "pending", {
      agent_snapshot_json: tx.json(
        (mode === "rerun-current" ? currentSnapshot : job.agent_snapshot_json) as never,
      ),
      error: null,
      sandbox_id: null,
      lease_expires_at: null,
      claimed_at: null,
      started_at: null,
      finished_at: null,
      heartbeat_at: null,
    });
    if (!transitioned) return { kind: "not_resumable" as const, status };
    const updated = {
      id: job.id,
      project_id: job.project_id,
      canvas_id: job.canvas_id,
      type: job.type,
      status: transitioned.status,
      priority: job.priority,
    };

    await resetReportState(tx, jobId);
    await tx`
      UPDATE canvas_nodes SET status = 'pending', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
    await tx`SELECT pg_notify('deepsonar_jobs', ${mode})`;

    return {
      kind: "ok" as const,
      job: updated as Record<string, unknown>,
      from_status: status,
      snapshot_refreshed: mode === "rerun-current",
      previous_sandbox_id: nullableString(job.sandbox_id),
    };
  });
  if (result.kind === "ok" && result.previous_sandbox_id) {
    await runner.destroy({ sandboxId: result.previous_sandbox_id }).catch((error) => {
      console.error(`[job-rerun] 沙箱回收失败 ${result.previous_sandbox_id}:`, error);
    });
  }
  return result;
}
