import {
  KNOWLEDGE_LIMITS,
  type KnowledgeInputManifestEntry,
  type KnowledgeSourceRef,
} from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { frozenGovernorRecipe } from "./recipe.js";
import { resolveKnowledgeSource, recheckKnowledgeSources, type KnowledgeActor } from "./inputs.js";
import { registerKnowledgeBlob } from "./blobs.js";
import { KnowledgeOperationError, canonical, sha256, type KnowledgeDb } from "./types.js";

type Db = typeof sql;
type Row = Record<string, unknown>;
type SavepointDb = Db & { savepoint<T>(callback: (nested: Db) => Promise<T>): Promise<T> };
type Status = "queued" | "existing" | "skipped";
type InspectStatus = "eligible" | "existing" | "skipped";

export interface AutomaticKnowledgeWorkResult {
  job_id: string;
  status: Status;
  work_ref?: string;
  reason?: string;
}

export interface AutomaticKnowledgeInspection {
  job_id: string;
  status: InspectStatus;
  work_ref?: string;
  reason?: string;
}

type Origin = Row & {
  id: unknown;
  project_id: unknown;
  canvas_id: unknown;
  type: unknown;
  status: unknown;
  payload_json: unknown;
  agent_snapshot_json: unknown;
  project_status: unknown;
  latest_attempt_id: unknown;
  latest_attempt_status: unknown;
  has_unsettled_effects: unknown;
};

class AutomaticPreparationStopped extends Error {}

