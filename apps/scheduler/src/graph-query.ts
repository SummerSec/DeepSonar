import {
  GRAPH_QUERY_LIMITS,
  GraphQueryPayload,
  type GraphQueryKind,
  type GraphQueryPayload as GraphQueryInput,
} from "@deepsonar/shared-types";
import { sql } from "./db.js";
import { config } from "./config.js";
import { findingVerificationSummaries, isSeverityInVerifyScope, normalizeFindingArtifactRefs } from "./verify.js";
import { taskTargetForPrompt } from "./task-compose.js";
import {
  humanHintProjection,
  idsMentionedInText,
  projectVerifyFinding,
  projectedQuantities,
  serializeFindingStatusIndex,
  short,
} from "./graph.js";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = /token|secret|password|authorization|credential|api[_-]?key|cookie/i;
const OPEN_INTENT = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);

export interface GraphQueryBudget {
  calls_left: number;
  bytes_left: number;
}

export interface GraphQueryResult {
  accepted: true;
  operation: "graph_query";
  kind: GraphQueryKind;
  truncated: boolean;
  omitted: Record<string, number>;
  items: unknown[];
  referable_ids: string[];
  budget: GraphQueryBudget;
  next_cursor?: string;
}

export interface GraphQueryState {
  calls: number;
  bytes: number;
  projected_node_ids: string[];
  blocked: boolean;
  trail: Array<{
    at: string;
    kind: string;
    item_count: number;
    truncated: boolean;
    duration_ms: number;
    omitted: Record<string, number>;
  }>;
}

export class GraphQueryBudgetError extends Error {
  readonly code = "graph_query_budget_exceeded" as const;
  readonly remaining: { calls: number; bytes: number };
  readonly blocked: boolean;

  constructor(remaining: { calls: number; bytes: number }, blocked: boolean) {
    super(
      `[graph_query_budget_exceeded] graph_query budget exhausted (calls_left=${remaining.calls}, bytes_left=${remaining.bytes}); narrow the query or use overview`,
    );
    this.name = "GraphQueryBudgetError";
    this.remaining = remaining;
    this.blocked = blocked;
  }
}

type CanvasNode = {
  id: string;
  node_type: string;
  title: string;
  body_json: Record<string, unknown>;
  status: string | null;
  verification_status: string | null;
  job_id: string | null;
  created_at: Date | string;
};

type CanvasEdge = {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
};

type VisibleFinding = {
  id: string;
  node_id: string;
  title: unknown;
  severity: unknown;
  location: unknown;
  summary: unknown;
  verify_status: unknown;
  imported: boolean;
  evidence_refs?: unknown;
};

export interface CanvasGraph {
  canvasId: string;
  goal: string;
  target: Record<string, unknown>;
  promptTarget: Record<string, unknown>;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  findings: VisibleFinding[];
  verificationSummaries: Map<string, Record<string, unknown>>;
}

export interface GraphQueryStore {
  loadCanvas(canvasId: string): Promise<CanvasGraph>;
  loadState(jobId: string): Promise<GraphQueryState>;
  saveState(jobId: string, state: GraphQueryState): Promise<void>;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => stripSecrets(item, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(nested, depth + 1);
  }
  return out;
}

