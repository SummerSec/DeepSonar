import { ROLE_UI_COLOR_PATTERN } from "@deepsonar/shared-types";

/** The bounded body fields shared by the L0 summary and durable deltas. */
export function boundedCanvasBody(value: unknown, nodeType?: unknown): Record<string, unknown> {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const summary = typeof body.summary === "string"
    ? body.summary
    : typeof body.description === "string"
      ? body.description
      : typeof body.message === "string"
        ? body.message
        : "";
  const description = typeof body.description === "string"
    ? body.description
    : typeof body.summary === "string"
      ? body.summary
      : "";
  const rawProgress = body.last_progress && typeof body.last_progress === "object" && !Array.isArray(body.last_progress)
    ? body.last_progress as Record<string, unknown>
    : null;
  const lastProgress = rawProgress
    ? {
        message: typeof rawProgress.message === "string" ? rawProgress.message.slice(0, 240) : "",
        kind: typeof rawProgress.kind === "string" ? rawProgress.kind.slice(0, 64) : "",
      }
    : null;
  const bounded: Record<string, unknown> = {
    summary: summary.slice(0, 240),
    description: description.slice(0, 240),
    severity: typeof body.severity === "string" ? body.severity : null,
    role: typeof body.role === "string" ? body.role : null,
    type: typeof body.type === "string" ? body.type : null,
    last_progress: lastProgress,
  };
  if (nodeType === "human") {
    if (typeof body.reason === "string") bounded.reason = body.reason.slice(0, 500);
    const rawSubject = asRecord(body.subject);
    if (rawSubject?.type === "finding") {
      bounded.subject = {
        type: "finding",
        finding_id: typeof rawSubject.finding_id === "string" ? rawSubject.finding_id : null,
        subject_revision: typeof rawSubject.subject_revision === "string" ? rawSubject.subject_revision.slice(0, 500) : null,
      };
      bounded.finding_id = typeof rawSubject.finding_id === "string" ? rawSubject.finding_id : null;
    } else if (rawSubject?.type === "platform_blocker") {
      bounded.subject = {
        type: "platform_blocker",
        kind: typeof rawSubject.kind === "string" ? rawSubject.kind : null,
      };
    } else if (typeof body.finding_id === "string") {
      bounded.subject = { type: "finding", finding_id: body.finding_id, subject_revision: null };
      bounded.finding_id = body.finding_id;
    }
  }
  if (typeof body.ui_color === "string" && ROLE_UI_COLOR_PATTERN.test(body.ui_color)) {
    bounded.ui_color = body.ui_color.toLowerCase();
  }
  return bounded;
}

type ProjectionRecord = Record<string, unknown>;

function asRecord(value: unknown): ProjectionRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ProjectionRecord
    : null;
}

/** Convert an event-time node projection into the bounded L0 wire shape. */
export function projectCanvasNode(value: unknown): Record<string, unknown> | null {
  const node = asRecord(value);
  if (!node || typeof node.id !== "string" || typeof node.node_type !== "string") return null;
  const body = asRecord(node.body_json) ?? {};
  return {
    id: node.id,
    node_type: node.node_type,
    title: typeof node.title === "string" ? node.title : "",
    body_json: boundedCanvasBody(body, node.node_type),
    x: Number(node.x ?? 0),
    y: Number(node.y ?? 0),
    w: Number(node.w ?? 240),
    h: Number(node.h ?? 120),
    status: typeof node.status === "string" ? node.status : null,
    verification_status: typeof node.verification_status === "string" ? node.verification_status : null,
    job_id: typeof node.job_id === "string" ? node.job_id : null,
    updated_at: typeof node.updated_at === "string" ? node.updated_at : new Date(0).toISOString(),
  };
}