function assertRunning(stopped: () => boolean): void {
  if (stopped()) throw new AutomaticPreparationStopped();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function hasKnowledgeMarker(value: Record<string, unknown>): boolean {
  return ["knowledge_work_id", "knowledge_stage", "knowledge_assignment", "knowledge_proposal_id"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function ineligibleReason(origin: Origin | undefined, projectId: string): string | undefined {
  if (!origin) return "job_not_found";
  if (String(origin.project_id) !== projectId) return "project_mismatch";
  if (origin.project_status !== "active") return "project_archived";
  if (origin.type === "hub_reason" || origin.type === "report") return "excluded_job_type";
  const payload = object(origin.payload_json);
  const snapshot = object(origin.agent_snapshot_json);
  if (hasKnowledgeMarker(payload) || hasKnowledgeMarker(snapshot)) return "knowledge_governance_job";
  if (origin.status !== "succeeded") return "job_not_succeeded";
  if (!origin.latest_attempt_id || origin.latest_attempt_status !== "succeeded") return "latest_attempt_not_succeeded";
  const tools = snapshot.platform_tools;
  if (!Array.isArray(tools) || !tools.includes("request_project_knowledge")) return "request_not_allowed";
  if (origin.has_unsettled_effects === true) return "unsettled_effects";
  return undefined;
}

async function readOrigin(db: Db, jobId: string): Promise<Origin | undefined> {
  const [row] = await db<Origin[]>`
    SELECT j.id,j.project_id,j.canvas_id,j.type,j.status,j.payload_json,j.agent_snapshot_json,
      p.status AS project_status,latest.id AS latest_attempt_id,latest.status AS latest_attempt_status,
      EXISTS(SELECT 1 FROM job_attempt_effects e WHERE e.job_id=j.id AND e.status IN ('effect_pending','unknown')) AS has_unsettled_effects
    FROM jobs j JOIN projects p ON p.id=j.project_id
    LEFT JOIN LATERAL (
      SELECT id,status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1
    ) latest ON true
    WHERE j.id=${jobId}`;
  return row;
}

async function existingWork(db: Db, projectId: string, jobId: string): Promise<string | undefined> {
  const [row] = await db`SELECT id FROM project_knowledge_work
    WHERE project_id=${projectId} AND origin_job_id=${jobId}
    ORDER BY created_at,id LIMIT 1`;
  return row ? String(row.id) : undefined;
}

async function hasOwnSources(db: Db, origin: Origin): Promise<boolean> {
  const [row] = await db`
    SELECT EXISTS(SELECT 1 FROM canvas_nodes n WHERE n.job_id=${String(origin.id)}
      AND n.canvas_id=${String(origin.canvas_id ?? "")} AND n.node_type='fact')
      OR EXISTS(SELECT 1 FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
        WHERE a.job_id=${String(origin.id)} AND a.project_id=${String(origin.project_id)}) AS has_sources`;
  return row?.has_sources === true;
}

async function inspectWithoutExisting(db: Db, projectId: string, jobId: string): Promise<AutomaticKnowledgeInspection> {
  const origin = await readOrigin(db, jobId);
  const reason = ineligibleReason(origin, projectId);
  if (reason) return { job_id: jobId, status: "skipped", reason };
  if (!(await hasOwnSources(db, origin!))) return { job_id: jobId, status: "eligible", reason: "no_sources" };
  return { job_id: jobId, status: "eligible" };
}

/** Read-only management preview. An empty source set remains eligible and is settled as a durable skip by preparation. */
export async function inspectAutomaticKnowledgeJob(
  db: KnowledgeDb,
  projectId: string,
  jobId: string,
): Promise<AutomaticKnowledgeInspection> {
  const existing = await existingWork(db as unknown as Db, projectId, jobId);
  if (existing) return { job_id: jobId, status: "existing", work_ref: existing };
  return inspectWithoutExisting(db as unknown as Db, projectId, jobId);
}

/** Register one bounded asynchronous work item while the caller holds the source Job lock. */
export async function queueAutomaticKnowledgeWork(
  tx: KnowledgeDb,
  projectId: string,
  jobId: string,
  governanceHash: string,
): Promise<AutomaticKnowledgeWorkResult> {
  const db = tx as unknown as Db;
  const existing = await existingWork(db, projectId, jobId);
  if (existing) return { job_id: jobId, status: "existing", work_ref: existing };

  const inspection = await inspectWithoutExisting(db, projectId, jobId);
  if (inspection.status === "skipped") return { ...inspection, status: "skipped" };

  const triggerKey = `knowledge:auto:${jobId}`;
  const [created] = await tx`
    INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason)
    VALUES(${projectId},${jobId},${String((await readOrigin(db, jobId))?.canvas_id ?? "") || null},${triggerKey},
      ${tx.json([] as never)},${governanceHash},'automatic_sources_pending')
    ON CONFLICT(project_id,trigger_key) DO NOTHING RETURNING id`;
  if (created) {
    await tx`SELECT pg_notify('deepsonar_jobs','knowledge_work')`;
    return { job_id: jobId, status: "queued", work_ref: String(created.id), reason: "automatic_sources_pending" };
  }

  const raced = await existingWork(db, projectId, jobId);
  if (raced) return { job_id: jobId, status: "existing", work_ref: raced };
  const [byKey] = await db`SELECT id FROM project_knowledge_work WHERE project_id=${projectId} AND trigger_key=${triggerKey}`;
  if (byKey) return { job_id: jobId, status: "existing", work_ref: String(byKey.id) };
  throw new Error("automatic_knowledge_work_insert_missing");
}

/** Success-only terminal hook. Its savepoint keeps knowledge admission outside the source Job outcome. */
export async function queueAutomaticKnowledgeAfterTerminal(
  tx: KnowledgeDb,
  jobId: string,
  status: string,
  governanceHash: string,
): Promise<AutomaticKnowledgeWorkResult> {
  if (status !== "succeeded") return { job_id: jobId, status: "skipped", reason: "job_not_succeeded" };
  try {
    return await (tx as unknown as SavepointDb).savepoint(async (nested) => {
      const [origin] = await nested`SELECT project_id FROM jobs WHERE id=${jobId}`;
      if (!origin) return { job_id: jobId, status: "skipped" as const, reason: "job_not_found" };
      return queueAutomaticKnowledgeWork(nested as unknown as KnowledgeDb, String(origin.project_id), jobId, governanceHash);
    });
  } catch (error) {
    const rawCode = error instanceof KnowledgeOperationError
      ? error.error_code : (error as { code?: unknown } | null)?.code;
    const safeCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,60}$/.test(rawCode) ? rawCode : "unclassified";
    console.warn(`[project-knowledge] automatic registration failed job=${jobId} code=${safeCode}`);
    return { job_id: jobId, status: "skipped", reason: "automatic_queue_failed" };
  }
}

async function automaticSourceRefs(db: Db, origin: Origin, limit: number): Promise<KnowledgeSourceRef[]> {
  const rows = await db`
    SELECT kind,id,body_json,verification_status,statement,payload_json,sha256 FROM (
      SELECT 'fact'::text AS kind,n.id,n.body_json,n.verification_status,NULL::text AS statement,
        NULL::jsonb AS payload_json,NULL::text AS sha256,n.created_at
      FROM canvas_nodes n WHERE n.job_id=${String(origin.id)}
        AND n.canvas_id=${String(origin.canvas_id ?? "")} AND n.node_type='fact'
        AND octet_length(n.body_json::text)<=${KNOWLEDGE_LIMITS.readBytes - 256}
      UNION ALL
      SELECT 'evidence'::text AS kind,e.id,NULL::jsonb AS body_json,NULL::text AS verification_status,
        e.statement,e.payload_json,e.sha256,e.created_at
      FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
      WHERE a.job_id=${String(origin.id)} AND a.project_id=${String(origin.project_id)}
        AND octet_length(e.statement)+COALESCE(octet_length(e.payload_json::text),0)
          +COALESCE(octet_length(e.sha256),0)<=${KNOWLEDGE_LIMITS.readBytes - 512}
    ) sources ORDER BY created_at,id LIMIT ${limit}`;
  return rows.map((row) => {
    const kind = String(row.kind) as "fact" | "evidence";
    const payload = kind === "fact"
      ? { kind, id: row.id, body: row.body_json, verification_status: row.verification_status }
      : { kind, id: row.id, statement: row.statement, payload: row.payload_json, sha256: row.sha256 };
    return { kind, ref: String(row.id), content_hash: sha256(canonical(payload)) };
  });
}

async function recheckGovernorRecipe(tx: Db, recipe: KnowledgeInputManifestEntry | undefined): Promise<void> {
  if (!recipe) return;
  const versionId = recipe.input_ref.slice("governor:".length);
  const [row] = await tx`SELECT v.id FROM project_knowledge_versions v
    JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
    WHERE v.id=${versionId} AND v.project_id=${recipe.project_id} AND v.content_sha256=${recipe.content_hash}
      AND v.revoked_at IS NULL AND i.status<>'revoked' AND i.kind='skill'
      AND i.logical_key='deepsonar/project-knowledge-governor' FOR SHARE OF v,i`;
  if (!row) throw new KnowledgeOperationError("KNOWLEDGE_REVOKED", "Frozen project governor recipe was revoked", "permanent_failure");
}

async function lockAutomaticSources(tx: Db, actor: KnowledgeActor, refs: KnowledgeSourceRef[]): Promise<void> {
  for (const ref of refs) {
    if (ref.kind === "fact") {
      const [row] = await tx`SELECT id FROM canvas_nodes WHERE id=${ref.ref} AND node_type='fact'
        AND job_id=${actor.jobId} AND canvas_id=${actor.canvasId} FOR SHARE`;
      if (!row) throw new KnowledgeOperationError("KNOWLEDGE_SCOPE_DENIED", "Automatic Fact source left its Job scope", "permanent_failure");
    } else if (ref.kind === "evidence") {
      const [row] = await tx`SELECT e.id FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
        WHERE e.id=${ref.ref} AND a.project_id=${actor.projectId} AND a.job_id=${actor.jobId} FOR SHARE OF e,a`;
      if (!row) throw new KnowledgeOperationError("KNOWLEDGE_SCOPE_DENIED", "Automatic Evidence source left its Job scope", "permanent_failure");
    }
  }
}

function shouldPrepare(reason: unknown): boolean {
  return reason === "automatic_sources_pending" || /^automatic_prepare_retry:\d+$/.test(String(reason ?? ""));
}

async function finishWithoutSources(db: Db, workId: string, governanceHash: string, stopped: () => boolean): Promise<boolean> {
  if (stopped()) return false;
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    assertRunning(stopped);
    const [candidate] = await tx`SELECT id,project_id,canvas_id,origin_job_id FROM project_knowledge_work WHERE id=${workId}`;
    assertRunning(stopped);
    if (!candidate || !candidate.origin_job_id) return false;
    const jobId = String(candidate.origin_job_id);
    const [source] = await tx`SELECT canvas_id FROM jobs WHERE id=${jobId}`;
    assertRunning(stopped);
    if (!source) return false;
    if (source.canvas_id) await tx`SELECT id FROM canvases WHERE id=${String(source.canvas_id)} FOR UPDATE`;
    assertRunning(stopped);
    const [job] = await tx`SELECT id,canvas_id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    assertRunning(stopped);
    if (!job || String(job.canvas_id ?? "") !== String(source.canvas_id ?? "")) return false;
    const [work] = await tx`SELECT id,project_id,canvas_id,governance_hash,state,reason FROM project_knowledge_work
      WHERE id=${workId} FOR UPDATE`;
    assertRunning(stopped);
    if (!work || work.state !== "pending" || !shouldPrepare(work.reason)) return false;
    if (String(work.canvas_id ?? "") !== String(job.canvas_id ?? "")) return false;
    if (String(work.governance_hash) !== governanceHash) {
      assertRunning(stopped);
      await tx`UPDATE project_knowledge_work SET state='blocked',reason='governance_baseline_changed',updated_at=now()
        WHERE id=${workId} AND state='pending'`;
      return true;
    }
    const origin = await readOrigin(tx, jobId);
    assertRunning(stopped);
    const reason = ineligibleReason(origin, String(work.project_id));
    if (reason) {
      assertRunning(stopped);
      await tx`UPDATE project_knowledge_work SET state='blocked',reason=${`automatic_source_not_eligible:${reason}`},updated_at=now()
        WHERE id=${workId} AND state='pending'`;
      return true;
    }
    const currentRefs = await automaticSourceRefs(tx, origin!, KNOWLEDGE_LIMITS.files);
    assertRunning(stopped);
    if (currentRefs.length) return false;
    if (await hasOwnSources(tx, origin!)) {
      assertRunning(stopped);
      await tx`UPDATE project_knowledge_work SET state='blocked',reason='automatic_sources_too_large',updated_at=now()
        WHERE id=${workId} AND state='pending'`;
      return true;
    }
    assertRunning(stopped);
    const [done] = await tx`UPDATE project_knowledge_work SET state='completed',stage='settle',reason='automatic_no_sources',
      input_manifest_json=${tx.json([] as never)},claim_expires_at=NULL,updated_at=now()
      WHERE id=${workId} AND state='pending' RETURNING id`;
    return Boolean(done);
  });
}

async function commitPreparedInputs(
  db: Db,
  input: { workId: string; origin: Origin; actor: KnowledgeActor; refs: KnowledgeSourceRef[];
    entries: KnowledgeInputManifestEntry[]; recipe?: KnowledgeInputManifestEntry; governanceHash: string },
  stopped: () => boolean,
): Promise<boolean> {
  if (stopped()) return false;
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    const jobId = String(input.origin.id);
    assertRunning(stopped);
    const [candidate] = await tx`SELECT canvas_id FROM jobs WHERE id=${jobId}`;
    assertRunning(stopped);
    if (!candidate) return false;
    if (candidate.canvas_id) await tx`SELECT id FROM canvases WHERE id=${String(candidate.canvas_id)} FOR UPDATE`;
    assertRunning(stopped);
    const [lockedJob] = await tx`SELECT id,canvas_id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    assertRunning(stopped);
    if (!lockedJob || String(lockedJob.canvas_id ?? "") !== String(candidate.canvas_id ?? "")
      || String(lockedJob.canvas_id ?? "") !== String(input.origin.canvas_id ?? "")) return false;
    const [work] = await tx`SELECT id,project_id,origin_job_id,canvas_id,governance_hash,state,reason
      FROM project_knowledge_work WHERE id=${input.workId} FOR UPDATE`;
    assertRunning(stopped);
    if (!work || work.state !== "pending" || !shouldPrepare(work.reason)
      || String(work.origin_job_id ?? "") !== jobId
      || String(work.canvas_id ?? "") !== String(lockedJob.canvas_id ?? "")) return false;
    if (String(work.governance_hash) !== input.governanceHash) {
      assertRunning(stopped);
      await tx`UPDATE project_knowledge_work SET state='blocked',reason='governance_baseline_changed',updated_at=now()
        WHERE id=${input.workId} AND state='pending'`;
      return true;
    }

    const lockedOrigin = await readOrigin(tx, jobId);
    assertRunning(stopped);
    const ineligible = ineligibleReason(lockedOrigin, String(work.project_id));
    if (ineligible) {
      assertRunning(stopped);
      await tx`UPDATE project_knowledge_work SET state='blocked',reason=${`automatic_source_not_eligible:${ineligible}`},updated_at=now()
        WHERE id=${input.workId} AND state='pending'`;
      return true;
    }
    const actor: KnowledgeActor = { ...input.actor, snapshot: object(lockedOrigin!.agent_snapshot_json) };
    await lockAutomaticSources(tx, actor, input.refs);
    assertRunning(stopped);
    const currentRefs = await automaticSourceRefs(tx, lockedOrigin!, input.refs.length);
    assertRunning(stopped);
    if (canonical(currentRefs) !== canonical(input.refs))
      throw new KnowledgeOperationError("KNOWLEDGE_SOURCE_CHANGED", "Automatic source set changed during preparation", "permanent_failure");
    await recheckKnowledgeSources(tx as unknown as KnowledgeDb, actor, input.refs);
    assertRunning(stopped);
    await recheckGovernorRecipe(tx, input.recipe);
    assertRunning(stopped);
    const manifest = [...input.entries, ...(input.recipe ? [input.recipe] : [])];
    if (manifest.length > KNOWLEDGE_LIMITS.files)
      throw new KnowledgeOperationError("KNOWLEDGE_INPUT_TOO_LARGE", "Automatic input manifest exceeds the bounded file count", "permanent_failure");
    for (const entry of manifest) {
      assertRunning(stopped);
      await registerKnowledgeBlob(tx as unknown as KnowledgeDb, entry.blob_hash, entry.bytes);
    }
    assertRunning(stopped);
    const [prepared] = await tx`UPDATE project_knowledge_work SET input_manifest_json=${tx.json(manifest as never)},
      reason=NULL,next_attempt_at=now(),claim_expires_at=NULL,updated_at=now()
      WHERE id=${input.workId} AND state='pending' RETURNING id`;
    return Boolean(prepared);
  });
}