function createdAtMs(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function createdAtIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function factTrustStatus(node: CanvasNode): string | undefined {
  if (node.node_type !== "fact") return undefined;
  return typeof node.verification_status === "string" ? node.verification_status : "unverified";
}

function parseState(payload: unknown): GraphQueryState {
  const graphQuery = asRecord(asRecord(payload).graph_query);
  const ids = Array.isArray(graphQuery.projected_node_ids)
    ? graphQuery.projected_node_ids.filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
    : [];
  const trail = Array.isArray(graphQuery.trail)
    ? graphQuery.trail.filter((entry): entry is GraphQueryState["trail"][number] => Boolean(entry) && typeof entry === "object")
    : [];
  return {
    calls: Number.isFinite(Number(graphQuery.calls)) ? Math.max(0, Number(graphQuery.calls)) : 0,
    bytes: Number.isFinite(Number(graphQuery.bytes)) ? Math.max(0, Number(graphQuery.bytes)) : 0,
    projected_node_ids: unique(ids),
    blocked: graphQuery.blocked === true,
    trail: trail.slice(-40),
  };
}

export async function loadCanvasGraph(canvasId: string): Promise<CanvasGraph> {
  const [canvas] = await sql`
    SELECT title, target_json FROM canvases WHERE id = ${canvasId}`;
  const nodes = (await sql`
    SELECT id, node_type, title, body_json, status, verification_status, job_id, created_at
    FROM canvas_nodes WHERE canvas_id = ${canvasId}
    ORDER BY created_at, id`) as CanvasNode[];
  const edges = (await sql`
    SELECT from_node_id, to_node_id, edge_type
    FROM canvas_edges WHERE canvas_id = ${canvasId}`) as CanvasEdge[];
  const findingRows = await sql`
    SELECT f.id, f.node_id, f.title, f.severity, f.location, f.summary, f.verify_status, f.evidence_refs_json
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}`;
  const imported: VisibleFinding[] = nodes
    .filter((node) => {
      const body = asRecord(node.body_json);
      return node.node_type === "finding" && body.origin === "seed" && body.imported === true;
    })
    .map((node) => {
      const body = asRecord(node.body_json);
      return {
        id: String(body.finding_id ?? ""),
        node_id: String(node.id),
        title: node.title,
        severity: body.severity ?? null,
        location: body.location ?? null,
        summary: body.summary ?? null,
        verify_status: String(body.frozen_verify_status ?? body.verify_status ?? "pending"),
        imported: true,
        evidence_refs: body.evidence_refs ?? body.artifact_refs ?? body.evidence_refs_json,
      };
    });
  const findings: VisibleFinding[] = [
    ...findingRows.map((finding) => ({
      id: String(finding.id),
      node_id: String(finding.node_id),
      title: finding.title,
      severity: finding.severity,
      location: finding.location,
      summary: finding.summary,
      verify_status: finding.verify_status,
      imported: false,
      evidence_refs: finding.evidence_refs_json,
    })),
    ...imported,
  ];
  const findingIds = findings.flatMap((finding) => (finding.imported ? [] : [finding.id]));
  const verificationSummaries = await findingVerificationSummaries(sql, findingIds);
  const target = asRecord(canvas?.target_json);
  return {
    canvasId,
    goal: String(target.goal ?? canvas?.title ?? ""),
    target,
    promptTarget: taskTargetForPrompt(target),
    nodes: nodes.map((node) => ({
      ...node,
      id: String(node.id),
      node_type: String(node.node_type),
      title: String(node.title ?? ""),
      body_json: asRecord(node.body_json),
      status: node.status == null ? null : String(node.status),
      verification_status: node.verification_status == null ? null : String(node.verification_status),
      job_id: node.job_id == null ? null : String(node.job_id),
    })),
    edges: edges.map((edge) => ({
      from_node_id: String(edge.from_node_id),
      to_node_id: String(edge.to_node_id),
      edge_type: String(edge.edge_type),
    })),
    findings,
    verificationSummaries,
  };
}

export const sqlGraphQueryStore: GraphQueryStore = {
  async loadCanvas(canvasId) {
    return loadCanvasGraph(canvasId);
  },
  async loadState(jobId) {
    const [row] = await sql`SELECT payload_json FROM jobs WHERE id = ${jobId}`;
    return parseState(row?.payload_json);
  },
  async saveState(jobId, state) {
    await sql`
      UPDATE jobs
      SET payload_json = payload_json || ${sql.json({ graph_query: state } as never)}
      WHERE id = ${jobId}`;
  },
};

export function projectNodeIndex(
  nodes: readonly CanvasNode[],
  options: { node_type?: string; status?: string; since?: string; cursor?: string; limit: number },
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; next_cursor?: string; referable_ids: string[] } {
  let filtered = nodes.filter((node) => {
    if (options.node_type && node.node_type !== options.node_type) return false;
    if (options.status && String(node.status ?? "") !== options.status) return false;
    if (options.since) {
      const sinceMs = Date.parse(options.since);
      if (Number.isFinite(sinceMs) && createdAtMs(node.created_at) < sinceMs) return false;
    }
    return true;
  });
  if (options.cursor) {
    const index = filtered.findIndex((node) => node.id === options.cursor);
    filtered = index >= 0 ? filtered.slice(index + 1) : filtered;
  }
  const limit = Math.min(options.limit, GRAPH_QUERY_LIMITS.index);
  const page = filtered.slice(0, limit);
  const omittedCount = Math.max(0, filtered.length - page.length);
  const items = page.map((node) => ({
    id: node.id,
    type: node.node_type,
    status: node.status,
    created_at: createdAtIso(node.created_at),
    title: short(node.title, 56),
  }));
  return {
    items,
    truncated: omittedCount > 0,
    omitted: omittedCount > 0 ? { nodes: omittedCount } : {},
    ...(page.length > 0 && omittedCount > 0 ? { next_cursor: page[page.length - 1]!.id } : page.length === limit && filtered.length > limit ? { next_cursor: page[page.length - 1]!.id } : {}),
    referable_ids: unique(page.filter((node) => node.node_type === "root" || node.node_type === "fact" || node.node_type === "finding").map((node) => node.id)),
  };
}

export function projectNodeBody(
  nodes: readonly CanvasNode[],
  findings: readonly VisibleFinding[],
  ids: readonly string[],
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; referable_ids: string[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const findingByNode = new Map(findings.map((finding) => [finding.node_id, finding]));
  const items: Record<string, unknown>[] = [];
  let truncated = false;
  const omitted: Record<string, number> = {};
  const referable: string[] = [];
  for (const id of ids.slice(0, GRAPH_QUERY_LIMITS.nodeIds)) {
    const node = byId.get(id);
    if (!node) {
      omitted.missing = (omitted.missing ?? 0) + 1;
      truncated = true;
      continue;
    }
    const finding = findingByNode.get(node.id);
    const body = node.body_json;
    const projected = stripSecrets({
      id: node.id,
      node_type: node.node_type,
      title: short(node.title, 160),
      status: node.status,
      ...(factTrustStatus(node) ? { verification_status: factTrustStatus(node) } : {}),
      summary: short(body.description ?? body.summary ?? finding?.summary, 420),
      location: short(body.location ?? finding?.location, 140),
      ...(projectedQuantities(body) ? { quantities: projectedQuantities(body) } : {}),
      ...(finding
        ? {
            ...(finding.imported ? { imported: true, readonly: true } : { finding_id: finding.id }),
            verify_status: finding.verify_status,
          }
        : {}),
    }) as Record<string, unknown>;
    const raw = JSON.stringify(projected);
    if (raw.length > GRAPH_QUERY_LIMITS.nodeBodyChars) {
      truncated = true;
      omitted.nodes = (omitted.nodes ?? 0) + 1;
      items.push({
        ...projected,
        summary: short(projected.summary, 80),
        truncated: true,
        preview: short(raw, Math.max(80, GRAPH_QUERY_LIMITS.nodeBodyChars - 64)),
      });
    } else {
      items.push(projected);
    }
    if (node.node_type === "root" || node.node_type === "fact" || node.node_type === "finding") referable.push(node.id);
  }
  return { items, truncated, omitted, referable_ids: unique(referable) };
}

export function projectEdges(
  edges: readonly CanvasEdge[],
  id: string,
  direction: "out" | "in" | "both" = "both",
  edgeType?: string,
  limit: number = GRAPH_QUERY_LIMITS.edges,
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; referable_ids: string[] } {
  const matched = edges.filter((edge) => {
    if (edgeType && edge.edge_type !== edgeType) return false;
    if (direction === "out") return edge.from_node_id === id;
    if (direction === "in") return edge.to_node_id === id;
    return edge.from_node_id === id || edge.to_node_id === id;
  });
  const cap = Math.min(limit, GRAPH_QUERY_LIMITS.edges);
  const page = matched.slice(0, cap);
  const omittedCount = Math.max(0, matched.length - page.length);
  const items = page.map((edge) => ({
    from: edge.from_node_id,
    to: edge.to_node_id,
    edge_type: edge.edge_type,
  }));
  return {
    items,
    truncated: omittedCount > 0,
    omitted: omittedCount > 0 ? { edges: omittedCount } : {},
    referable_ids: unique(page.flatMap((edge) => [edge.from_node_id, edge.to_node_id])),
  };
}

export function projectFindingsIndex(
  findings: readonly VisibleFinding[],
  summaries: Map<string, Record<string, unknown>>,
  options: { verify_status?: string; unconverged_only?: boolean; limit: number; minVerifySeverity?: string },
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; referable_ids: string[] } {
  const unconverged = new Set(["pending", "verifying"]);
  const filtered = findings.filter((finding) => {
    if (options.verify_status && String(finding.verify_status ?? "") !== options.verify_status) return false;
    if (options.unconverged_only && !unconverged.has(String(finding.verify_status ?? "pending"))) return false;
    return true;
  });
  const cap = Math.min(options.limit, GRAPH_QUERY_LIMITS.findings);
  const page = filtered.slice(0, cap);
  const omittedCount = Math.max(0, filtered.length - page.length);
  const serialized = serializeFindingStatusIndex(
    page.map((finding) => {
      const summary = summaries.get(String(finding.id)) ?? {};
      return {
        id: String(finding.node_id || finding.id),
        ...(finding.imported ? {} : { finding_id: String(finding.id) }),
        title: finding.title as string | null,
        severity: finding.severity as string | null,
        verify_status: finding.verify_status as string | null,
        ...(options.minVerifySeverity
          ? { verify_required: finding.imported ? false : isSeverityInVerifyScope(options.minVerifySeverity, finding.severity) }
          : {}),
        verification_attempt: Number(summary.verification_attempt ?? 0),
        missing_evidence: Array.isArray(summary.missing_evidence) ? summary.missing_evidence as string[] : [],
        imported: finding.imported,
      };
    }),
    24_000,
  );
  const items = page.map((finding) => {
    const summary = summaries.get(String(finding.id)) ?? {};
    const blockers = Array.isArray(summary.missing_evidence) ? summary.missing_evidence.slice(0, 8) : [];
    return {
      id: String(finding.node_id || finding.id),
      ...(finding.imported ? { imported: true, readonly: true } : { finding_id: String(finding.id) }),
      title: short(finding.title, 56),
      severity: finding.severity,
      verify_status: finding.verify_status,
      blockers,
      verification_attempt: Number(summary.verification_attempt ?? 0),
    };
  });
  return {
    items,
    truncated: omittedCount > 0 || serialized.truncated,
    omitted: {
      ...(omittedCount > 0 ? { findings: omittedCount } : {}),
      ...(serialized.truncated ? { findings_index: serialized.omitted } : {}),
    },
    referable_ids: unique(page.map((finding) => String(finding.node_id || finding.id))),
  };
}

export function projectIntentFrontier(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  options: { status?: string; limit: number },
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; referable_ids: string[] } {
  const intentFrom = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.edge_type !== "from") continue;
    intentFrom.set(edge.to_node_id, [...(intentFrom.get(edge.to_node_id) ?? []), edge.from_node_id]);
  }
  const intents = nodes.filter((node) => {
    if (node.node_type !== "intent") return false;
    if (options.status) return String(node.status ?? "") === options.status;
    return true;
  });
  const cap = Math.min(options.limit, GRAPH_QUERY_LIMITS.intents);
  const page = intents.slice(0, cap);
  const omittedCount = Math.max(0, intents.length - page.length);
  const latestByRole = new Map<string, CanvasNode>();
  for (const node of nodes) {
    if (node.node_type !== "intent") continue;
    const role = String(asRecord(node.body_json).role ?? "unknown");
    const previous = latestByRole.get(role);
    if (!previous || createdAtMs(node.created_at) > createdAtMs(previous.created_at)) latestByRole.set(role, node);
  }
  const items = page.map((intent) => {
    const body = intent.body_json;
    const role = String(body.role ?? "explore");
    const latest = latestByRole.get(role);
    return {
      id: intent.id,
      role,
      status: intent.status,
      description: short(body.description ?? intent.title, 500),
      from: intentFrom.get(intent.id) ?? [],
      open: OPEN_INTENT.has(String(intent.status ?? "")),
      role_latest_status: latest?.status ?? null,
      role_latest_at: latest ? createdAtIso(latest.created_at) : null,
    };
  });
  return {
    items,
    truncated: omittedCount > 0,
    omitted: omittedCount > 0 ? { intents: omittedCount } : {},
    referable_ids: unique(page.flatMap((intent) => intentFrom.get(intent.id) ?? [])),
  };
}

