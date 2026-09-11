/**
 * Persist semantic research ranking (#448).
 *
 * Owns finding_research* tables only. Never UPDATE findings
 * (verify_status / severity / disposition stay untouched).
 */
import { randomUUID } from "node:crypto";
import type { sql } from "../../db.js";
import {
  FINDING_RESEARCH_BATCH_LIMIT,
  FINDING_RESEARCH_MAX_BATCHES,
  FINDING_RESEARCH_MODEL,
  FINDING_RESEARCH_PROMPT_REVISION,
  FindingResearchJudgeError,
  runResearchPipeline,
  type ResearchCandidate,
  type SemanticJudge,
} from "./policy.js";

export type FindingResearchDatabase = typeof sql;
export type FindingResearchTransaction = FindingResearchDatabase;

type SavepointTx = FindingResearchTransaction & {
  savepoint<T>(callback: (tx: FindingResearchTransaction) => T | Promise<T>): Promise<T>;
};

function withResearchSavepoint<T>(
  tx: FindingResearchTransaction,
  fn: (inner: FindingResearchTransaction) => Promise<T>,
): Promise<T> {
  const nested = tx as SavepointTx;
  if (typeof nested.savepoint === "function") {
    return nested.savepoint(fn);
  }
  return fn(tx);
}

export interface FindingResearchRunInput {
  canvasId: string;
  projectId: string;
  kind?: "dedupe" | "priority" | "pipeline";
  batchLimit?: number;
  maxBatches?: number;
  judge?: SemanticJudge;
  model?: string;
  promptRevision?: string;
}

export interface FindingResearchRunResult {
  status: "succeeded" | "failed" | "noop";
  runIds: string[];
  processed: number;
  remaining: number;
  error?: string;
}

interface FindingRow {
  id: string;
  title: string;
  location: string | null;
  summary: string | null;
  category: string | null;
  profile: string;
  severity: string | null;
  evidence_refs_json: unknown;
  created_at: string | Date;
}

interface ResearchRow {
  finding_id: string;
  dedupe_cluster_id: string | null;
  canonical_finding_id: string | null;
  is_canonical: boolean;
}