function safeKnowledgeCode(error: unknown): string | undefined {
  if (!(error instanceof KnowledgeOperationError)) return undefined;
  return /^[A-Z0-9_]{1,60}$/.test(error.error_code) ? error.error_code : undefined;
}

async function recordPreparationFailure(db: Db, workId: string, error: unknown, stopped: () => boolean): Promise<boolean> {
  if (stopped()) return false;
  const permanent = error instanceof KnowledgeOperationError && error.category !== "transient_retryable";
  if (permanent) {
    const code = safeKnowledgeCode(error);
    const reason = code ? `automatic_source_rejected:${code}` : "automatic_source_rejected";
    if (stopped()) return false;
    const [blocked] = await db`UPDATE project_knowledge_work SET state='blocked',reason=${reason},claim_expires_at=NULL,updated_at=now()
      WHERE id=${workId} AND state='pending' AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%')
      RETURNING id`;
    return Boolean(blocked);
  }
  const [current] = await db`SELECT reason FROM project_knowledge_work WHERE id=${workId} AND state='pending'`;
  if (stopped()) return false;
  if (!current || !shouldPrepare(current.reason)) return false;
  const previous = /^automatic_prepare_retry:(\d+)$/.exec(String(current.reason ?? ""));
  const retries = Number(previous?.[1] ?? 0) + 1;
  const exhausted = retries >= 3;
  const reason = exhausted ? "automatic_prepare_retries_exhausted" : `automatic_prepare_retry:${retries}`;
  if (stopped()) return false;
  const [updated] = await db`UPDATE project_knowledge_work SET state=${exhausted ? "blocked" : "pending"},reason=${reason},
    claim_expires_at=NULL,next_attempt_at=now()+interval '30 seconds',updated_at=now()
    WHERE id=${workId} AND state='pending' AND reason=${current.reason}
    RETURNING id`;
  return Boolean(updated);
}

