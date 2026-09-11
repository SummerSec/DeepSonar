import { sql } from "../../db.js";
import { FINDING_DISPOSITIONS } from "../../finding-disposition.js";
import { FINDING_VERIFY_KEYS, fillCountBuckets, type CountBucket } from "../finding-verification/project-findings-summary.js";
import { DASHBOARD_CALENDAR_TIMEZONE } from "./overview.js";

export const QUALITY_FINDING_COST_LIMIT = 50;
export const QUALITY_SLICE_LIMIT = 16;

export type QualityScopeKind = "global" | "project" | "task";

export interface QualityScope {
  kind: QualityScopeKind;
  project_id: string | null;
  canvas_id: string | null;
}

export interface QualityRate {
  rate: number | null;
  numerator: number;
  denominator: number;
}

export interface QualityFindingCost {
  finding_id: string;
  title: string;
  verify_status: string;
  tokens: number;
  duration_ms: number;
  job_count: number;
}

export interface QualitySliceRow {
  key: string;
  findings: number;
  confirmed: number;
  false_positive: number;
  confirmation_rate: number | null;
  tokens: number;
}

export interface QualityReport {
  generated_at: string;
  calendar_timezone: string;
  query_plane: "current";
  scope: QualityScope;
  findings: {
    total: number;
    verify_status: CountBucket[];
    disposition: CountBucket[];
    confirmation: QualityRate;
    false_positive: QualityRate;
  };
  verify: {
    rounds: { total: number; finished: number; with_both_verdicts: number; disagreed: number; rework: number };
    disagreement: QualityRate;
    rework: QualityRate;
  };
  human: {
    jobs_waiting: number;
    jobs_requested: number;
    findings_needs_human: number;
    canvases_intervened: number;
    canvases_with_work: number;
    intervention: QualityRate;
  };
  cost: {
    findings_with_cost: number;
    total_tokens: number;
    avg_tokens_per_finding: number | null;
    total_duration_ms: number;
    avg_duration_ms_per_finding: number | null;
    per_finding: QualityFindingCost[];
    truncated: boolean;
    limit: number;
  };
  slices: {
    by_model: QualitySliceRow[];
    by_runtime_image: QualitySliceRow[];
    by_profile: QualitySliceRow[];
  };
}

export interface QualityFindingRow {
  id: string;
  project_id: string;
  canvas_id: string | null;
  job_id: string;
  title: string;
  verify_status: string;
  disposition: string;
  profile: string;
  created_at: string;
}

export interface QualityVerifyRoundRow {
  finding_id: string;
  status: string;
  proposed_verdict: string | null;
  final_outcome: string | null;
  verify_job_id: string | null;
}

export interface QualityJobRow {
  id: string;
  project_id: string;
  canvas_id: string | null;
  parent_job_id: string | null;
  type: string;
  status: string;
  finding_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
  agent_snapshot_json: unknown;
  payload_json: unknown;
}

export interface QualityEventRow {
  job_id: string;
  type: string;
  event_id: string;
  payload_json: unknown;
  created_at: string;
}

export interface QualityUsageRow {
  job_id: string;
  total_tokens: number;
  provider: string;
  model: string;
}

export interface QualityContext {
  now: Date;
  scope: QualityScope;
  findings: QualityFindingRow[];
  rounds: QualityVerifyRoundRow[];
  jobs: QualityJobRow[];
  events: QualityEventRow[];
  usage: QualityUsageRow[];
  humanCanvasIds: string[];
  canvases: Array<{ id: string; project_id: string; title: string }>;
}

export function qualityRate(numerator: number, denominator: number): QualityRate {
  const n = Math.max(0, Math.trunc(numerator));
  const d = Math.max(0, Math.trunc(denominator));
  return { rate: d > 0 ? Number((n / d).toFixed(4)) : null, numerator: n, denominator: d };
}