export function projectOverview(graph: CanvasGraph): {
  items: Record<string, unknown>[];
  truncated: boolean;
  omitted: Record<string, number>;
  referable_ids: string[];
} {
  const nodeCounts: Record<string, number> = {};
  const edgeCounts: Record<string, number> = {};
  const verifyCounts: Record<string, number> = {};
  for (const node of graph.nodes) {
    nodeCounts[node.node_type] = (nodeCounts[node.node_type] ?? 0) + 1;
  }
  for (const edge of graph.edges) {
    edgeCounts[edge.edge_type] = (edgeCounts[edge.edge_type] ?? 0) + 1;
  }
  for (const finding of graph.findings) {
    const status = String(finding.verify_status ?? "unknown");
    verifyCounts[status] = (verifyCounts[status] ?? 0) + 1;
  }
  const root = graph.nodes.find((node) => node.node_type === "root");
  const openIntents = graph.nodes.filter((node) => node.node_type === "intent" && OPEN_INTENT.has(String(node.status ?? "")));
  const hints = graph.nodes.filter((node) => node.node_type === "human").slice(-4).map((hint) => humanHintProjection(hint));
  const item = {
    goal: short(graph.goal, 240),
    target: stripSecrets({
      kind: graph.promptTarget.kind ?? null,
      title: short(graph.promptTarget.title, 120),
    }),
    root_id: root?.id ?? null,
    root_status: root?.status ?? null,
    node_counts: nodeCounts,
    edge_counts: edgeCounts,
    verify_distribution: verifyCounts,
    open_intent_count: openIntents.length,
    frontier: {
      open_intent_roles: unique(openIntents.map((intent) => String(intent.body_json.role ?? "explore"))).slice(0, 12),
      recent_human_hints: hints.length,
    },
    query_hint: "use graph_query kind=index|node|findings|intents after overview; do not pull the whole graph",
  };
  const encoded = JSON.stringify(item);
  const truncated = encoded.length > GRAPH_QUERY_LIMITS.overviewChars;
  return {
    items: [truncated ? { ...item, truncated: true, preview: short(encoded, 400) } : item],
    truncated,
    omitted: truncated ? { overview: 1 } : {},
    referable_ids: root?.id ? [root.id] : [],
  };
}

