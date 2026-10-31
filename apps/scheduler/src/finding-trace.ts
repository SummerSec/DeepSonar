import { sql } from "./db.js";
import { buildEvidenceSnapshot } from "./verify.js";

type Tx = typeof sql;
type JsonRecord = Record<string, unknown>;

export interface FindingTraceEvidence {
  node_id: string;
  job_id: string;
  job_type: string;
  job_status: string;
  outcome: string;
  title: string;
  at: string | Date;
}

export interface FindingTrace {
  source: {
    job_id: string;
    job_type: string;
    job_status: string;
    node_id: string | null;
    job_node_id: string | null;
    canvas_id: string;
    at: string | Date;
  };
  evidence: {
    review: FindingTraceEvidence[];
    test: FindingTraceEvidence[];
  };
  rounds: Array<{
    attempt: number;
    status: string;
    outcome: string | null;
    verify_job_id: string | null;
    missing: string[];
    summary: string | null;
    proposed_verdict: string | null;
    at: string | Date;
    finished_at: string | Date | null;
  }>;
  intents: Array<{
    node_id: string;
    role: string;
    status: string | null;
    job_id: string;
    description: string;
    at: string | Date;
  }>;
  hubs: Array<{
    job_id: string;
    node_id: string | null;
    trigger_kind: string;
    status: string;
    at: string | Date;
    confidence: "exact";
  }>;
  flow: {
    nodes: Array<{
      node_id: string;
      node_type: string;
      title: string;
      status: string | null;
      job_id: string | null;
      role: string | null;
      at: string | Date;
    }>;
    edges: Array<{
      edge_id: string;
      from_node_id: string;
      to_node_id: string;
      edge_type: string;
    }>;
  };
  gaps: string[];
  node_ids: string[];
  edge_ids: string[];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function boundedText(value: unknown, max = 500): string {
  return String(value ?? "").slice(0, max);
}

function exactTriggerFindingIds(payloadValue: unknown): Set<string> {
  const payload = record(payloadValue);
  const trigger = record(payload.trigger);
  const ids = new Set<string>();
  if (typeof trigger.finding_id === "string") ids.add(trigger.finding_id);
  if (Array.isArray(trigger.problems)) {
    for (const problem of trigger.problems) {
      const findingId = record(problem).finding_id;
      if (typeof findingId === "string") ids.add(findingId);
    }
  }
  return ids;
}

function snapshotEvidence(rounds: readonly JsonRecord[], kind: "review" | "test"): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const round of rounds) {
    const snapshot = record(round.evidence_snapshot_json);
    const values = snapshot[kind];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const evidence = record(value);
      rows.push({
        ...evidence,
        at: evidence.at ?? evidence.created_at ?? round.created_at ?? "",
      });
    }
  }
  return rows;
}

