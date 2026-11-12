import type { KnowledgeJobAssignment } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import type { CreateJobInput } from "./core.js";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import { freezeJobRuntimeConfiguration } from "./job-runtime-freeze.js";
import { recordJobSharedAssets } from "./domains/shared-assets/index.js";
import { sha256 } from "./domains/project-knowledge/types.js";
import { isolateKnowledgeJob } from "./domains/project-knowledge/job-isolation.js";

/** Shared insert primitive. The caller owns snapshot admission and the complete transaction. */
export async function persistPreparedJob(
  tx: typeof sql, input: CreateJobInput,
  prepared: { snapshot: AgentRuntimeSnapshot; payload: Record<string, unknown>; priority: number; assignment?: KnowledgeJobAssignment },
) {
  const { snapshot, payload, priority, assignment } = prepared;
  const { snapshotWithKnobs: runtimeSnapshot, knobs } = await freezeJobRuntimeConfiguration(tx, input, isolateKnowledgeJob(snapshot, assignment));
  const snapshotWithKnobs = {
    ...runtimeSnapshot,
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