export function projectEvidence(
  graph: CanvasGraph,
  findingId: string,
): { items: Record<string, unknown>[]; truncated: boolean; omitted: Record<string, number>; referable_ids: string[] } {
  const finding = graph.findings.find((row) => row.id === findingId || row.node_id === findingId);
  const facts = graph.nodes.filter((node) => {
    if (node.node_type !== "fact") return false;
    const verification = asRecord(node.body_json.verification);
    return String(verification.finding_id ?? "") === String(finding?.id ?? findingId);
  });
  const projectedFinding = finding
    ? projectVerifyFinding({
        id: finding.id,
        node_id: finding.node_id,
        location: finding.location,
        verify_status: finding.verify_status,
        artifact_refs: normalizeFindingArtifactRefs({
          evidence_refs: finding.evidence_refs,
        }),
        verification: graph.verificationSummaries.get(String(finding.id)) ?? {},
      })
    : null;
  const items = facts.map((node) => {
    const evidence = asRecord(node.body_json.verification);
    return stripSecrets({
      id: node.id,
      title: short(node.title, 160),
      verification_status: factTrustStatus(node),
      evidence_kind: evidence.evidence_kind,
      outcome: evidence.outcome,
      subject_revision: short(evidence.subject_revision, 220),
      steps: Array.isArray(evidence.steps) ? evidence.steps.slice(0, 8).map((step) => short(step, 240)) : [],
      expected: short(evidence.expected, 520),
      actual: short(evidence.actual, 520),
      artifact_refs: Array.isArray(evidence.artifact_refs) ? evidence.artifact_refs.slice(0, 8) : [],
      limitations: Array.isArray(evidence.limitations) ? evidence.limitations.slice(0, 8).map((item) => short(item, 240)) : [],
    }) as Record<string, unknown>;
  });
  if (projectedFinding) items.unshift({ finding: projectedFinding });
  const raw = JSON.stringify(items);
  const truncated = raw.length > GRAPH_QUERY_LIMITS.evidenceChars;
  return {
    items: truncated ? [{ truncated: true, preview: short(raw, 400), count: items.length }] : items,
    truncated,
    omitted: truncated ? { evidence: items.length } : {},
    referable_ids: unique([
      ...(finding?.node_id ? [finding.node_id] : []),
      ...facts.map((node) => node.id),
    ]),
  };
}

