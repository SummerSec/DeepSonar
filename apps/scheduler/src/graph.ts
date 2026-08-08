import { sql } from "./db.js";
import { findingVerificationSummaries } from "./verify.js";
import { config } from "./config.js";
import {
  GraphNodeReference,
  hubReferenceBudgetViolation,
  HubDecisionPayload as HubDecisionPayloadSchema,
} from "@deepsonar/shared-types";
import {
  ControlInputError,
  invalidControlPayload,
  invalidNodeReference,
  invalidReferenceBudget,
  unknownControlField,
} from "./control-input.js";

/** Server-side bounded graph projections for Hub/Worker prompt inputs. */
export type GraphScope = "hub" | "agent" | "verify" | "report";

export interface GraphSnapshotOptions {
  intentNodeId?: string | null;
  intent?: { description?: string; prompt?: string; from?: string[] };
  findingId?: string | null;
  relatedNodeIds?: string[];
  maxYamlChars?: number;
}

export interface GraphSnapshot {
  scope: GraphScope;
  goal: string;
  target: Record<string, unknown>;
  yaml: string;
  /** Full canvas fact/finding/root IDs used for server-side from validation. */
  referableIds: string[];
  openIntentCount: number;
  yamlChars: number;
  truncated: boolean;
  omitted: Record<string, number>;
  nodeCounts: Record<string, number>;
}

function kv(key: string, value: unknown): string {
  return key + ": " + JSON.stringify(value ?? null);
}

function short(value: unknown, max: number): string {
  const valueText = String(value ?? "");
  return valueText.length > max ? valueText.slice(0, Math.max(0, max - 1)) + "…" : valueText;
}

function boundedJson(value: unknown, max: number): unknown {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= max) return value ?? null;
  return { truncated: true, preview: short(raw, Math.max(80, max - 64)) };
}

function budgetFor(scope: GraphScope): number {
  if (scope === "hub") return config.graph.maxYamlCharsHub;
  if (scope === "agent") return config.graph.maxYamlCharsAgent;
  if (scope === "verify") return config.graph.maxYamlCharsVerify;
  return config.graph.maxYamlCharsReport;
}

