import {
  asRecord,
  attributeFindingCosts,
  buildQualityReport,
  classifyFindingOutcome,
  durationMs,
  snapshotStrategy,
  type QualityContext,
  type QualityFindingRow,
  type QualityJobRow,
  type QualityReport,
} from "./quality.js";

/** Frozen Hub replay / baseline record format. Phase 1 derives records; later
 * phases compare against this schema. Recalled experiences stay empty until Phase 3. */
export const HUB_REPLAY_SCHEMA_VERSION = 1;
export const HUB_REPLAY_RECORD_KIND = "hub_replay" as const;
export const HUB_REPLAY_DEFAULT_LIMIT = 50;
export const HUB_REPLAY_MAX_LIMIT = 200;

export interface HubReplayIntent {
  role: string;
  description: string;
  runtime_image_key: string | null;
}

export interface HubReplayRecord {
  schema_version: typeof HUB_REPLAY_SCHEMA_VERSION;
  record_kind: typeof HUB_REPLAY_RECORD_KIND;
  job_id: string;
  project_id: string;
  canvas_id: string;
  round_index: number;
  recorded_at: string;
  input: {
    trigger: unknown;
    scheduling_purpose: string | null;
    canvas_title: string;
    finding_counts: {
      total: number;
      confirmed: number;
      false_positive: number;
      needs_human: number;
      open: number;
    };
  };
  recalled_experiences: [];
  plan: {
    kind: "complete" | "intents" | "payload_file" | "none";
    complete_description: string | null;
    intents: HubReplayIntent[];
    event_id: string | null;
  };
  execution: {
    hub_status: string;
    child_jobs: Array<{ id: string; type: string; status: string; finding_id: string | null }>;
  };
  termination: {
    reason: string;
    error: string | null;
  };
  quality: {
    confirmation_rate: number | null;
    false_positive_rate: number | null;
    verify_disagreement_rate: number | null;
    human_intervention_rate: number | null;
  };
  cost: {
    hub_tokens: number;
    canvas_tokens: number;
    hub_duration_ms: number | null;
    canvas_duration_ms: number | null;
  };
  strategy: {
    model: string | null;
    provider: string | null;
    agent_cli: string | null;
    runtime_image_key: string | null;
    runtime_image_digest: string | null;
  };
}

export interface HubReplayBaseline {
  generated_at: string;
  query_plane: "history";
  format: {
    schema_version: typeof HUB_REPLAY_SCHEMA_VERSION;
    record_kind: typeof HUB_REPLAY_RECORD_KIND;
  };
  scope: QualityContext["scope"];
  total: number;
  truncated: boolean;
  limit: number;
  records: HubReplayRecord[];
}

export function parseReplayLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return HUB_REPLAY_DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return HUB_REPLAY_DEFAULT_LIMIT;
  return Math.min(HUB_REPLAY_MAX_LIMIT, Math.trunc(n));
}

export function parseHubPlan(payload: unknown, eventId: string | null): HubReplayRecord["plan"] {
  const root = asRecord(payload);
  if (root.complete !== undefined) {
    const complete = asRecord(root.complete);
    return {
      kind: "complete",
      complete_description: typeof complete.description === "string" ? complete.description : null,
      intents: [],
      event_id: eventId,
    };
  }
  if (Array.isArray(root.intents)) {
    return {
      kind: "intents",
      complete_description: null,
      intents: root.intents.map((item) => {
        const intent = asRecord(item);
        return {
          role: typeof intent.role === "string" ? intent.role : "",
          description: typeof intent.description === "string" ? intent.description : "",
          runtime_image_key: typeof intent.runtime_image_key === "string" ? intent.runtime_image_key : null,
        };
      }),
      event_id: eventId,
    };
  }
  if (typeof root.payload_file === "string" && root.payload_file) {
    return { kind: "payload_file", complete_description: null, intents: [], event_id: eventId };
  }
  return { kind: "none", complete_description: null, intents: [], event_id: eventId };
}

function findingCountsAt(findings: readonly QualityFindingRow[], at: string): HubReplayRecord["input"]["finding_counts"] {
  const counts = { total: 0, confirmed: 0, false_positive: 0, needs_human: 0, open: 0 };
  for (const finding of findings) {
    if (finding.created_at > at) continue;
    counts.total += 1;
    counts[classifyFindingOutcome(finding)] += 1;
  }
  return counts;
}

function canvasDurationMs(jobs: readonly QualityJobRow[]): number | null {
  let total = 0;
  let any = false;
  for (const job of jobs) {
    const ms = durationMs(job.started_at, job.finished_at);
    if (ms === null) continue;
    total += ms;
    any = true;
  }
  return any ? total : null;
}

function qualityRates(report: QualityReport): HubReplayRecord["quality"] {
  return {
    confirmation_rate: report.findings.confirmation.rate,
    false_positive_rate: report.findings.false_positive.rate,
    verify_disagreement_rate: report.verify.disagreement.rate,
    human_intervention_rate: report.human.intervention.rate,
  };
}