function remainingOf(state: GraphQueryState, maxCalls: number, maxBytes: number): GraphQueryBudget {
  return {
    calls_left: Math.max(0, maxCalls - state.calls),
    bytes_left: Math.max(0, maxBytes - state.bytes),
  };
}

function projectKind(graph: CanvasGraph, input: GraphQueryInput): {
  items: unknown[];
  truncated: boolean;
  omitted: Record<string, number>;
  referable_ids: string[];
  next_cursor?: string;
} {
  if (input.kind === "overview") return projectOverview(graph);
  if (input.kind === "index") {
    return projectNodeIndex(graph.nodes, {
      node_type: input.node_type,
      status: input.status,
      since: input.since,
      cursor: input.cursor,
      limit: input.limit ?? GRAPH_QUERY_LIMITS.index,
    });
  }
  if (input.kind === "node") {
    return projectNodeBody(graph.nodes, graph.findings, input.ids ?? []);
  }
  if (input.kind === "edges") {
    return projectEdges(graph.edges, String(input.id), input.direction ?? "both", input.edge_type, input.limit ?? GRAPH_QUERY_LIMITS.edges);
  }
  if (input.kind === "findings") {
    return projectFindingsIndex(graph.findings, graph.verificationSummaries, {
      verify_status: input.verify_status,
      unconverged_only: input.unconverged_only,
      limit: input.limit ?? GRAPH_QUERY_LIMITS.findings,
    });
  }
  if (input.kind === "evidence") {
    return projectEvidence(graph, String(input.finding_id));
  }
  return projectIntentFrontier(graph.nodes, graph.edges, {
    status: input.status,
    limit: input.limit ?? GRAPH_QUERY_LIMITS.intents,
  });
}