async function prepareOne(db: Db, workId: string, governanceHash: string, stopped: () => boolean): Promise<boolean> {
  if (stopped()) return false;
  const [work] = await db`SELECT id,project_id,origin_job_id,canvas_id,governance_hash,state,reason
    FROM project_knowledge_work WHERE id=${workId} AND state='pending'`;
  if (stopped()) return false;
  if (!work || !work.origin_job_id || !shouldPrepare(work.reason)) return false;
  if (String(work.governance_hash) !== governanceHash) {
    if (stopped()) return false;
    const [blocked] = await db`UPDATE project_knowledge_work SET state='blocked',reason='governance_baseline_changed',updated_at=now()
      WHERE id=${workId} AND state='pending' AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%') RETURNING id`;
    return Boolean(blocked);
  }

  try {
    if (stopped()) return false;
    const origin = await readOrigin(db, String(work.origin_job_id));
    if (stopped()) return false;
    const reason = ineligibleReason(origin, String(work.project_id));
    if (reason) {
      if (stopped()) return false;
      const [blocked] = await db`UPDATE project_knowledge_work SET state='blocked',reason=${`automatic_source_not_eligible:${reason}`},
        updated_at=now() WHERE id=${workId} AND state='pending' AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%') RETURNING id`;
      return Boolean(blocked);
    }
    if (String(origin!.project_id) !== String(work.project_id)
      || String(origin!.canvas_id ?? "") !== String(work.canvas_id ?? "")) {
      if (stopped()) return false;
      const [blocked] = await db`UPDATE project_knowledge_work SET state='blocked',reason='automatic_source_scope_changed',updated_at=now()
        WHERE id=${workId} AND state='pending' AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%') RETURNING id`;
      return Boolean(blocked);
    }

    const candidates = await automaticSourceRefs(db, origin!, KNOWLEDGE_LIMITS.files);
    if (stopped()) return false;
    if (!candidates.length) {
      if (await hasOwnSources(db, origin!)) {
        if (stopped()) return false;
        const [blocked] = await db`UPDATE project_knowledge_work SET state='blocked',reason='automatic_sources_too_large',updated_at=now()
          WHERE id=${workId} AND state='pending' AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%') RETURNING id`;
        return Boolean(blocked);
      }
      return await finishWithoutSources(db, workId, governanceHash, stopped);
    }
    const actor: KnowledgeActor = {
      jobId: String(origin!.id), projectId: String(origin!.project_id), canvasId: origin!.canvas_id ? String(origin!.canvas_id) : null,
      attemptId: String(origin!.latest_attempt_id), snapshot: object(origin!.agent_snapshot_json),
    };
    if (stopped()) return false;
    const recipe = await frozenGovernorRecipe(db as unknown as KnowledgeDb, actor);
    if (stopped()) return false;
    const refs = candidates.slice(0, KNOWLEDGE_LIMITS.files - (recipe ? 1 : 0));
    if (stopped()) return false;
    const entries: KnowledgeInputManifestEntry[] = [];
    for (const ref of refs) {
      if (stopped()) return false;
      entries.push(await resolveKnowledgeSource(db as unknown as KnowledgeDb, actor, ref));
    }
    if (stopped()) return false;
    return await commitPreparedInputs(db, { workId, origin: origin!, actor, refs, entries, recipe,
      governanceHash }, stopped);
  } catch (error) {
    if (error instanceof AutomaticPreparationStopped || stopped()) return false;
    return await recordPreparationFailure(db, workId, error, stopped);
  }
}

/** Resolve at most eight queued inputs per dispatcher tick, with all blob I/O outside the CAS transaction. */
export async function prepareAutomaticKnowledgeWork(
  db: KnowledgeDb,
  governanceHash: string,
  stopped: () => boolean = () => false,
): Promise<number> {
  if (stopped()) return 0;
  const candidates = await db`
    SELECT id FROM project_knowledge_work WHERE state='pending' AND next_attempt_at<=now()
      AND (reason='automatic_sources_pending' OR reason LIKE 'automatic_prepare_retry:%')
    ORDER BY next_attempt_at,id LIMIT 8`;
  if (stopped()) return 0;
  let prepared = 0;
  for (const row of candidates) {
    if (stopped()) break;
    if (await prepareOne(db as unknown as Db, String(row.id), governanceHash, stopped)) prepared++;
  }
  return prepared;
}