function asCandidate(row: FindingRow): ResearchCandidate {
  const refs = Array.isArray(row.evidence_refs_json)
    ? row.evidence_refs_json.map((item) => String(item))
    : [];
  return {
    id: String(row.id),
    title: String(row.title),
    location: row.location == null ? null : String(row.location),
    summary: row.summary == null ? null : String(row.summary),
    category: row.category == null ? null : String(row.category),
    profile: String(row.profile),
    severity: row.severity == null ? null : String(row.severity),
    evidenceRefs: refs,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadCanvasFindings(tx: FindingResearchTransaction, canvasId: string): Promise<FindingRow[]> {
  return tx`
    SELECT f.id, f.title, f.location, f.summary, f.category, f.profile, f.severity,
           f.evidence_refs_json, f.created_at
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}
    ORDER BY f.created_at ASC, f.id ASC`;
}

async function recordFailedRun(
  tx: FindingResearchTransaction,
  input: FindingResearchRunInput,
  error: string,
  extras?: { candidateIds?: string[]; anchorIds?: string[] },
): Promise<string> {
  const runId = randomUUID();
  await tx`
    INSERT INTO finding_research_runs ${tx({
      id: runId,
      canvas_id: input.canvasId,
      project_id: input.projectId,
      kind: input.kind ?? "pipeline",
      status: "failed",
      batch_limit: input.batchLimit ?? FINDING_RESEARCH_BATCH_LIMIT,
      model: input.model ?? FINDING_RESEARCH_MODEL,
      prompt_revision: input.promptRevision ?? FINDING_RESEARCH_PROMPT_REVISION,
      input_json: {
        candidate_ids: extras?.candidateIds ?? [],
        anchor_ids: extras?.anchorIds ?? [],
      } as never,
      result_json: {} as never,
      error,
      finished_at: new Date(),
    })}`;
  return runId;
}

async function persistAssignments(
  tx: FindingResearchTransaction,
  input: FindingResearchRunInput,
  runId: string,
  assignments: ReturnType<typeof runResearchPipeline>["assignments"],
  clusterIds: Map<string, string>,
): Promise<void> {
  for (const assignment of assignments) {
    let clusterId = clusterIds.get(assignment.canonicalFindingId);
    if (!clusterId) {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM finding_dedupe_clusters
        WHERE canvas_id = ${input.canvasId} AND canonical_finding_id = ${assignment.canonicalFindingId}`;
      clusterId = existing?.id ?? randomUUID();
      if (!existing) {
        await tx`
          INSERT INTO finding_dedupe_clusters ${tx({
            id: clusterId,
            canvas_id: input.canvasId,
            project_id: input.projectId,
            canonical_finding_id: assignment.canonicalFindingId,
          })}`;
      }
      clusterIds.set(assignment.canonicalFindingId, clusterId);
    }
    await tx`
      INSERT INTO finding_research ${tx({
        finding_id: assignment.findingId,
        project_id: input.projectId,
        canvas_id: input.canvasId,
        dedupe_cluster_id: clusterId,
        canonical_finding_id: assignment.canonicalFindingId,
        is_canonical: assignment.isCanonical,
        dedupe_reason: assignment.dedupeReason,
        last_run_id: runId,
      })}
      ON CONFLICT (finding_id) DO UPDATE SET
        dedupe_cluster_id = EXCLUDED.dedupe_cluster_id,
        canonical_finding_id = EXCLUDED.canonical_finding_id,
        is_canonical = EXCLUDED.is_canonical,
        dedupe_reason = EXCLUDED.dedupe_reason,
        last_run_id = EXCLUDED.last_run_id,
        updated_at = now()`;
  }
}

async function persistPriorities(
  tx: FindingResearchTransaction,
  runId: string,
  model: string,
  promptRevision: string,
  priorities: ReturnType<typeof runResearchPipeline>["priorities"],
): Promise<void> {
  for (const priority of priorities) {
    await tx`
      UPDATE finding_research SET
        priority_score = ${priority.score},
        priority_reason = ${priority.reason},
        priority_model = ${model},
        priority_prompt_revision = ${promptRevision},
        last_run_id = ${runId},
        updated_at = now()
      WHERE finding_id = ${priority.findingId} AND is_canonical = true`;
  }
}

export async function runFindingResearch(
  tx: FindingResearchTransaction,
  input: FindingResearchRunInput,
): Promise<FindingResearchRunResult> {
  const batchLimit = input.batchLimit ?? FINDING_RESEARCH_BATCH_LIMIT;
  const maxBatches = input.maxBatches ?? (input.kind === "dedupe" ? 1 : FINDING_RESEARCH_MAX_BATCHES);
  const model = input.model ?? FINDING_RESEARCH_MODEL;
  const promptRevision = input.promptRevision ?? FINDING_RESEARCH_PROMPT_REVISION;
  const findings = await loadCanvasFindings(tx, input.canvasId);
  if (findings.length === 0) return { status: "noop", runIds: [], processed: 0, remaining: 0 };

  const membership = await tx<ResearchRow[]>`
    SELECT finding_id, dedupe_cluster_id, canonical_finding_id, is_canonical
    FROM finding_research
    WHERE canvas_id = ${input.canvasId}`;
  const clusteredIds = new Set(membership.map((row) => String(row.finding_id)));
  const candidates = findings.map(asCandidate);
  const anchors = candidates.filter((item) =>
    membership.some((row) => row.finding_id === item.id && row.is_canonical),
  );
  const unclustered = candidates.filter((item) => !clusteredIds.has(item.id));
  if (unclustered.length === 0 && input.kind === "dedupe") {
    return { status: "noop", runIds: [], processed: 0, remaining: 0 };
  }

  const runIds: string[] = [];
  let processed = 0;
  let remaining = unclustered;
  let liveAnchors = anchors;
  const clusterIds = new Map<string, string>();
  for (const row of membership) {
    if (row.is_canonical && row.dedupe_cluster_id && row.canonical_finding_id) {
      clusterIds.set(String(row.canonical_finding_id), String(row.dedupe_cluster_id));
    }
  }

  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (remaining.length === 0 && batch > 0) break;
      const runId = randomUUID();
      const slice = remaining.slice(0, batchLimit);
      await tx`
        INSERT INTO finding_research_runs ${tx({
          id: runId,
          canvas_id: input.canvasId,
          project_id: input.projectId,
          kind: input.kind ?? "pipeline",
          status: "running",
          batch_limit: batchLimit,
          model,
          prompt_revision: promptRevision,
          input_json: {
            candidate_ids: slice.map((item) => item.id),
            anchor_ids: liveAnchors.map((item) => item.id),
            batch,
          } as never,
        })}`;
      try {
        const result = runResearchPipeline(remaining, liveAnchors, {
          batchLimit,
          judge: input.judge,
          model,
          promptRevision,
        });
        await persistAssignments(tx, input, runId, result.assignments, clusterIds);
        liveAnchors = [
          ...liveAnchors,
          ...candidates.filter((item) =>
            result.assignments.some((assignment) => assignment.findingId === item.id && assignment.isCanonical),
          ),
        ];
        if (input.kind !== "dedupe") {
          await persistPriorities(tx, runId, model, promptRevision, result.priorities);
        }
        await tx`
          UPDATE finding_research_runs SET
            status = 'succeeded',
            result_json = ${tx.json({
              processed_ids: result.assignments.map((item) => item.findingId),
              remaining_ids: result.remainingIds,
              priorities: result.priorities,
            } as never)},
            error = NULL,
            finished_at = now()
          WHERE id = ${runId}`;
        runIds.push(runId);
        processed += result.assignments.length;
        remaining = remaining.filter((item) => result.remainingIds.includes(item.id));
        if (input.kind === "dedupe") break;
      } catch (error) {
        const message = error instanceof FindingResearchJudgeError
          ? error.message
          : error instanceof Error
            ? error.message
            : "finding research failed";
        await tx`
          UPDATE finding_research_runs SET
            status = 'failed',
            error = ${message},
            finished_at = now()
          WHERE id = ${runId}`;
        return { status: "failed", runIds: [...runIds, runId], processed, remaining: remaining.length, error: message };
      }
    }
    if (input.kind === "dedupe" && liveAnchors.length > 0) {
      const rankRunId = randomUUID();
      await tx`
        INSERT INTO finding_research_runs ${tx({
          id: rankRunId,
          canvas_id: input.canvasId,
          project_id: input.projectId,
          kind: "priority",
          status: "running",
          batch_limit: batchLimit,
          model,
          prompt_revision: promptRevision,
          input_json: { anchor_ids: liveAnchors.map((item) => item.id) } as never,
        })}`;
      try {
        const ranked = runResearchPipeline([], liveAnchors, { judge: input.judge, model, promptRevision });
        await persistPriorities(tx, rankRunId, model, promptRevision, ranked.priorities);
        await tx`
          UPDATE finding_research_runs SET
            status = 'succeeded',
            result_json = ${tx.json({ priorities: ranked.priorities } as never)},
            finished_at = now()
          WHERE id = ${rankRunId}`;
        runIds.push(rankRunId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "finding research failed";
        await tx`
          UPDATE finding_research_runs SET
            status = 'failed',
            error = ${message},
            finished_at = now()
          WHERE id = ${rankRunId}`;
        return { status: "failed", runIds: [...runIds, rankRunId], processed, remaining: remaining.length, error: message };
      }
    }
    return { status: "succeeded", runIds, processed, remaining: remaining.length };
  } catch (error) {
    const message = error instanceof FindingResearchJudgeError
      ? error.message
      : error instanceof Error
        ? error.message
        : "finding research failed";
    const failedId = await recordFailedRun(tx, input, message, {
      candidateIds: remaining.map((item) => item.id),
      anchorIds: liveAnchors.map((item) => item.id),
    });
    return { status: "failed", runIds: [...runIds, failedId], processed, remaining: remaining.length, error: message };
  }
}

/**
 * Incremental / report hooks must keep the Finding and report writes even if
 * research persistence fails. PostgreSQL aborts a transaction after any
 * statement error, so research SQL and the failed-run ledger each run in
 * their own savepoint; a rolled-back savepoint leaves the outer tx usable.
 */
export async function runFindingResearchBestEffort(
  tx: FindingResearchTransaction,
  input: FindingResearchRunInput,
): Promise<FindingResearchRunResult> {
  try {
    return await withResearchSavepoint(tx, (inner) => runFindingResearch(inner, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "finding research failed";
    try {
      const runId = await withResearchSavepoint(tx, (inner) => recordFailedRun(inner, input, message));
      return { status: "failed", runIds: [runId], processed: 0, remaining: 0, error: message };
    } catch {
      return { status: "failed", runIds: [], processed: 0, remaining: 0, error: message };
    }
  }
}

export function projectFindingResearch(row: Record<string, unknown>): {
  dedupe_cluster_id: string | null;
  canonical_finding_id: string | null;
  is_canonical: boolean | null;
  dedupe_reason: string | null;
  priority_score: number | null;
  priority_reason: string | null;
  priority_model: string | null;
  priority_prompt_revision: string | null;
  last_run_id: string | null;
} | null {
  if (row.dedupe_cluster_id == null && row.canonical_finding_id == null && row.priority_score == null) {
    return null;
  }
  return {
    dedupe_cluster_id: row.dedupe_cluster_id == null ? null : String(row.dedupe_cluster_id),
    canonical_finding_id: row.canonical_finding_id == null ? null : String(row.canonical_finding_id),
    is_canonical: row.is_canonical == null ? null : Boolean(row.is_canonical),
    dedupe_reason: row.dedupe_reason == null ? null : String(row.dedupe_reason),
    priority_score: row.priority_score == null ? null : Number(row.priority_score),
    priority_reason: row.priority_reason == null ? null : String(row.priority_reason),
    priority_model: row.priority_model == null ? null : String(row.priority_model),
    priority_prompt_revision: row.priority_prompt_revision == null ? null : String(row.priority_prompt_revision),
    last_run_id: row.last_run_id == null ? null : String(row.last_run_id),
  };
}