function contextForCanvas(input: QualityContext, canvasId: string, projectId: string): QualityContext {
  return {
    ...input,
    scope: { kind: "task", project_id: projectId, canvas_id: canvasId },
    findings: input.findings.filter((finding) => finding.canvas_id === canvasId),
    jobs: input.jobs.filter((job) => job.canvas_id === canvasId),
    events: input.events.filter((event) => input.jobs.some((job) => job.id === event.job_id && job.canvas_id === canvasId)),
    usage: input.usage.filter((row) => input.jobs.some((job) => job.id === row.job_id && job.canvas_id === canvasId)),
    rounds: input.rounds.filter((round) => input.findings.some((finding) => finding.id === round.finding_id && finding.canvas_id === canvasId)),
    humanCanvasIds: input.humanCanvasIds.filter((id) => id === canvasId),
    canvases: input.canvases.filter((canvas) => canvas.id === canvasId),
  };
}

export function buildReplayBaseline(input: QualityContext, limit: number = HUB_REPLAY_DEFAULT_LIMIT): HubReplayBaseline {
  const tokensByJob = new Map<string, number>();
  for (const row of input.usage) {
    tokensByJob.set(row.job_id, (tokensByJob.get(row.job_id) ?? 0) + Math.max(0, Math.trunc(row.total_tokens)));
  }
  const canvasTitle = new Map(input.canvases.map((canvas) => [canvas.id, canvas.title]));
  const jobsByCanvas = new Map<string, QualityJobRow[]>();
  const childrenByParent = new Map<string, QualityJobRow[]>();
  for (const job of input.jobs) {
    if (job.canvas_id) {
      const list = jobsByCanvas.get(job.canvas_id) ?? [];
      list.push(job);
      jobsByCanvas.set(job.canvas_id, list);
    }
    if (job.parent_job_id) {
      const children = childrenByParent.get(job.parent_job_id) ?? [];
      children.push(job);
      childrenByParent.set(job.parent_job_id, children);
    }
  }
  const eventsByJob = new Map<string, QualityContext["events"]>();
  for (const event of input.events) {
    const list = eventsByJob.get(event.job_id) ?? [];
    list.push(event);
    eventsByJob.set(event.job_id, list);
  }

  const hubJobs = input.jobs
    .filter((job) => job.type === "hub_reason" && job.canvas_id)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
  const roundIndex = new Map<string, number>();
  const canvasRound = new Map<string, number>();
  for (const job of hubJobs) {
    const next = (canvasRound.get(job.canvas_id!) ?? 0) + 1;
    canvasRound.set(job.canvas_id!, next);
    roundIndex.set(job.id, next);
  }

  const qualityByCanvas = new Map<string, QualityReport>();
  const tokensByCanvas = new Map<string, number>();
  for (const canvasId of new Set(hubJobs.map((job) => job.canvas_id!))) {
    const scoped = contextForCanvas(input, canvasId, hubJobs.find((job) => job.canvas_id === canvasId)!.project_id);
    qualityByCanvas.set(canvasId, buildQualityReport(scoped));
    const findingCosts = attributeFindingCosts(scoped);
    let tokens = scoped.jobs.filter((job) => job.type === "hub_reason")
      .reduce((sum, job) => sum + (tokensByJob.get(job.id) ?? 0), 0);
    for (const finding of scoped.findings) tokens += findingCosts.get(finding.id)?.tokens ?? 0;
    tokensByCanvas.set(canvasId, tokens);
  }

  const records = hubJobs.map((job) => {
    const decision = (eventsByJob.get(job.id) ?? []).find((event) => event.type === "hub_decision");
    const canvasJobs = jobsByCanvas.get(job.canvas_id!) ?? [];
    const children = (childrenByParent.get(job.id) ?? [])
      .map((child) => ({
        id: child.id,
        type: child.type,
        status: child.status,
        finding_id: child.finding_id,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      schema_version: HUB_REPLAY_SCHEMA_VERSION,
      record_kind: HUB_REPLAY_RECORD_KIND,
      job_id: job.id,
      project_id: job.project_id,
      canvas_id: job.canvas_id!,
      round_index: roundIndex.get(job.id) ?? 1,
      recorded_at: job.finished_at ?? job.created_at,
      input: {
        trigger: asRecord(job.payload_json).trigger ?? null,
        scheduling_purpose: typeof asRecord(job.payload_json).scheduling_purpose === "string"
          ? String(asRecord(job.payload_json).scheduling_purpose)
          : null,
        canvas_title: canvasTitle.get(job.canvas_id!) || job.canvas_id!,
        finding_counts: findingCountsAt(
          input.findings.filter((finding) => finding.canvas_id === job.canvas_id),
          job.created_at,
        ),
      },
      recalled_experiences: [] as [],
      plan: parseHubPlan(decision?.payload_json, decision?.event_id ?? null),
      execution: {
        hub_status: job.status,
        child_jobs: children,
      },
      termination: {
        reason: job.status,
        error: job.error,
      },
      quality: qualityRates(qualityByCanvas.get(job.canvas_id!)!),
      cost: {
        hub_tokens: tokensByJob.get(job.id) ?? 0,
        canvas_tokens: tokensByCanvas.get(job.canvas_id!) ?? 0,
        hub_duration_ms: durationMs(job.started_at, job.finished_at),
        canvas_duration_ms: canvasDurationMs(canvasJobs),
      },
      strategy: snapshotStrategy(job.agent_snapshot_json),
    } satisfies HubReplayRecord;
  });

  const bounded = parseReplayLimit(limit);
  return {
    generated_at: input.now.toISOString(),
    query_plane: "history",
    format: { schema_version: HUB_REPLAY_SCHEMA_VERSION, record_kind: HUB_REPLAY_RECORD_KIND },
    scope: input.scope,
    total: records.length,
    truncated: records.length > bounded,
    limit: bounded,
    records: records.slice(0, bounded),
  };
}