/** Convert an event-time edge projection into the compact L0 edge shape. */
export function projectCanvasEdge(value: unknown): Record<string, unknown> | null {
  const edge = asRecord(value);
  if (!edge || typeof edge.id !== "string" || typeof edge.from_node_id !== "string" || typeof edge.to_node_id !== "string") {
    return null;
  }
  return {
    id: edge.id,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    edge_type: typeof edge.edge_type === "string" ? edge.edge_type : "child",
  };
}

/** Metadata projections expose only the same lifecycle fields as L0. */
export function projectCanvasMeta(value: unknown): Record<string, unknown> | null {
  const canvas = asRecord(value);
  if (!canvas || typeof canvas.id !== "string") return null;
  return {
    id: canvas.id,
    title: typeof canvas.title === "string" ? canvas.title : "",
    project_id: typeof canvas.project_id === "string" ? canvas.project_id : null,
    status: typeof canvas.status === "string" ? canvas.status : "active",
    archived_at: typeof canvas.archived_at === "string" ? canvas.archived_at : null,
  };
}

/** Strict decimal revision parser used by the HTTP route and unit tests. */
export function parseCanvasRevision(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error("invalid canvas revision cursor");
  }
  const revision = BigInt(raw);
  if (revision < 0n) throw new Error("invalid canvas revision cursor");
  return revision;
}

export type CanvasDeltaRow = {
  revision: string | number | bigint;
  entity_type: "node" | "edge" | "meta";
  entity_id: string;
  op: "upsert" | "delete";
  projection_json: unknown;
};

export type CanvasDeltaWire = {
  canvas_id: string;
  since: string;
  upper_revision: string;
  floor_revision: string;
  upsert_nodes: Record<string, unknown>[];
  delete_node_ids: string[];
  upsert_edges: Record<string, unknown>[];
  delete_edge_ids: string[];
  upsert_meta: Record<string, unknown>[];
};

/** Reduce rows in revision order into the stable delta envelope.
 *
 * A single entity can be changed more than once between cursors.  Keep only
 * its final operation so an upsert followed by a delete cannot resurrect the
 * entity when the wire envelope is applied by clients (and vice versa).
 */
export function buildCanvasDelta(canvasId: string, since: bigint, upper: bigint, floor: bigint, rows: CanvasDeltaRow[]): CanvasDeltaWire {
  const delta: CanvasDeltaWire = {
    canvas_id: canvasId,
    since: since.toString(),
    upper_revision: upper.toString(),
    floor_revision: floor.toString(),
    upsert_nodes: [],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
  };
  const nodes = new Map<string, { op: CanvasDeltaRow["op"]; value?: Record<string, unknown> }>();
  const edges = new Map<string, { op: CanvasDeltaRow["op"]; value?: Record<string, unknown> }>();
  const metaChanges = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.entity_type === "node") {
      if (row.op === "delete") nodes.set(row.entity_id, { op: "delete" });
      else {
        const node = projectCanvasNode(row.projection_json);
        if (node) nodes.set(row.entity_id, { op: "upsert", value: node });
      }
    } else if (row.entity_type === "edge") {
      if (row.op === "delete") edges.set(row.entity_id, { op: "delete" });
      else {
        const edge = projectCanvasEdge(row.projection_json);
        if (edge) edges.set(row.entity_id, { op: "upsert", value: edge });
      }
    } else if (row.op === "upsert") {
      const projection = projectCanvasMeta(row.projection_json);
      if (projection) metaChanges.set(row.entity_id, projection);
    }
  }
  for (const [id, change] of nodes) {
    if (change.op === "delete") delta.delete_node_ids.push(id);
    else if (change.value) delta.upsert_nodes.push(change.value);
  }
  for (const [id, change] of edges) {
    if (change.op === "delete") delta.delete_edge_ids.push(id);
    else if (change.value) delta.upsert_edges.push(change.value);
  }
  delta.upsert_meta.push(...metaChanges.values());
  return delta;
}

export function cursorGap(message: string, errorCode = "CURSOR_GAP"): { error: string; error_code: string } {
  return { error: message, error_code: errorCode };
}