function row(value: Record<string, unknown>): string {
  return "  - " + JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function graphProjectionMarkers(
  truncated: boolean,
  omitted: Record<string, number>,
): { truncated: string; omitted: string } {
  return { truncated: kv("truncated", truncated), omitted: kv("omitted", omitted) };
}

export interface FindingIndexInput {
  /** Canonical canvas node UUID used by Hub `from` references. */
  id: string;
  /** Database Finding UUID, retained as a lookup identity when it differs. */
  finding_id?: string | null;
  title?: string | null;
  severity?: string | null;
  verify_status?: string | null;
  verification_attempt?: number | null;
  missing_evidence?: string[];
}

/**
 * Serialize the mandatory Hub Finding index independently of optional graph
 * sections. The compact fallback is intentionally tested and reusable.
 */
export function serializeFindingStatusIndex(
  findings: readonly FindingIndexInput[],
  maxChars: number,
): { lines: string[]; truncated: boolean; omitted: number } {
  const full = [
    "findings_index:",
    ...findings.map((finding) =>
      row({
        id: finding.id,
        ...(finding.finding_id && finding.finding_id !== finding.id ? { finding_id: finding.finding_id } : {}),
        title: short(finding.title, 56),
        severity: finding.severity,
        verify_status: finding.verify_status,
        verification_attempt: finding.verification_attempt ?? 0,
        missing_evidence: (finding.missing_evidence ?? []).slice(0, 2),
      }),
    ),
  ];
  if (full.join("\n").length <= maxChars) return { lines: full, truncated: false, omitted: 0 };
  const minimum = [
    "findings_index:",
    ...findings.map((finding) => row({ id: finding.id, verify_status: finding.verify_status })),
  ];
  if (minimum.join("\n").length <= maxChars) {
    // The rows are all retained, but optional fields were compressed; expose
    // that omission explicitly to operators.
    return { lines: minimum, truncated: true, omitted: findings.length };
  }
  return { lines: ["findings_index:"], truncated: true, omitted: findings.length };
}

/**
 * Build a bounded projection for one canvas. Optional detail sections are
 * dropped first; Hub's Finding status index is inserted atomically and falls
 * back to compact {id, verify_status} rows so every Finding remains visible.
 */
export async function buildGraphSnapshot(
  canvasId: string,
  scope: GraphScope = "hub",
  options: GraphSnapshotOptions = {},
): Promise<GraphSnapshot> {
  const [canvas] = await sql`
    SELECT title, target_json FROM canvases WHERE id = ${canvasId}`;
  const nodes = await sql`
    SELECT id, node_type, title, body_json, status, created_at
    FROM canvas_nodes WHERE canvas_id = ${canvasId}
    ORDER BY created_at`;
  const edges = await sql`
    SELECT from_node_id, to_node_id, edge_type
    FROM canvas_edges WHERE canvas_id = ${canvasId}`;
  const target = (canvas?.target_json ?? {}) as Record<string, unknown>;
  const goal = String(target.goal ?? canvas?.title ?? "");
  const root = nodes.find((node) => node.node_type === "root");
  const facts = nodes.filter((node) => node.node_type === "fact" || node.node_type === "finding");
  const factNodes = nodes.filter((node) => node.node_type === "fact");
  const openIntents = nodes.filter(
    (node) => node.node_type === "intent" && !["succeeded", "failed", "cancelled"].includes(String(node.status)),
  );
  const hints = nodes.filter((node) => node.node_type === "human");

  const intentFrom = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.edge_type !== "from") continue;
    const key = String(edge.to_node_id);
    intentFrom.set(key, [...(intentFrom.get(key) ?? []), String(edge.from_node_id)]);
  }
  const findingRows = await sql`
    SELECT f.id, f.node_id, f.job_id, f.title, f.severity, f.location, f.summary, f.verify_status
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}`;
  const findingByNode = new Map(findingRows.map((finding) => [String(finding.node_id), finding]));
  const findingById = new Map(findingRows.map((finding) => [String(finding.id), finding]));
  const findingIds = findingRows.flatMap((finding) => (typeof finding.id === "string" ? [finding.id] : []));
  const verificationSummaries =
    scope === "hub" || scope === "verify"
      ? await findingVerificationSummaries(sql, findingIds)
      : new Map<string, Record<string, unknown>>();

  const nodeCounts = nodes.reduce<Record<string, number>>((acc, node) => {
    const type = String(node.node_type ?? "unknown");
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  const referableIds = unique([
    ...facts.map((node) => String(node.id)),
    ...nodes.filter((node) => node.node_type === "root").map((node) => String(node.id)),
  ]);

  const maxChars = Math.max(512, options.maxYamlChars ?? budgetFor(scope));
  const contentLimit = Math.max(256, maxChars - 1_024);
  const omitted: Record<string, number> = {};
  let truncated = false;
  const lines = [
    kv("scope", scope),
    kv("truncated", false),
    kv("omitted", {}),
    kv("goal", short(goal, 1_200)),
    kv("target", boundedJson(target, 2_400)),
    kv("root_id", root?.id ?? null),
    kv("root_status", root?.status ?? null),
    kv("node_counts", nodeCounts),
  ];
  const size = () => lines.join("\n").length;
  const omit = (section: string, amount = 1) => {
    omitted[section] = (omitted[section] ?? 0) + amount;
    truncated = true;
  };
  const fit = (block: string[]): boolean => size() + 1 + block.join("\n").length <= contentLimit;
  const addOptional = (section: string, block: string[]) => {
    if (block.length === 0) return;
    if (fit(block)) {
      lines.push(...block);
      return;
    }
    const header = block[0]?.endsWith(":") ? [block[0]] : [];
    if (header.length > 0 && fit(header)) lines.push(...header);
    omit(section, Math.max(1, block.length - header.length));
  };
  const addSection = (section: string, rows: string[], mandatory = false) => {
    const block = [section + ":", ...(rows.length > 0 ? rows : ["  []"])];
    if (fit(block)) {
      lines.push(...block);
      return true;
    }
    if (!mandatory) {
      addOptional(section, block);
      return false;
    }
    omit(section, rows.length);
    return false;
  };

  if (scope === "hub") {
    const index = serializeFindingStatusIndex(
      findingRows.map((finding) => {
        const summary = verificationSummaries.get(String(finding.id)) ?? {};
        return {
          // Hub references are canvas-node identities. A finding row can have
          // a distinct database UUID, so never expose that UUID as `id` here.
          id: String(finding.node_id ?? finding.id),
          finding_id: String(finding.id),
          title: (finding.title ?? findingByNode.get(String(finding.node_id))?.title) as string | null,
          severity: finding.severity as string | null,
          verify_status: finding.verify_status as string | null,
          verification_attempt: Number(summary.verification_attempt ?? 0),
          missing_evidence: Array.isArray(summary.missing_evidence) ? summary.missing_evidence as string[] : [],
        };
      }),
      Math.max(128, contentLimit - size() - 1),
    );
    if (fit(index.lines)) {
      lines.push(...index.lines);
      if (index.truncated) omit("findings_index", index.omitted);
    } else {
      addSection("findings_index", index.lines.slice(1), true);
    }

    addSection(
      "open_intents",
      openIntents.map((intent) => {
        const body = (intent.body_json ?? {}) as Record<string, unknown>;
        return row({
          id: intent.id,
          role: body.role ?? "explore",
          status: intent.status,
          description: short(body.description ?? intent.title, 500),
          from: intentFrom.get(String(intent.id)) ?? [],
        });
      }),
    );
    addSection(
      "facts_index",
      factNodes.map((fact) => {
        const body = (fact.body_json ?? {}) as Record<string, unknown>;
        return row({
          id: fact.id,
          title: short(fact.title, 140),
          status: fact.status,
          location: short(body.location, 140),
        });
      }),
    );
    const concluded = nodes.filter(
      (node) =>
        node.node_type === "intent" &&
        !["pending", "claimed", "provisioning", "running", "waiting_human"].includes(String(node.status)),
    );
    const byStatus: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    for (const intent of concluded) {
      const body = (intent.body_json ?? {}) as Record<string, unknown>;
      const status = String(intent.status ?? "unknown");
      const role = String(body.role ?? "unknown");
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    addSection("concluded_intents", [
      "  " + kv("count", concluded.length),
      "  " + kv("by_status", byStatus),
      "  " + kv("by_role", byRole),
    ]);
    const related = new Set(options.relatedNodeIds ?? []);
    const triggerFinding = options.findingId ? findingById.get(String(options.findingId)) : undefined;
    if (triggerFinding?.node_id) related.add(String(triggerFinding.node_id));
    for (const intent of openIntents) {
      for (const id of intentFrom.get(String(intent.id)) ?? []) related.add(id);
    }
    const hot = [...facts]
      .sort((a, b) => {
        const aHot = related.has(String(a.id)) ? 1 : 0;
        const bHot = related.has(String(b.id)) ? 1 : 0;
        if (aHot !== bHot) return bHot - aHot;
        return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
      })
      .slice(0, 32);
    addSection(
      "recent_or_hot_nodes",
      hot.map((node) => {
        const body = (node.body_json ?? {}) as Record<string, unknown>;
        const finding = findingByNode.get(String(node.id));
        return row({
          id: node.id,
          kind: node.node_type,
          title: short(node.title, 160),
          status: node.status,
          summary: short(body.description ?? body.summary ?? finding?.summary, 420),
          ...(finding ? { finding_id: finding.id, verify_status: finding.verify_status } : {}),
        });
      }),
    );
    addSection(
      "hints",
      hints.slice(-16).map((hint) => {
        const body = (hint.body_json ?? {}) as Record<string, unknown>;
        return row({ id: hint.id, content: short(body.reason ?? hint.title, 520) });
      }),
    );
  } else if (scope === "agent") {
    const intentNode = options.intentNodeId
      ? nodes.find((node) => String(node.id) === options.intentNodeId)
      : undefined;
    const intentBody = (intentNode?.body_json ?? {}) as Record<string, unknown>;
    const from = options.intent?.from?.length
      ? options.intent.from
      : intentNode
        ? intentFrom.get(String(intentNode.id)) ?? []
        : [];
    addSection("intent", [
      "  " + kv("id", options.intentNodeId ?? intentNode?.id ?? null),
      "  " + kv("description", short(options.intent?.description ?? intentBody.description ?? intentNode?.title, 800)),
      // The complete prompt is already the Worker initialInput. Repeating it
      // in the graph projection would pay the same context tax twice.
      "  " + kv("from", from),
    ]);
    addSection(
      "references",
      from
        .map((id) => nodes.find((node) => String(node.id) === id))
        .filter((node) => node && (node.node_type === "fact" || node.node_type === "finding"))
        .map((node) => {
          const body = (node?.body_json ?? {}) as Record<string, unknown>;
          const finding = findingByNode.get(String(node?.id));
          return row({
            id: node?.id,
            kind: node?.node_type,
            title: short(node?.title, 160),
            status: node?.status,
            description: short(body.description ?? body.summary ?? finding?.summary, 520),
            ...(finding ? { finding_id: finding.id, verify_status: finding.verify_status } : {}),
          });
        }),
    );
    addSection(
      "confirmed_background",
      findingRows
        .filter((finding) => finding.verify_status === "confirmed")
        .slice(0, 24)
        .map((finding) => row({
          finding_id: finding.id,
          title: short(finding.title, 160),
          severity: finding.severity,
          verify_status: finding.verify_status,
        })),
    );
  } else if (scope === "verify") {
    const finding = options.findingId ? findingById.get(options.findingId) : undefined;
    const findingNode = finding?.node_id
      ? nodes.find((node) => String(node.id) === String(finding.node_id))
      : undefined;
    const findingBody = (findingNode?.body_json ?? {}) as Record<string, unknown>;
    const verification = finding ? verificationSummaries.get(String(finding.id)) ?? {} : {};
    addSection("finding", [
      "  " + kv("id", finding?.id ?? options.findingId ?? null),
      "  " + kv("node_id", finding?.node_id ?? null),
      "  " + kv("title", short(finding?.title ?? findingNode?.title, 220)),
      "  " + kv("severity", finding?.severity ?? findingBody.severity ?? null),
      "  " + kv("verify_status", finding?.verify_status ?? null),
      "  " + kv("location", short(finding?.location ?? findingBody.location, 360)),
      "  " + kv("summary", short(finding?.summary ?? findingBody.summary, 1_000)),
      "  " + kv("verification", verification),
    ]);
    addSection(
      "evidence",
      factNodes
        .filter((node) => {
          const body = (node.body_json ?? {}) as Record<string, unknown>;
          return String((body.verification as Record<string, unknown> | undefined)?.finding_id ?? "") === String(options.findingId);
        })
        .map((node) => {
          const body = (node.body_json ?? {}) as Record<string, unknown>;
          const evidence = (body.verification ?? {}) as Record<string, unknown>;
          return row({
            id: node.id,
            title: short(node.title, 160),
            evidence_kind: evidence.evidence_kind,
            outcome: evidence.outcome,
            subject_revision: short(evidence.subject_revision, 220),
            steps: Array.isArray(evidence.steps) ? evidence.steps.slice(0, 8).map((step) => short(step, 240)) : [],
            expected: short(evidence.expected, 520),
            actual: short(evidence.actual, 520),
            artifact_refs: Array.isArray(evidence.artifact_refs) ? evidence.artifact_refs.slice(0, 8) : [],
            limitations: Array.isArray(evidence.limitations) ? evidence.limitations.slice(0, 8).map((item) => short(item, 240)) : [],
          });
        }),
    );
  } else {
    const counts: Record<string, number> = {};
    for (const finding of findingRows) {
      const status = String(finding.verify_status ?? "unknown");
      counts[status] = (counts[status] ?? 0) + 1;
    }
    addSection("report", [
      "  " + kv("report_input_authoritative", true),
      "  " + kv("finding_counts_by_verify_status", counts),
      "  " + kv("note", "完整报告上下文来自 Scheduler 生成的 report-input.json。"),
    ]);
  }

  const markers = graphProjectionMarkers(truncated, omitted);
  lines[1] = markers.truncated;
  lines[2] = markers.omitted;
  let yaml = lines.join("\n");
  if (yaml.length > maxChars) {
    truncated = true;
    omit("overflow");
    while (lines.length > 8 && lines.join("\n").length > maxChars - 128) lines.pop();
    const overflowMarkers = graphProjectionMarkers(true, omitted);
    lines[1] = overflowMarkers.truncated;
    lines[2] = overflowMarkers.omitted;
    yaml = lines.join("\n");
  }
  return {
    scope,
    goal,
    target,
    yaml,
    referableIds,
    openIntentCount: openIntents.length,
    yamlChars: yaml.length,
    truncated,
    omitted,
    nodeCounts,
  };
}

/** Strip markdown fences before JSON.parse; return null on malformed output. */
export function parseJsonLoose(raw: string): unknown | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface HubIntent {
  from: string[];
  role: string;
  description: string;
  prompt: string;
}

export interface HubDecision {
  complete?: { from: string[]; description: string };
  intents?: HubIntent[];
}

export interface HubReferenceNode {
  id: string;
  node_type: "root" | "fact" | "finding";
}

export type HubReferenceLookup = (
  tx: typeof sql,
  canvasId: string,
  ids: readonly string[],
) => Promise<HubReferenceNode[]>;

type ReferencePath = { path: string; value: unknown };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function inspectReferenceFields(value: unknown): ReferencePath | null {
  const object = objectValue(value);
  if (!object) return null;

  if ("complete" in object) {
    const complete = objectValue(object.complete);
    if (!complete) return { path: "complete.from", value: undefined };
    if (!("from" in complete)) return { path: "complete.from", value: undefined };
    if (!Array.isArray(complete.from)) return { path: "complete.from", value: complete.from };
    for (let index = 0; index < complete.from.length; index += 1) {
      if (!GraphNodeReference.safeParse(complete.from[index]).success) {
        return { path: `complete.from.${index}`, value: complete.from[index] };
      }
    }
  }

  if ("intents" in object) {
    if (!Array.isArray(object.intents)) return { path: "intents", value: object.intents };
    for (let index = 0; index < object.intents.length; index += 1) {
      const intent = objectValue(object.intents[index]);
      if (!intent || !("from" in intent)) return { path: `intents.${index}.from`, value: undefined };
      if (!Array.isArray(intent.from)) return { path: `intents.${index}.from`, value: intent.from };
      for (let refIndex = 0; refIndex < intent.from.length; refIndex += 1) {
        if (!GraphNodeReference.safeParse(intent.from[refIndex]).success) {
          return { path: `intents.${index}.from.${refIndex}`, value: intent.from[refIndex] };
        }
      }
    }
  }

  return null;
}

function refsOf(decision: HubDecision): Array<{ path: string; value: string }> {
  const refs: Array<{ path: string; value: string }> = [];
  for (const [index, value] of (decision.complete?.from ?? []).entries()) {
    refs.push({ path: `complete.from.${index}`, value });
  }
  for (const [intentIndex, intent] of (decision.intents ?? []).entries()) {
    for (const [refIndex, value] of intent.from.entries()) {
      refs.push({ path: `intents.${intentIndex}.from.${refIndex}`, value });
    }
  }
  return refs;
}

/** Validate shape and canonical graph references before any side effect. */
export function parseHubDecisionPayload(
  value: unknown,
  referableIds?: ReadonlySet<string> | readonly string[],
): HubDecision {
  const invalidShapeRef = inspectReferenceFields(value);
  if (invalidShapeRef) throw invalidNodeReference(invalidShapeRef.path, invalidShapeRef.value);

  const budgetViolation = hubReferenceBudgetViolation(value);
  if (budgetViolation) {
    throw invalidReferenceBudget(
      budgetViolation.path.join("."),
      budgetViolation.count,
      budgetViolation.limit,
    );
  }

  const parsed = HubDecisionPayloadSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      const keys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys.join(",") : "<unknown>";
      throw unknownControlField(issue.path.length > 0 ? issue.path.join(".") : `hub_decision.${keys}`);
    }
    throw invalidControlPayload(
      "Hub 决策必须且只能提供 complete、intents 或 payload_file 之一，且每个字段都必须完整（payload_file 须在宿主展开后变为 complete/intents）。",
      issue?.path.join(".") || "hub_decision",
    );
  }

  // HubDecisionPayload is a single object with optional complete|intents (xor via superRefine).
  // Do not use `"complete" in data` — optional keys may be present as undefined.
  const data = parsed.data;
  const decision: HubDecision = data.complete
    ? { complete: data.complete }
    : {
        intents: (data.intents ?? []).map((intent) => ({
          ...intent,
          role: intent.role.trim(),
          description: intent.description.trim(),
          prompt: intent.prompt.trim(),
        })),
      };

  if (referableIds !== undefined) assertHubDecisionReferableIds(decision, referableIds);
  return decision;
}