export async function executeGraphQuery(input: {
  jobId: string;
  canvasId: string | null;
  payload: unknown;
  store?: GraphQueryStore;
  maxCalls?: number;
  maxBytes?: number;
  liveProjectedIds?: Set<string>;
}): Promise<GraphQueryResult> {
  if (!input.canvasId) {
    throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", "graph_query requires a Job bound to a canvas", {
      statusCode: 422,
      errorCode: "invalid_payload",
      retryable: true,
      path: "canvas_id",
    });
  }
  const parsed = GraphQueryPayload.safeParse(input.payload ?? {});
  if (!parsed.success) {
    throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", "graph_query 参数不符合严格契约", {
      statusCode: 422,
      errorCode: "invalid_payload",
      retryable: true,
    });
  }
  const store = input.store ?? sqlGraphQueryStore;
  const maxCalls = input.maxCalls ?? config.graph.queryMaxCalls;
  const maxBytes = input.maxBytes ?? config.graph.queryMaxBytes;
  const started = Date.now();
  const state = await store.loadState(input.jobId);
  const remaining = remainingOf(state, maxCalls, maxBytes);
  if (state.blocked || remaining.calls_left <= 0 || remaining.bytes_left <= 0) {
    state.blocked = true;
    await store.saveState(input.jobId, state);
    throw graphQueryBudgetRejection(new GraphQueryBudgetError({
      calls: remaining.calls_left,
      bytes: remaining.bytes_left,
    }, true));
  }

  const graph = await store.loadCanvas(input.canvasId);
  const projection = projectKind(graph, parsed.data);
  const membership = new Set(
    graph.nodes
      .filter((node) => node.node_type === "root" || node.node_type === "fact" || node.node_type === "finding")
      .map((node) => node.id),
  );
  const referable = unique(projection.referable_ids.filter((id) => UUID_RE.test(id) && membership.has(id)));
  const result: GraphQueryResult = {
    accepted: true,
    operation: "graph_query",
    kind: parsed.data.kind,
    truncated: projection.truncated,
    omitted: projection.omitted,
    items: projection.items,
    referable_ids: referable,
    budget: {
      calls_left: remaining.calls_left - 1,
      bytes_left: remaining.bytes_left,
    },
    ...(projection.next_cursor ? { next_cursor: projection.next_cursor } : {}),
  };
  const bytes = utf8Bytes(result);
  if (bytes > remaining.bytes_left) {
    await store.saveState(input.jobId, state);
    throw graphQueryBudgetRejection(new GraphQueryBudgetError(
      { calls: remaining.calls_left, bytes: remaining.bytes_left },
      false,
    ));
  }
  result.budget.bytes_left = remaining.bytes_left - bytes;
  const nextIds = unique([...state.projected_node_ids, ...referable, ...idsMentionedInText(JSON.stringify(result.items), referable)]);
  const next: GraphQueryState = {
    calls: state.calls + 1,
    bytes: state.bytes + bytes,
    projected_node_ids: nextIds,
    blocked: false,
    trail: [
      ...state.trail,
      {
        at: new Date(started).toISOString(),
        kind: parsed.data.kind,
        item_count: Array.isArray(result.items) ? result.items.length : 0,
        truncated: result.truncated,
        duration_ms: Math.max(0, Date.now() - started),
        omitted: result.omitted,
      },
    ].slice(-40),
  };
  await store.saveState(input.jobId, next);
  if (input.liveProjectedIds) {
    for (const id of nextIds) input.liveProjectedIds.add(id);
  }
  return result;
}

export function graphQueryBudgetRejection(error: GraphQueryBudgetError): PlatformRuntimeHandlerError {
  return new PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
    statusCode: 422,
    errorCode: error.code,
    retryable: true,
    details: {
      remaining: error.remaining,
      calls_left: error.remaining.calls,
      bytes_left: error.remaining.bytes,
      expected: { kind: "graph_query_budget", max_calls: config.graph.queryMaxCalls, max_bytes: config.graph.queryMaxBytes },
    },
  });
}

export function seedProjectedNodeIds(payloadJson: unknown, snapshotIds: readonly string[]): string[] {
  return unique([
    ...parseState(payloadJson).projected_node_ids,
    ...snapshotIds.filter((id) => UUID_RE.test(id)),
  ]);
}

export async function seedGraphQueryProjectedIds(
  jobId: string,
  snapshotIds: readonly string[],
  store: GraphQueryStore = sqlGraphQueryStore,
): Promise<string[]> {
  const state = await store.loadState(jobId);
  const projected = seedProjectedNodeIds({ graph_query: state }, snapshotIds);
  if (projected.some((id) => !state.projected_node_ids.includes(id))) {
    await store.saveState(jobId, { ...state, projected_node_ids: projected });
  }
  return projected;
}