export function classifyFindingOutcome(row: Pick<QualityFindingRow, "verify_status" | "disposition">):
  "confirmed" | "false_positive" | "needs_human" | "open" {
  if (row.disposition === "rejected_fp" || row.verify_status === "false_positive") return "false_positive";
  if (row.verify_status === "confirmed") return "confirmed";
  if (row.verify_status === "needs_human") return "needs_human";
  return "open";
}

export function durationMs(startedAt: string | null | undefined, finishedAt: string | null | undefined): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.trunc(end - start);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function snapshotStrategy(snapshot: unknown): {
  model: string | null;
  provider: string | null;
  agent_cli: string | null;
  runtime_image_key: string | null;
  runtime_image_digest: string | null;
} {
  const root = asRecord(snapshot);
  const image = asRecord(root.runtime_image);
  const model = typeof root.model === "string" && root.model.trim() ? root.model.trim() : null;
  const provider = typeof root.provider === "string" && root.provider.trim()
    ? root.provider.trim()
    : typeof asRecord(root.credential).provider === "string"
      ? String(asRecord(root.credential).provider)
      : null;
  const agentCli = typeof root.agent_cli === "string" && root.agent_cli.trim() ? root.agent_cli.trim() : null;
  const imageKey = typeof image.image_key === "string" && image.image_key.trim()
    ? image.image_key.trim()
    : typeof root.runtime_image_key === "string" && root.runtime_image_key.trim()
      ? root.runtime_image_key.trim()
      : null;
  const digest = typeof image.digest === "string" && image.digest.trim()
    ? image.digest.trim()
    : typeof image.image_digest === "string" && image.image_digest.trim()
      ? image.image_digest.trim()
      : null;
  return { model, provider, agent_cli: agentCli, runtime_image_key: imageKey, runtime_image_digest: digest };
}

export function attributeFindingCosts(input: {
  findings: readonly QualityFindingRow[];
  jobs: readonly QualityJobRow[];
  rounds: readonly QualityVerifyRoundRow[];
  usage: readonly QualityUsageRow[];
}): Map<string, { tokens: number; duration_ms: number; job_count: number }> {
  const tokensByJob = new Map<string, number>();
  for (const row of input.usage) {
    tokensByJob.set(row.job_id, (tokensByJob.get(row.job_id) ?? 0) + Math.max(0, Math.trunc(row.total_tokens)));
  }
  const durationByJob = new Map<string, number>();
  for (const job of input.jobs) {
    const ms = durationMs(job.started_at, job.finished_at);
    if (ms !== null) durationByJob.set(job.id, ms);
  }
  const originShare = new Map<string, number>();
  for (const finding of input.findings) {
    originShare.set(finding.job_id, (originShare.get(finding.job_id) ?? 0) + 1);
  }
  const jobsByFinding = new Map<string, Set<string>>();
  const add = (findingId: string, jobId: string | null | undefined) => {
    if (!jobId) return;
    const set = jobsByFinding.get(findingId) ?? new Set<string>();
    set.add(jobId);
    jobsByFinding.set(findingId, set);
  };
  for (const finding of input.findings) {
    add(finding.id, finding.job_id);
  }
  for (const job of input.jobs) {
    if (job.finding_id) add(job.finding_id, job.id);
  }
  for (const round of input.rounds) {
    add(round.finding_id, round.verify_job_id);
  }

  const costs = new Map<string, { tokens: number; duration_ms: number; job_count: number }>();
  for (const finding of input.findings) {
    let tokens = 0;
    let duration = 0;
    const jobIds = jobsByFinding.get(finding.id) ?? new Set<string>();
    for (const jobId of jobIds) {
      const share = jobId === finding.job_id ? 1 / Math.max(1, originShare.get(jobId) ?? 1) : 1;
      tokens += (tokensByJob.get(jobId) ?? 0) * share;
      duration += (durationByJob.get(jobId) ?? 0) * share;
    }
    costs.set(finding.id, {
      tokens: Math.round(tokens),
      duration_ms: Math.round(duration),
      job_count: jobIds.size,
    });
  }
  return costs;
}

