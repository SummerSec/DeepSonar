import type { KnowledgeJobAssignment } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import type { CreateJobInput } from "./core.js";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import { freezeRuntimeKnobs, mergeRoleRuntimeKnobOverrides, resolveRuntimeKnobs } from "./runtime-knobs.js";
import { recordJobSharedAssets } from "./domains/shared-assets/index.js";
import { sha256 } from "./domains/project-knowledge/types.js";

/** Shared insert primitive. The caller owns snapshot admission and the complete transaction. */
export async function persistPreparedJob(
  tx: typeof sql, input: CreateJobInput,
  prepared: { snapshot: AgentRuntimeSnapshot; payload: Record<string, unknown>; priority: number; assignment?: KnowledgeJobAssignment },
) {
  const { snapshot, payload, priority, assignment } = prepared;
  const [projectRow, globalRow] = await Promise.all([
    tx`SELECT config_json FROM projects WHERE id = ${input.projectId}`,
    tx`SELECT rules_json FROM global_settings WHERE id = 'global'`,
  ]);
  const projectRules = (((projectRow[0]?.config_json as Record<string, unknown> | undefined)?.rules ?? {}) ?? {}) as Record<string, unknown>;
  const platformRules = (globalRow[0]?.rules_json ?? {}) as Record<string, unknown>;
  const knobs = resolveRuntimeKnobs({
    jobType: input.type, imageKey: snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key,
    job: { timeoutSec: input.timeoutSec, stallSec: input.stallSec, jobTokenMaxRequests: input.maxRequests },
    role: mergeRoleRuntimeKnobOverrides(snapshot.role_runtime_knobs?.global, snapshot.role_runtime_knobs?.project),
    project: projectRules, platform: platformRules,
  });
  const { role_runtime_knobs: _roleKnobs, ...base } = snapshot;
  const snapshotWithKnobs = { ...base, runtime_knobs: freezeRuntimeKnobs(knobs),
    ...(assignment ? { knowledge_assignment: assignment } : {}),
    // Trial arms receive their exact versions only through their assignment.
    ...(assignment?.stage === "trial" ? { project_knowledge_catalog: { entries: [], hash: sha256("[]") }, shared_assets: [] } : {}),
  };
  const [created] = await tx`INSERT INTO jobs ${tx({
    project_id: input.projectId, canvas_id: input.canvasId ?? null, agent_snapshot_json: snapshotWithKnobs as never,
    parent_job_id: input.parentJobId ?? null, finding_id: input.findingId ?? null, type: input.type,
    priority, payload_json: payload as never, timeout_sec: knobs.timeoutSec,
    followup_depth: input.followupDepth ?? 0, ingress_key: input.ingressKey ?? null,
  })} RETURNING *`;
  await recordJobSharedAssets(tx, String(created.id), snapshotWithKnobs.shared_assets ?? []);
  return { created, snapshotWithKnobs };
}