function normalizeEvidence(
  live: readonly JsonRecord[],
  rounds: readonly JsonRecord[],
  kind: "review" | "test",
): FindingTraceEvidence[] {
  const byNode = new Map<string, FindingTraceEvidence>();
  const add = (row: JsonRecord) => {
    const nodeId = typeof row.node_id === "string" ? row.node_id : typeof row.id === "string" ? row.id : null;
    const jobId = typeof row.job_id === "string" ? row.job_id : null;
    if (!nodeId || !jobId) return;
    byNode.set(nodeId, {
      node_id: nodeId,
      job_id: jobId,
      job_type: boundedText(row.job_type ?? row.source_role ?? "unknown", 80),
      job_status: boundedText(row.job_status ?? "unknown", 40),
      outcome: boundedText(row.outcome ?? "unknown", 40),
      title: boundedText(row.title ?? `${kind} evidence`, 300),
      at: (row.at ?? row.created_at ?? "") as string | Date,
    });
  };
  for (const row of snapshotEvidence(rounds, kind)) add(row);
  for (const row of live) {
    const verification = record(record(row.body_json).verification);
    if (verification.evidence_kind !== kind) continue;
    add({
      ...row,
      node_id: row.id,
      outcome: verification.outcome,
      source_role: verification.source_role,
      at: row.created_at,
    });
  }
  return [...byNode.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Build the read-only, bounded Finding execution trace from structural links only. */
export async function loadFindingTrace(
  tx: Tx,
  finding: JsonRecord,
  verificationRounds: readonly JsonRecord[],
): Promise<FindingTrace> {
  const findingId = String(finding.id);
  const canvasId = String(finding.canvas_id);
  const sourceJobId = String(finding.job_id);
  const boundedRounds = verificationRounds.slice(0, 1000);
  let traceTruncated = verificationRounds.length > boundedRounds.length;

  const [liveEvidence, sourceJobNodes, verifyJobs, hubJobs] = await Promise.all([
    tx`
      SELECT n.id, n.job_id, n.title, n.body_json, n.created_at,
             j.type AS job_type, j.status AS job_status
      FROM canvas_nodes n
      JOIN jobs j ON j.id = n.job_id
      WHERE n.canvas_id = ${canvasId}
        AND n.node_type = 'fact'
        AND n.body_json ? 'verification'
        AND n.body_json->'verification'->>'finding_id' = ${findingId}
        AND j.status = 'succeeded'
      ORDER BY n.created_at, n.id
      LIMIT 1001`,
    tx`
      SELECT id, node_type, job_id, title, body_json, status, created_at
      FROM canvas_nodes
      WHERE canvas_id = ${canvasId}
        AND job_id = ${sourceJobId}
        AND node_type IN ('job', 'intent')
      ORDER BY created_at, id
      LIMIT 101`,
    tx`
      SELECT id, type, status, created_at
      FROM jobs
      WHERE canvas_id = ${canvasId}
        AND (finding_id = ${findingId}
          OR id = ANY(${verificationRounds
            .map((round) => round.verify_job_id)
            .filter((id): id is string => typeof id === "string")}::uuid[]))
      ORDER BY created_at, id
      LIMIT 101`,
    tx`
      SELECT id, status, payload_json, created_at
      FROM jobs
      WHERE canvas_id = ${canvasId}
        AND type = 'hub_reason'
        AND (
          payload_json->'trigger'->>'finding_id' = ${findingId}
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(payload_json->'trigger'->'problems') = 'array'
                  THEN payload_json->'trigger'->'problems'
                ELSE '[]'::jsonb
              END
            ) AS problem
            WHERE problem->>'finding_id' = ${findingId}
          )
        )
      ORDER BY created_at, id
      LIMIT 501`,
  ]);

  traceTruncated ||= liveEvidence.length > 1000 || sourceJobNodes.length > 100 || verifyJobs.length > 100 || hubJobs.length > 500;
  const boundedLiveEvidence = (liveEvidence as JsonRecord[]).slice(0, 1000);
  const boundedSourceJobNodes = (sourceJobNodes as JsonRecord[]).slice(0, 100);
  const boundedVerifyJobs = (verifyJobs as JsonRecord[]).slice(0, 100);
  const boundedHubJobs = (hubJobs as JsonRecord[]).slice(0, 500);
  const currentEvidence = buildEvidenceSnapshot(boundedLiveEvidence, sourceJobId);
  const qualifiedNodeIds = new Set(
    [...currentEvidence.review, ...currentEvidence.test].map((row) => String(row.node_id)),
  );
  const qualifiedLiveEvidence = boundedLiveEvidence
    .filter((row) => qualifiedNodeIds.has(String(row.id)));
  const review = normalizeEvidence(qualifiedLiveEvidence, boundedRounds, "review");
  const test = normalizeEvidence(qualifiedLiveEvidence, boundedRounds, "test");
  const exactHubs = boundedHubJobs.filter((job) => exactTriggerFindingIds(job.payload_json).has(findingId));
  const evidenceNodeIds = [...review, ...test].map((item) => item.node_id);
  const evidenceJobIds = [...new Set([...review, ...test].map((item) => item.job_id))];
  const verifyJobIds = boundedVerifyJobs.map((job) => String(job.id));
  const hubJobIds = exactHubs.map((job) => String(job.id));
  const structuralAnchorIds = [
    ...(typeof finding.node_id === "string" ? [finding.node_id] : []),
    ...evidenceNodeIds,
  ];
  const structuralNeighbors = structuralAnchorIds.length > 0
    ? await tx`
        SELECT DISTINCT n.id
        FROM canvas_edges e
        JOIN canvas_nodes n ON n.canvas_id = e.canvas_id AND (
          (e.from_node_id = ANY(${structuralAnchorIds}::uuid[]) AND n.id = e.to_node_id)
          OR (e.to_node_id = ANY(${structuralAnchorIds}::uuid[]) AND n.id = e.from_node_id)
        )
        WHERE e.canvas_id = ${canvasId}
          AND n.node_type IN ('intent', 'fact')
        ORDER BY n.id
        LIMIT 501`
    : [];
  traceTruncated ||= structuralNeighbors.length > 500;
  const anchorNodeIds = [...new Set([
    ...structuralAnchorIds,
    ...(structuralNeighbors as JsonRecord[]).slice(0, 500).map((node) => String(node.id)),
  ])];
  const relatedJobNodes = await tx`
    SELECT id, node_type, job_id, title, body_json, status, created_at
    FROM canvas_nodes
    WHERE canvas_id = ${canvasId}
      AND (
        id = ANY(${anchorNodeIds}::uuid[])
        OR (job_id = ${sourceJobId} AND node_type IN ('job', 'intent'))
        OR (job_id = ANY(${evidenceJobIds}::uuid[]) AND node_type = 'intent')
        OR (job_id = ANY(${verifyJobIds}::uuid[]) AND node_type IN ('job', 'intent'))
        OR (job_id = ANY(${hubJobIds}::uuid[]) AND node_type IN ('job', 'intent'))
      )
    ORDER BY created_at, id
    LIMIT 2501`;
  traceTruncated ||= relatedJobNodes.length > 2500;
  const boundedRelatedJobNodes = (relatedJobNodes as JsonRecord[]).slice(0, 2500);
  const nodeByJob = new Map<string, JsonRecord[]>();
  for (const node of boundedRelatedJobNodes) {
    const jobId = String(node.job_id);
    nodeByJob.set(jobId, [...(nodeByJob.get(jobId) ?? []), node]);
  }

  const intents = boundedRelatedJobNodes
    .filter((node) => node.node_type === "intent")
    .map((node) => {
      const body = record(node.body_json);
      return {
        node_id: String(node.id),
        role: boundedText(body.role ?? body.type ?? "unknown", 80),
        status: typeof node.status === "string" ? node.status : null,
        job_id: String(node.job_id),
        description: boundedText(body.description ?? node.title ?? ""),
        at: node.created_at as string | Date,
      };
    });
  const hubs = exactHubs.map((job) => ({
    job_id: String(job.id),
    node_id: String((nodeByJob.get(String(job.id)) ?? [])[0]?.id ?? "") || null,
    trigger_kind: boundedText(record(record(job.payload_json).trigger).kind || "unknown", 80),
    status: String(job.status),
    at: job.created_at as string | Date,
    confidence: "exact" as const,
  }));

  const nodeIds = new Set(boundedRelatedJobNodes.map((node) => String(node.id)));
  const boundedNodeIds = [...nodeIds];
  const edges = boundedNodeIds.length > 0
    ? await tx`
        SELECT id, from_node_id, to_node_id, edge_type FROM canvas_edges
        WHERE canvas_id = ${canvasId}
          AND from_node_id = ANY(${boundedNodeIds}::uuid[])
          AND to_node_id = ANY(${boundedNodeIds}::uuid[])
        ORDER BY created_at, id
        LIMIT 4001`
    : [];
  traceTruncated ||= edges.length > 4000;
  const boundedEdges = (edges as JsonRecord[]).slice(0, 4000);

  const gaps: string[] = [];
  if (review.length === 0) gaps.push("missing_review");
  if (test.length === 0) gaps.push("missing_test");
  if (exactHubs.length === 0) gaps.push("hub_unlinked");
  if (typeof finding.node_id !== "string") gaps.push("source_node_missing");
  if (traceTruncated) gaps.push("trace_truncated");
  for (const missing of currentEvidence.missing) {
    const gap = ({
      independent_jobs: "non_independent_evidence",
      supporting_test: "missing_supporting_test",
      unresolved_conflict: "unresolved_conflict",
    } as Record<string, string>)[missing];
    if (gap && !gaps.includes(gap)) gaps.push(gap);
  }
  const edgeRows = boundedEdges;
  const findingNodeId = typeof finding.node_id === "string" ? finding.node_id : null;
  const hasEvidenceEdge = (item: FindingTraceEvidence, kind: "review" | "test") => edgeRows.some((edge) =>
    edge.from_node_id === findingNodeId &&
    edge.to_node_id === item.node_id &&
    edge.edge_type === (kind === "review" ? "reviewed_by" : "tested_by"));
  if (
    (review.some((item) => !hasEvidenceEdge(item, "review")) ||
      test.some((item) => !hasEvidenceEdge(item, "test"))) &&
    !gaps.includes("evidence_edge_missing")
  ) gaps.push("evidence_edge_missing");
  if (anchorNodeIds.some((id) => !nodeIds.has(id))) gaps.push("trace_node_missing");
  const qualifiedTraceEvidence = new Set(evidenceNodeIds);
  const hasUnqualifiedEvidence = boundedRelatedJobNodes.some((node) => {
    if (node.node_type !== "fact" || qualifiedTraceEvidence.has(String(node.id))) return false;
    const verification = record(record(node.body_json).verification);
    return verification.finding_id === findingId;
  });
  if (hasUnqualifiedEvidence) gaps.push("unqualified_evidence");

  const sourceJobNode = boundedSourceJobNodes.find((node) => node.node_type === "job")
    ?? boundedSourceJobNodes.find((node) => node.node_type === "intent")
    ?? null;
  return {
    source: {
      job_id: sourceJobId,
      job_type: boundedText(finding.source_job_type ?? "unknown", 80),
      job_status: boundedText(finding.source_job_status ?? "unknown", 40),
      node_id: typeof finding.node_id === "string" ? finding.node_id : null,
      job_node_id: sourceJobNode ? String(sourceJobNode.id) : null,
      canvas_id: canvasId,
      at: finding.created_at as string | Date,
    },
    evidence: { review, test },
    rounds: boundedRounds.map((round) => {
      const snapshot = record(round.evidence_snapshot_json);
      const requirements = record(round.requirements_json);
      return {
        attempt: Number(round.attempt),
        status: boundedText(round.status, 40),
        outcome: typeof round.final_outcome === "string" ? round.final_outcome : null,
        verify_job_id: typeof round.verify_job_id === "string" ? round.verify_job_id : null,
        missing: stringArray(snapshot.missing).length > 0
          ? stringArray(snapshot.missing)
          : stringArray(requirements.missing_evidence),
        summary: typeof round.summary === "string" ? boundedText(round.summary, 2000) : null,
        proposed_verdict: typeof round.proposed_verdict === "string" ? round.proposed_verdict : null,
        at: round.created_at as string | Date,
        finished_at: (round.finished_at ?? null) as string | Date | null,
      };
    }),
    intents,
    hubs,
    flow: {
      nodes: boundedRelatedJobNodes.map((node) => {
        const body = record(node.body_json);
        return {
          node_id: String(node.id),
          node_type: boundedText(node.node_type, 40),
          title: boundedText(node.title, 300),
          status: typeof node.status === "string" ? boundedText(node.status, 40) : null,
          job_id: typeof node.job_id === "string" ? node.job_id : null,
          role: typeof body.role === "string"
            ? boundedText(body.role, 80)
            : typeof body.type === "string"
              ? boundedText(body.type, 80)
              : null,
          at: node.created_at as string | Date,
        };
      }),
      edges: edgeRows.map((edge) => ({
        edge_id: String(edge.id),
        from_node_id: String(edge.from_node_id),
        to_node_id: String(edge.to_node_id),
        edge_type: boundedText(edge.edge_type, 40),
      })),
    },
    gaps,
    node_ids: boundedNodeIds,
    edge_ids: edgeRows.map((edge) => String(edge.id)),
  };
}

export const findingTraceInternals = { exactTriggerFindingIds, normalizeEvidence };