function sliceRows(
  findings: readonly QualityFindingRow[],
  keyOf: (finding: QualityFindingRow) => string,
  costs: Map<string, { tokens: number }>,
): QualitySliceRow[] {
  const groups = new Map<string, QualitySliceRow & { needs_human: number }>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const row = groups.get(key) ?? {
      key,
      findings: 0,
      confirmed: 0,
      false_positive: 0,
      needs_human: 0,
      confirmation_rate: null,
      tokens: 0,
    };
    row.findings += 1;
    const outcome = classifyFindingOutcome(finding);
    if (outcome === "confirmed") row.confirmed += 1;
    else if (outcome === "false_positive") row.false_positive += 1;
    else if (outcome === "needs_human") row.needs_human += 1;
    row.tokens += costs.get(finding.id)?.tokens ?? 0;
    groups.set(key, row);
  }
  return [...groups.values()]
    .map(({ needs_human, ...row }) => ({
      ...row,
      confirmation_rate: qualityRate(row.confirmed, row.confirmed + row.false_positive + needs_human).rate,
    }))
    .sort((left, right) => right.findings - left.findings || left.key.localeCompare(right.key))
    .slice(0, QUALITY_SLICE_LIMIT);
}

export function buildQualityReport(input: QualityContext): QualityReport {
  const findings = input.findings;
  let confirmed = 0;
  let falsePositive = 0;
  let needsHuman = 0;
  const verifyBuckets = new Map<string, number>();
  const dispositionBuckets = new Map<string, number>();
  for (const finding of findings) {
    verifyBuckets.set(finding.verify_status, (verifyBuckets.get(finding.verify_status) ?? 0) + 1);
    dispositionBuckets.set(finding.disposition, (dispositionBuckets.get(finding.disposition) ?? 0) + 1);
    const outcome = classifyFindingOutcome(finding);
    if (outcome === "confirmed") confirmed += 1;
    else if (outcome === "false_positive") falsePositive += 1;
    else if (outcome === "needs_human") needsHuman += 1;
  }

  const finishedRound = new Set(["confirmed", "rework", "needs_human", "failed"]);
  let bothVerdicts = 0;
  let disagreed = 0;
  let reworkRounds = 0;
  const reworkFindings = new Set<string>();
  const enteredVerify = new Set<string>();
  for (const finding of findings) {
    if (finding.verify_status !== "pending") enteredVerify.add(finding.id);
  }
  for (const round of input.rounds) {
    enteredVerify.add(round.finding_id);
    if (round.status === "rework" || round.final_outcome === "rework") {
      reworkRounds += 1;
      reworkFindings.add(round.finding_id);
    }
    if (round.proposed_verdict && round.final_outcome) {
      bothVerdicts += 1;
      if (round.proposed_verdict !== round.final_outcome) disagreed += 1;
    }
  }

  const jobsWaiting = input.jobs.filter((job) => job.status === "waiting_human").length;
  const jobsRequested = new Set(input.events.filter((event) => event.type === "human").map((event) => event.job_id)).size;
  const intervened = new Set<string>();
  for (const job of input.jobs) {
    if (job.status === "waiting_human" && job.canvas_id) intervened.add(job.canvas_id);
  }
  for (const event of input.events) {
    if (event.type !== "human") continue;
    const job = input.jobs.find((item) => item.id === event.job_id);
    if (job?.canvas_id) intervened.add(job.canvas_id);
  }
  for (const finding of findings) {
    if (classifyFindingOutcome(finding) === "needs_human" && finding.canvas_id) intervened.add(finding.canvas_id);
  }
  for (const canvasId of input.humanCanvasIds) intervened.add(canvasId);
  const canvasesWithWork = new Set(input.jobs.map((job) => job.canvas_id).filter((id): id is string => Boolean(id)));
  const intervenedAtWork = [...intervened].filter((id) => canvasesWithWork.has(id)).length;

  const costs = attributeFindingCosts(input);
  const perFinding = findings
    .map((finding) => {
      const cost = costs.get(finding.id) ?? { tokens: 0, duration_ms: 0, job_count: 0 };
      return {
        finding_id: finding.id,
        title: finding.title || "发现",
        verify_status: finding.verify_status,
        tokens: cost.tokens,
        duration_ms: cost.duration_ms,
        job_count: cost.job_count,
      };
    })
    .sort((left, right) => right.tokens - left.tokens || left.finding_id.localeCompare(right.finding_id));
  const findingsWithCost = perFinding.filter((item) => item.tokens > 0 || item.duration_ms > 0).length;
  const totalTokens = perFinding.reduce((sum, item) => sum + item.tokens, 0);
  const totalDuration = perFinding.reduce((sum, item) => sum + item.duration_ms, 0);
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));

  return {
    generated_at: input.now.toISOString(),
    calendar_timezone: DASHBOARD_CALENDAR_TIMEZONE,
    query_plane: "current",
    scope: input.scope,
    findings: {
      total: findings.length,
      verify_status: fillCountBuckets(FINDING_VERIFY_KEYS, [...verifyBuckets].map(([key, count]) => ({ key, count }))),
      disposition: fillCountBuckets(FINDING_DISPOSITIONS, [...dispositionBuckets].map(([key, count]) => ({ key, count }))),
      confirmation: qualityRate(confirmed, confirmed + falsePositive + needsHuman),
      false_positive: qualityRate(falsePositive, confirmed + falsePositive),
    },
    verify: {
      rounds: {
        total: input.rounds.length,
        finished: input.rounds.filter((round) => finishedRound.has(round.status)).length,
        with_both_verdicts: bothVerdicts,
        disagreed,
        rework: reworkRounds,
      },
      disagreement: qualityRate(disagreed, bothVerdicts),
      rework: qualityRate(reworkFindings.size, enteredVerify.size),
    },
    human: {
      jobs_waiting: jobsWaiting,
      jobs_requested: jobsRequested,
      findings_needs_human: needsHuman,
      canvases_intervened: intervened.size,
      canvases_with_work: canvasesWithWork.size,
      intervention: qualityRate(intervenedAtWork, canvasesWithWork.size),
    },
    cost: {
      findings_with_cost: findingsWithCost,
      total_tokens: totalTokens,
      avg_tokens_per_finding: findings.length ? Math.round(totalTokens / findings.length) : null,
      total_duration_ms: totalDuration,
      avg_duration_ms_per_finding: findings.length ? Math.round(totalDuration / findings.length) : null,
      per_finding: perFinding.slice(0, QUALITY_FINDING_COST_LIMIT),
      truncated: perFinding.length > QUALITY_FINDING_COST_LIMIT,
      limit: QUALITY_FINDING_COST_LIMIT,
    },
    slices: {
      by_model: sliceRows(findings, (finding) => snapshotStrategy(jobsById.get(finding.job_id)?.agent_snapshot_json).model ?? "unset", costs),
      by_runtime_image: sliceRows(findings, (finding) => snapshotStrategy(jobsById.get(finding.job_id)?.agent_snapshot_json).runtime_image_key ?? "unset", costs),
      by_profile: sliceRows(findings, (finding) => finding.profile || "unset", costs),
    },
  };
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export async function loadQualityContext(
  scope: QualityScope,
  now: Date = new Date(),
): Promise<QualityContext> {
  const projectId = scope.project_id;
  const canvasId = scope.canvas_id;
  const [findingRows, roundRows, jobRows, eventRows, usageRows, humanRows, canvasRows] = await Promise.all([
    sql<Record<string, unknown>[]>`
      SELECT f.id, f.project_id, j.canvas_id, f.job_id, f.title, f.verify_status, f.disposition,
             f.profile, f.created_at
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId}::text)`,
    sql<Record<string, unknown>[]>`
      SELECT r.finding_id, r.status, r.proposed_verdict, r.final_outcome, r.verify_job_id
      FROM finding_verification_rounds r
      JOIN findings f ON f.id = r.finding_id
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId}::text)`,
    sql<Record<string, unknown>[]>`
      SELECT id, project_id, canvas_id, parent_job_id, type, status, finding_id, started_at, finished_at,
             created_at, error, agent_snapshot_json, payload_json
      FROM jobs
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR canvas_id = ${canvasId}::text)`,
    sql<Record<string, unknown>[]>`
      SELECT e.job_id, e.type, e.event_id, e.payload_json, e.created_at
      FROM events e
      JOIN jobs j ON j.id = e.job_id
      WHERE e.type IN ('hub_decision', 'human', 'done')
        AND (${projectId}::uuid IS NULL OR j.project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId}::text)`,
    sql<Record<string, unknown>[]>`
      SELECT u.job_id, u.total_tokens, u.provider, u.model
      FROM job_usage_ledger u
      JOIN jobs j ON j.id = u.job_id
      WHERE (${projectId}::uuid IS NULL OR u.project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId}::text)`,
    sql<{ canvas_id: string }[]>`
      SELECT DISTINCT n.canvas_id
      FROM canvas_nodes n
      JOIN canvases c ON c.id = n.canvas_id
      WHERE n.node_type = 'human'
        AND (${projectId}::uuid IS NULL OR c.project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR n.canvas_id = ${canvasId}::text)`,
    sql<{ id: string; project_id: string; title: string }[]>`
      SELECT id, project_id, title FROM canvases
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
        AND (${canvasId}::text IS NULL OR id = ${canvasId}::text)`,
  ]);

  return {
    now,
    scope,
    findings: findingRows.map((row) => ({
      id: asText(row.id),
      project_id: asText(row.project_id),
      canvas_id: typeof row.canvas_id === "string" && row.canvas_id ? row.canvas_id : null,
      job_id: asText(row.job_id),
      title: asText(row.title),
      verify_status: asText(row.verify_status) || "pending",
      disposition: asText(row.disposition) || "open",
      profile: asText(row.profile) || "security.vulnerability",
      created_at: asIso(row.created_at) ?? now.toISOString(),
    })),
    rounds: roundRows.map((row) => ({
      finding_id: asText(row.finding_id),
      status: asText(row.status) || "pending",
      proposed_verdict: typeof row.proposed_verdict === "string" ? row.proposed_verdict : null,
      final_outcome: typeof row.final_outcome === "string" ? row.final_outcome : null,
      verify_job_id: typeof row.verify_job_id === "string" ? row.verify_job_id : null,
    })),
    jobs: jobRows.map((row) => ({
      id: asText(row.id),
      project_id: asText(row.project_id),
      canvas_id: typeof row.canvas_id === "string" && row.canvas_id ? row.canvas_id : null,
      parent_job_id: typeof row.parent_job_id === "string" ? row.parent_job_id : null,
      type: asText(row.type),
      status: asText(row.status),
      finding_id: typeof row.finding_id === "string" ? row.finding_id : null,
      started_at: asIso(row.started_at),
      finished_at: asIso(row.finished_at),
      created_at: asIso(row.created_at) ?? now.toISOString(),
      error: typeof row.error === "string" ? row.error : null,
      agent_snapshot_json: row.agent_snapshot_json,
      payload_json: row.payload_json,
    })),
    events: eventRows.map((row) => ({
      job_id: asText(row.job_id),
      type: asText(row.type),
      event_id: asText(row.event_id),
      payload_json: row.payload_json,
      created_at: asIso(row.created_at) ?? now.toISOString(),
    })),
    usage: usageRows.map((row) => ({
      job_id: asText(row.job_id),
      total_tokens: asCount(row.total_tokens),
      provider: asText(row.provider),
      model: asText(row.model),
    })),
    humanCanvasIds: humanRows.map((row) => asText(row.canvas_id)).filter(Boolean),
    canvases: canvasRows.map((row) => ({
      id: asText(row.id),
      project_id: asText(row.project_id),
      title: asText(row.title),
    })),
  };
}