/** Reject references that are not nodes visible/referable in this canvas. */
export function assertHubDecisionReferableIds(
  decision: HubDecision,
  referableIds: ReadonlySet<string> | readonly string[],
): HubDecision {
  const allowed = referableIds instanceof Set ? referableIds : new Set(referableIds);
  for (const ref of refsOf(decision)) {
    if (!allowed.has(ref.value)) throw invalidNodeReference(ref.path, ref.value);
  }
  return decision;
}

/** The single bounded membership query used by the core Hub reference service. */
export const queryHubReferenceNodes: HubReferenceLookup = async (tx, canvasId, ids) => tx<HubReferenceNode[]>`
  SELECT id, node_type FROM canvas_nodes
  WHERE id = ANY(${ids}::uuid[])
    AND canvas_id = ${canvasId}
    AND node_type = ANY(${["root", "fact", "finding"]})`;

/**
 * Resolve referable IDs in one bounded Scheduler query before inserting
 * jobs/edges. The returned read-only map is the validated snapshot that core
 * reuses while constructing every Hub edge; callers must not query each ID
 * again.
 */
export async function assertHubDecisionCanvasReferences(
  tx: typeof sql,
  canvasId: string,
  decision: HubDecision,
  lookup: HubReferenceLookup = queryHubReferenceNodes,
): Promise<ReadonlyMap<string, HubReferenceNode>> {
  const ids = [...new Set(refsOf(decision).map((ref) => ref.value))];
  if (ids.length === 0) return new Map();
  const rows = await lookup(tx, canvasId, ids);
  const validated = new Map(rows.map((row) => [String(row.id), {
    id: String(row.id),
    node_type: row.node_type,
  }] as const));
  assertHubDecisionReferableIds(decision, new Set(validated.keys()));
  return validated;
}

/** Validate a dynamic Hub decision against this Job's available role set. */
export function parseHubDecision(
  raw: string,
  allowedRoles: ReadonlySet<string>,
  referableIds?: ReadonlySet<string> | readonly string[],
): HubDecision | null {
  const value = parseJsonLoose(raw);
  if (!value || typeof value !== "object") return null;
  let decision: HubDecision;
  try {
    decision = parseHubDecisionPayload(value, referableIds);
  } catch (error) {
    if (error instanceof ControlInputError && ["invalid_node_ref", "invalid_reference_budget"].includes(error.code)) {
      throw error;
    }
    return null;
  }
  if (decision.intents && decision.intents.some((intent) => !allowedRoles.has(intent.role))) return null;
  return decision;
}
