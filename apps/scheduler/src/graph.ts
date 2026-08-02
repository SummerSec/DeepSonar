import { sql } from "./db.js";

/**
 * 图语义（Cairn 式 fact-intent 二分图，ARCHITECTURE §8.3）：
 * hub_reason 读整张图画决策；角色 agent（explore 等）把发现写成 fact 节点。
 * 本模块负责：图 → prompt 用 YAML 文本；agent 输出 → 结构化解析。
 */

export interface GraphSnapshot {
  goal: string;
  target: Record<string, unknown>;
  yaml: string;
  /** 图中可被 intent.from 引用的节点 id（fact/finding/root） */
  referableIds: string[];
  openIntentCount: number;
}

/** 行式 YAML（LLM 消费用；字符串值 JSON 转义，避免手写 block scalar） */
function kv(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value ?? null)}`;
}

export async function buildGraphSnapshot(canvasId: string): Promise<GraphSnapshot> {
  const [canvas] = await sql`
    SELECT title, target_json FROM canvases WHERE id = ${canvasId}`;
  const nodes = await sql`
    SELECT id, node_type, title, body_json, status
    FROM canvas_nodes WHERE canvas_id = ${canvasId}
    ORDER BY created_at`;
  const edges = await sql`
    SELECT from_node_id, to_node_id, edge_type
    FROM canvas_edges WHERE canvas_id = ${canvasId}`;

  const target = (canvas?.target_json ?? {}) as Record<string, unknown>;
  const goal = String(target.goal ?? canvas?.title ?? "");
  const root = nodes.find((n) => n.node_type === "root");

  const facts = nodes.filter((n) => n.node_type === "fact" || n.node_type === "finding");
  const openIntents = nodes.filter(
    (n) => n.node_type === "intent" && !["succeeded", "failed", "cancelled"].includes(n.status as string),
  );
  const doneIntents = nodes.filter(
    (n) => n.node_type === "intent" && (n.status as string) === "succeeded",
  );
  const hints = nodes.filter((n) => n.node_type === "human");

  // intent ← from 边引用（fact → intent）
  const intentFrom = new Map<string, string[]>();
  for (const e of edges) {
    if (e.edge_type !== "from") continue;
    const list = intentFrom.get(e.to_node_id as string) ?? [];
    list.push(e.from_node_id as string);
    intentFrom.set(e.to_node_id as string, list);
  }

  // Finding 表：验证状态与轮次（Hub 回弹决策用）
  const findingRows = await sql`
    SELECT f.id, f.node_id, f.verify_status
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}`;
  const findingByNode = new Map(findingRows.map((r) => [r.node_id as string, r]));

  const lines: string[] = [];
  lines.push(kv("goal", goal));
  lines.push(kv("target", target));
  lines.push(kv("root_id", root?.id ?? null));
  lines.push(kv("root_status", root?.status ?? null));
  lines.push("facts:");
  for (const f of facts) {
    const body = (f.body_json ?? {}) as Record<string, unknown>;
    lines.push(`  - ${kv("id", f.id)}`);
    lines.push(`    ${kv("kind", f.node_type)}`);
    lines.push(`    ${kv("title", f.title)}`);
    lines.push(`    ${kv("status", f.status)}`);
    if (body.description) lines.push(`    ${kv("description", String(body.description).slice(0, 600))}`);
    if (body.severity) lines.push(`    ${kv("severity", body.severity)}`);
    if (body.location) lines.push(`    ${kv("location", body.location)}`);
    if (body.summary) lines.push(`    ${kv("summary", String(body.summary).slice(0, 400))}`);
    // 验证证据节点：输出硬门相关完整字段（steps/expected/actual），便于 Hub/Verify 读图
    const ver = body.verification as Record<string, unknown> | undefined;
    if (ver) {
      lines.push(`    ${kv("finding_id", ver.finding_id)}`);
      lines.push(`    ${kv("evidence_kind", ver.evidence_kind)}`);
      lines.push(`    ${kv("outcome", ver.outcome)}`);
      if (ver.subject_revision) lines.push(`    ${kv("subject_revision", ver.subject_revision)}`);
      if (ver.environment) lines.push(`    ${kv("environment", ver.environment)}`);
      if (ver.steps) lines.push(`    ${kv("steps", ver.steps)}`);
      if (ver.expected) lines.push(`    ${kv("expected", String(ver.expected).slice(0, 800))}`);
      if (ver.actual) lines.push(`    ${kv("actual", String(ver.actual).slice(0, 800))}`);
      if (ver.artifact_refs) lines.push(`    ${kv("artifact_refs", ver.artifact_refs)}`);
      if (ver.limitations) lines.push(`    ${kv("limitations", ver.limitations)}`);
    }
    // Finding 节点：输出验证轮次与缺口
    if (f.node_type === "finding") {
      const fr = findingByNode.get(f.id as string);
      if (fr) {
        const { findingVerificationSummary } = await import("./verify.js");
        const summary = await findingVerificationSummary(sql, fr.id as string);
        lines.push(`    ${kv("verify_status", summary.verify_status)}`);
        lines.push(`    ${kv("verification_attempt", summary.verification_attempt)}`);
        lines.push(`    ${kv("latest_outcome", summary.latest_outcome)}`);
        lines.push(`    ${kv("missing_evidence", summary.missing_evidence)}`);
        lines.push(`    ${kv("review_evidence_ids", summary.review_evidence_ids)}`);
        lines.push(`    ${kv("test_evidence_ids", summary.test_evidence_ids)}`);
        lines.push(`    ${kv("conflicting_evidence_ids", summary.conflicting_evidence_ids)}`);
      }
    }
  }
  if (facts.length === 0) lines.push("  []");
  lines.push("open_intents:");
  for (const it of openIntents) {
    const body = (it.body_json ?? {}) as Record<string, unknown>;
    lines.push(`  - ${kv("id", it.id)}`);
    lines.push(`    ${kv("role", body.role ?? "explore")}`);
    lines.push(`    ${kv("status", it.status)}`);
    lines.push(`    ${kv("description", body.description ?? it.title)}`);
    lines.push(`    ${kv("from", intentFrom.get(it.id as string) ?? [])}`);
  }
  if (openIntents.length === 0) lines.push("  []");
  if (doneIntents.length > 0) {
    lines.push("concluded_intents:");
    for (const it of doneIntents) {
      lines.push(`  - ${kv("description", ((it.body_json ?? {}) as Record<string, unknown>).description ?? it.title)}`);
    }
  }
  if (hints.length > 0) {
    lines.push("hints:");
    for (const h of hints) {
      lines.push(`  - ${kv("content", ((h.body_json ?? {}) as Record<string, unknown>).reason ?? h.title)}`);
    }
  }

  return {
    goal,
    target,
    yaml: lines.join("\n"),
    referableIds: [
      ...facts.map((f) => f.id as string),
      ...nodes.filter((n) => n.node_type === "root").map((n) => n.id as string),
    ],
    openIntentCount: openIntents.length,
  };
}

/** 剥 markdown 代码围栏后 JSON.parse；失败返回 null */
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
    // 模型有时在 JSON 前后加解释文字：截取第一个 { 到最后一个 }
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
  /** 直接作为 Worker CLI 的本轮 input 注入。 */
  prompt: string;
}

export interface HubDecision {
  complete?: { from: string[]; description: string };
  intents?: HubIntent[];
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 动态系统工具提交的 Hub 决策；role 必须来自本 Job 的可用角色工具结果。 */
export function parseHubDecision(raw: string, allowedRoles: ReadonlySet<string>): HubDecision | null {
  const v = parseJsonLoose(raw);
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;

  if (o.complete && typeof o.complete === "object") {
    const c = o.complete as Record<string, unknown>;
    if (typeof c.description === "string" && c.description.trim()) {
      return { complete: { from: strArray(c.from), description: c.description } };
    }
  }
  if (Array.isArray(o.intents)) {
    const intents: HubIntent[] = [];
    for (const it of o.intents) {
      if (!it || typeof it !== "object") continue;
      const i = it as Record<string, unknown>;
      if (typeof i.description !== "string" || !i.description.trim()) continue;
      if (typeof i.prompt !== "string" || !i.prompt.trim()) continue;
      if (typeof i.role !== "string" || !allowedRoles.has(i.role.trim())) return null;
      intents.push({
        from: strArray(i.from),
        role: i.role.trim(),
        description: i.description.slice(0, 2_000),
        prompt: i.prompt.trim().slice(0, 20_000),
      });
    }
    // 空 intents 不是合法决策：应 complete 或派发至少一个 intent，避免 Hub 空转烧 maxHubRounds
    if (intents.length === 0) return null;
    return { intents };
  }
  return null;
}
