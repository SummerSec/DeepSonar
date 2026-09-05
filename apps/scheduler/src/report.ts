/**
 * 任务级最终报告：收敛后幂等派发 Report Job，确定性输入 + 产物校验 + SARIF。
 * As-built 语义见根目录 DESIGN.md（双轨 Task/Finding Report）。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDeclaredQuantities, type QuantityAnchor } from "@deepsonar/shared-types";
import { config } from "./config.js";
import { sql } from "./db.js";
import {
  fixedPriorityForJob,
  maybeTriggerHub,
  patchCanvasConvergence,
  resolveAgentSnapshotForJob,
  rulesForProject,
} from "./core.js";
import { recordJobSharedAssets } from "./domains/shared-assets/index.js";
import { freezeAgentSnapshotNetworkPolicy } from "./domains/role-runtime-snapshot/index.js";
import { assertFrozenRuntimeImageLocal, RuntimeImageNotLocalError } from "./runtime-images.js";
import { careSeverityMeta, evaluateAnalysisCompleteGate } from "./verify.js";
import type { FindingStatusProblem } from "./verify.js";
import { planTaskReportVersion } from "./task-report-version.js";
import { frozenTaskSeeds } from "./task-compose.js";
import {
  checkReportNumericFidelity,
  declaredQuantitiesFromPayloads,
  factQuantityParticipatesInGate,
  formatQuantityLine,
  numericInconsistentError,
  type NumericFidelityResult,
} from "./report-numeric-fidelity.js";

type Tx = typeof sql;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function reportDir(canvasId: string, version: number): string {
  const safe = canvasId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return path.join(config.storage.blobDir, "reports", safe || "unknown", `v${version}`);
}

function findingReportDir(findingId: string, version: number): string {
  const safe = findingId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return path.join(config.storage.blobDir, "finding-reports", safe || "unknown", `v${version}`);
}

const ACTIVE_REPORT_STATUSES = ["pending", "generating"];
const ACTIVE_REPORT_JOB_STATUSES = ["pending", "claimed", "provisioning", "running", "waiting_human"];
const TERMINAL_REPORT_JOB_STATUSES = ["succeeded", "failed", "timeout", "cancelled", "orphan"];

/**
 * 修复关联 Job 已进入终态、但常规 finalizer 尚未执行而遗留的活跃报告行。
 * Job lifecycle 仍是权威；这里只把已提交终态投影到派生 finding_reports，
 * 使下一版本可以入队。
 */
async function reconcileTerminalFindingReportJob(
  tx: Tx,
  report: Record<string, unknown>,
): Promise<boolean> {
  const reportId = String(report.id);
  const reportJobId = report.report_job_id ? String(report.report_job_id) : null;
  const [job] = reportJobId
    ? await tx`SELECT status, error FROM jobs WHERE id = ${reportJobId}`
    : [];
  const jobStatus = job?.status ? String(job.status) : "missing";
  if (job && ACTIVE_REPORT_JOB_STATUSES.includes(jobStatus)) return false;
  const knownTerminal = TERMINAL_REPORT_JOB_STATUSES.includes(jobStatus);

  const error = job?.error
    ? String(job.error)
    : knownTerminal || !job
      ? `finding report job ended before claim (${jobStatus})`
      : `finding report job has an invalid lifecycle state (${jobStatus})`;
  await tx`
    UPDATE finding_reports
    SET status = 'failed', error = ${error}, updated_at = now()
    WHERE id = ${reportId} AND status = ANY(${ACTIVE_REPORT_STATUSES})`;
  return true;
}

export interface ReportInputFinding {
  id: string;
  title: string;
  severity: string | null;
  profile: string;
  category: string | null;
  tags: string[];
  evidence_refs: string[];
  scoring: Record<string, unknown> | null;
  location: string | null;
  summary: string | null;
  verify_status: string;
  final_verification_round: Record<string, unknown> | null;
  review_evidence: unknown[];
  test_evidence: unknown[];
  limitations: string[];
  verification_policy: {
    eligibility: "below_min_verify_severity";
    min_verify_severity: string | null;
  } | null;
  quantities?: QuantityAnchor[];
}

export interface ReportInput {
  task: {
    canvas_id: string;
    title: string;
    goal: string;
    project_id: string;
    kind: "standard" | "compose";
    effective_finding_protocol: Record<string, unknown> | null;
  };
  statistics: {
    findings_total: number;
    confirmed_count: number;
    needs_human_count: number;
    excluded_count: number;
    confirmed_by_severity: Record<string, number>;
  };
  findings: ReportInputFinding[];
  confirmed_findings: ReportInputFinding[];
  needs_human_findings: ReportInputFinding[];
  excluded_findings: ReportInputFinding[];
  seed_findings: Array<{
    title: string;
    severity: string | null;
    profile: string;
    category: string | null;
    tags: string[];
    location: string | null;
    summary: string | null;
    frozen_disposition: string;
    frozen_verify_status: string;
  }>;
  scope_and_coverage: Record<string, unknown>;
  evidence: unknown[];
  facts?: Array<{
    id: string;
    title: string;
    verification_status: string;
    quantities: QuantityAnchor[];
  }>;
}

export interface FindingReportInput {
  scope: "finding";
  report_version: number;
  frozen_at: string;
  input_budget_chars: number;
  input_truncated: boolean;
  project: { id: string; name: string };
  task: { canvas_id: string; title: string; effective_finding_protocol: Record<string, unknown> | null };
  finding: {
    id: string;
    fingerprint: string;
    title: string;
    severity: string | null;
    profile: string;
    category: string | null;
    tags: string[];
    evidence_refs: string[];
    scoring: Record<string, unknown> | null;
    location: string | null;
    summary: string | null;
    verify_status: "confirmed";
    source_job_id: string;
    details: Record<string, unknown>;
    quantities?: QuantityAnchor[];
  };
  verification_rounds: Array<{
    attempt: number;
    status: string;
    proposed_verdict: string | null;
    final_outcome: string | null;
    summary: string | null;
    error: string | null;
    created_at: unknown;
    finished_at: unknown;
  }>;
  evidence: {
    review: unknown[];
    test: unknown[];
    missing: string[];
    omitted: { review: number; test: number; rounds: number };
  };
  limitations: string[];
}

function allowlistedFindingDetails(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const allowed = ["category", "rule_id", "impact", "reproduction", "remediation", "references", "tags"];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function shortReportText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function compactReportValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return shortReportText(value, 2_000);
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactReportValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key, compactReportValue(item, depth + 1)]),
    );
  }
  return shortReportText(value, 2_000);
}

function enforceFindingReportInputBudget(input: FindingReportInput): FindingReportInput {
  const maxChars = Math.max(4_000, config.graph.maxFindingReportInputChars);
  input.input_budget_chars = maxChars;
  if (JSON.stringify(input).length <= maxChars) return input;

  const review = input.evidence.review.slice(0, 20).map((row) => compactReportValue(row));
  const runtimeTest = input.evidence.test.slice(0, 20).map((row) => compactReportValue(row));
  const rounds = input.verification_rounds.slice(-20).map((round) => ({
    ...round,
    summary: shortReportText(round.summary, 2_000),
    error: shortReportText(round.error, 2_000),
  }));
  const omitted = {
    review: Math.max(0, input.evidence.review.length - review.length),
    test: Math.max(0, input.evidence.test.length - runtimeTest.length),
    rounds: Math.max(0, input.verification_rounds.length - rounds.length),
  };
  const candidate: FindingReportInput = {
    ...input,
    input_truncated: true,
    project: { ...input.project, name: shortReportText(input.project.name, 500) ?? "" },
    task: { ...input.task, title: shortReportText(input.task.title, 500) ?? "" },
    finding: {
      ...input.finding,
      title: shortReportText(input.finding.title, 500) ?? "",
      location: shortReportText(input.finding.location, 1_000),
      summary: shortReportText(input.finding.summary, 4_000),
      details: compactReportValue(input.finding.details) as Record<string, unknown>,
    },
    verification_rounds: rounds,
    evidence: {
      review,
      test: runtimeTest,
      missing: input.evidence.missing.slice(0, 50).map((item) => shortReportText(item, 500) ?? ""),
      omitted,
    },
    limitations: [...new Set([
      ...input.limitations.slice(0, 50).map((item) => shortReportText(item, 500) ?? ""),
      `input_truncated:max_chars=${maxChars}`,
    ])],
  };

  while (JSON.stringify(candidate).length > maxChars && (review.length > 0 || runtimeTest.length > 0)) {
    if (review.length >= runtimeTest.length && review.length > 0) {
      review.pop();
      omitted.review += 1;
    } else {
      runtimeTest.pop();
      omitted.test += 1;
    }
  }
  while (JSON.stringify(candidate).length > maxChars && rounds.length > 1) {
    rounds.shift();
    omitted.rounds += 1;
  }
  if (JSON.stringify(candidate).length > maxChars) {
    candidate.finding.details = {};
    candidate.finding.summary = shortReportText(candidate.finding.summary, 500);
    candidate.verification_rounds = rounds.slice(-1).map((round) => ({
      ...round,
      summary: shortReportText(round.summary, 500),
      error: shortReportText(round.error, 500),
    }));
    omitted.rounds += Math.max(0, rounds.length - candidate.verification_rounds.length);
    candidate.evidence.review = [];
    candidate.evidence.test = [];
    omitted.review = input.evidence.review.length;
    omitted.test = input.evidence.test.length;
  }
  if (JSON.stringify(candidate).length > maxChars) {
    throw new Error(`finding report input exceeds ${maxChars} characters after truncation`);
  }
  return candidate;
}

/** 从数据库确定性生成报告输入（不含 Agent 创作内容）。 */
export async function buildReportInput(canvasId: string, db: typeof sql = sql): Promise<ReportInput> {
  const [canvas] = await db`
    SELECT c.id, c.title, c.target_json, c.project_id, p.name AS project_name
    FROM canvases c
    JOIN projects p ON p.id = c.project_id
    WHERE c.id = ${canvasId}`;
  if (!canvas) throw new Error(`canvas not found: ${canvasId}`);

  const target = (canvas.target_json ?? {}) as Record<string, unknown>;
  const seedFindings = frozenTaskSeeds(target);
  const reportSeedFindings = seedFindings.map((seed) => ({
    title: seed.title,
    severity: seed.severity,
    profile: seed.profile,
    category: seed.category,
    tags: seed.tags,
    location: seed.location,
    summary: seed.summary,
    frozen_disposition: seed.disposition,
    frozen_verify_status: seed.verify_status,
  }));
  const findings = await db`
    SELECT f.id, f.title, f.severity, f.profile, f.category, f.tags_json,
           f.evidence_refs_json, f.scoring_json, f.location, f.summary,
           f.verify_status, f.raw_json, f.job_id, f.node_id
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}
    ORDER BY
      CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      f.created_at`;

  const items: ReportInputFinding[] = [];
  for (const f of findings) {
    const [round] = await db`
      SELECT attempt, status, final_outcome, proposed_verdict, evidence_snapshot_json, summary, error, finished_at
      FROM finding_verification_rounds
      WHERE finding_id = ${f.id as string}
      ORDER BY attempt DESC LIMIT 1`;
    const snap = (round?.evidence_snapshot_json ?? {}) as {
      review?: unknown[];
      test?: unknown[];
    };
    const raw = (f.raw_json ?? {}) as Record<string, unknown>;
    const verificationState = raw.verification_state && typeof raw.verification_state === "object" &&
        !Array.isArray(raw.verification_state)
      ? raw.verification_state as Record<string, unknown>
      : {};
    const verificationPolicy = f.verify_status === "pending" && verificationState.eligibility === "below_min_verify_severity"
      ? {
          eligibility: "below_min_verify_severity" as const,
          min_verify_severity: typeof verificationState.min_verify_severity === "string"
            ? verificationState.min_verify_severity
            : null,
        }
      : null;
    items.push({
      id: f.id as string,
      title: f.title as string,
      severity: (f.severity as string | null) ?? null,
      profile: String(f.profile),
      category: (f.category as string | null) ?? null,
      tags: (f.tags_json as string[]) ?? [],
      evidence_refs: (f.evidence_refs_json as string[]) ?? [],
      scoring: Object.keys((f.scoring_json ?? {}) as Record<string, unknown>).length
        ? (f.scoring_json as Record<string, unknown>)
        : null,
      location: (f.location as string) ?? null,
      summary: (f.summary as string) ?? null,
      quantities: parseDeclaredQuantities((raw as { quantities?: unknown }).quantities),
      verify_status: f.verify_status as string,
      final_verification_round: round
        ? {
            attempt: round.attempt,
            final_outcome: round.final_outcome,
            proposed_verdict: round.proposed_verdict,
            summary: round.summary,
            error: round.error,
            finished_at: round.finished_at,
          }
        : null,
      review_evidence: snap.review ?? [],
      test_evidence: snap.test ?? [],
      limitations: [],
      verification_policy: verificationPolicy,
    });
  }

  const confirmed = items.filter((i) => i.verify_status === "confirmed");
  const needsHuman = items.filter((i) => i.verify_status === "needs_human");
  const excluded = items.filter((i) => i.verification_policy?.eligibility === "below_min_verify_severity");
  const bySev: Record<string, number> = {};
  for (const c of confirmed) {
    const severity = c.severity ?? "unscored";
    bySev[severity] = (bySev[severity] ?? 0) + 1;
  }

  return {
    task: {
      canvas_id: canvasId,
      title: canvas.title as string,
      goal: String(target.goal ?? canvas.title ?? ""),
      project_id: canvas.project_id as string,
      kind: target.kind === "compose" ? "compose" : "standard",
      effective_finding_protocol:
        (target.effective_finding_protocol as Record<string, unknown> | undefined) ?? null,
    },
    statistics: {
      findings_total: items.length,
      confirmed_count: confirmed.length,
      needs_human_count: needsHuman.length,
      excluded_count: excluded.length,
      confirmed_by_severity: bySev,
    },
    findings: items,
    confirmed_findings: confirmed,
    needs_human_findings: needsHuman,
    excluded_findings: excluded,
    seed_findings: reportSeedFindings,
    scope_and_coverage: {
      goal: String(target.goal ?? ""),
      task_kind: target.kind === "compose" ? "compose" : "standard",
      seed_count: seedFindings.length,
      network_policy: target.network_policy ?? null,
      effective_finding_protocol: target.effective_finding_protocol ?? null,
    },
    evidence: [],
    facts: await loadReportFactQuantities(canvasId, db),
  };
}

async function loadReportFactQuantities(
  canvasId: string,
  db: typeof sql,
): Promise<NonNullable<ReportInput["facts"]>> {
  const rows = await db`
    SELECT id, title, verification_status, body_json
    FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'fact'
    ORDER BY created_at`;
  const facts: NonNullable<ReportInput["facts"]> = [];
  for (const row of rows) {
    const body = (row.body_json ?? {}) as Record<string, unknown>;
    const quantities = parseDeclaredQuantities(body.quantities);
    if (quantities.length === 0) continue;
    facts.push({
      id: String(row.id),
      title: String(row.title ?? ""),
      verification_status: String(row.verification_status ?? "unverified"),
      quantities,
    });
  }
  return facts;
}

/** Freeze one confirmed Finding and its verification evidence for a versioned report. */
export async function buildFindingReportInput(
  findingId: string,
  version: number,
  db: typeof sql = sql,
): Promise<FindingReportInput> {
  const [finding] = await db`
    SELECT f.id, f.project_id, f.fingerprint, f.title, f.severity, f.profile,
           f.category, f.tags_json, f.evidence_refs_json, f.scoring_json,
           f.location, f.summary, f.verify_status, f.raw_json, f.job_id,
           j.canvas_id, c.title AS canvas_title, c.target_json, p.name AS project_name
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    JOIN canvases c ON c.id = j.canvas_id
    JOIN projects p ON p.id = f.project_id
    WHERE f.id = ${findingId}`;
  if (!finding) throw new Error(`finding not found: ${findingId}`);
  if (finding.verify_status !== "confirmed") {
    throw new Error(`finding ${findingId} is not confirmed`);
  }

  const rounds = await db`
    SELECT attempt, status, proposed_verdict, final_outcome, evidence_snapshot_json,
           summary, error, created_at, finished_at
    FROM finding_verification_rounds
    WHERE finding_id = ${findingId}
    ORDER BY attempt ASC`;
  const confirmedRound = [...rounds].reverse().find((round) => round.final_outcome === "confirmed");
  const snapshot = (confirmedRound?.evidence_snapshot_json ?? {}) as {
    review?: unknown[];
    test?: unknown[];
    missing?: string[];
  };

  const input: FindingReportInput = {
    scope: "finding",
    report_version: version,
    frozen_at: new Date().toISOString(),
    input_budget_chars: Math.max(4_000, config.graph.maxFindingReportInputChars),
    input_truncated: false,
    project: { id: String(finding.project_id), name: String(finding.project_name) },
    task: {
      canvas_id: String(finding.canvas_id),
      title: String(finding.canvas_title),
      effective_finding_protocol:
        ((((finding.target_json ?? {}) as Record<string, unknown>).effective_finding_protocol as Record<string, unknown> | undefined) ?? null),
    },
    finding: {
      id: String(finding.id),
      fingerprint: String(finding.fingerprint),
      title: String(finding.title),
      severity: (finding.severity as string | null) ?? null,
      profile: String(finding.profile),
      category: (finding.category as string | null) ?? null,
      tags: (finding.tags_json as string[]) ?? [],
      evidence_refs: (finding.evidence_refs_json as string[]) ?? [],
      scoring: Object.keys((finding.scoring_json ?? {}) as Record<string, unknown>).length
        ? (finding.scoring_json as Record<string, unknown>)
        : null,
      location: (finding.location as string | null) ?? null,
      summary: (finding.summary as string | null) ?? null,
      verify_status: "confirmed",
      source_job_id: String(finding.job_id),
      details: allowlistedFindingDetails(finding.raw_json),
      quantities: parseDeclaredQuantities((finding.raw_json as { quantities?: unknown } | null)?.quantities),
    },
    verification_rounds: rounds.map((round) => ({
      attempt: Number(round.attempt),
      status: String(round.status),
      proposed_verdict: (round.proposed_verdict as string | null) ?? null,
      final_outcome: (round.final_outcome as string | null) ?? null,
      summary: (round.summary as string | null) ?? null,
      error: (round.error as string | null) ?? null,
      created_at: round.created_at,
      finished_at: round.finished_at,
    })),
    evidence: {
      review: snapshot.review ?? [],
      test: snapshot.test ?? [],
      missing: snapshot.missing ?? [],
      omitted: { review: 0, test: 0, rounds: 0 },
    },
    limitations: snapshot.missing ?? [],
  };
  return enforceFindingReportInputBudget(input);
}

/** SARIF 2.1.0 子集：仅 confirmed Finding。 */
export function buildSarifFromConfirmed(input: ReportInput): object {
  const results = input.confirmed_findings.map((f) => ({
    ruleId: f.id,
    level: f.severity === "critical" || f.severity === "high" ? "error" : "warning",
    message: { text: f.summary || f.title },
    locations: f.location
      ? [
          {
            physicalLocation: {
              artifactLocation: { uri: f.location.split(":")[0] },
              region: f.location.includes(":")
                ? { startLine: Number(f.location.split(":").pop()) || 1 }
                : undefined,
            },
          },
        ]
      : [],
    properties: {
      severity: f.severity,
      profile: f.profile,
      category: f.category,
      scoring: f.scoring,
      verify_status: "confirmed",
      title: f.title,
      ...(f.quantities && f.quantities.length > 0 ? { quantities: f.quantities } : {}),
    },
  }));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "DeepSonar",
            informationUri: "https://github.com/SummerSec/DeepFlowHunter",
            rules: input.confirmed_findings.map((f) => ({
              id: f.id,
              name: f.title,
              shortDescription: { text: f.title },
              fullDescription: { text: f.summary || f.title },
              defaultConfiguration: {
                level:
                  f.severity === "critical" || f.severity === "high"
                    ? "error"
                    : f.severity === "medium"
                      ? "warning"
                      : "note",
              },
              properties: { severity: f.severity, profile: f.profile, category: f.category, scoring: f.scoring },
            })),
          },
        },
        results,
      },
    ],
  };
}

function defaultMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# 任务报告：${input.task.title}`);
  lines.push("");
  lines.push(`> 目标：${input.task.goal || "（未声明）"}`);
  const protocol = input.task.effective_finding_protocol;
  if (protocol) {
    lines.push(`> Finding 协议：${String(protocol.display_name ?? protocol.default_profile ?? "未命名")}（${String(protocol.source ?? "unknown")}）`);
  }
  lines.push("");
  lines.push("## 执行摘要");
  lines.push("");
  lines.push(
    `本次共发现 **${input.statistics.findings_total}** 条 Finding：已确认 **${input.statistics.confirmed_count}**，待人工 **${input.statistics.needs_human_count}**，因严重度策略未自动验证 **${input.statistics.excluded_count}**。`,
  );
  if (input.statistics.confirmed_count === 0) {
    lines.push("");
    lines.push("**本次未形成已确认漏洞**；这不代表系统绝对安全，仅表示自动验证范围内未形成 confirmed 结论。");
  }
  lines.push("");
  lines.push("## 已确认问题");
  lines.push("");
  if (input.confirmed_findings.length === 0) {
    lines.push("_无_");
  } else {
    for (const profile of [...new Set(input.confirmed_findings.map((finding) => finding.profile))]) {
      lines.push(`### ${profile}`);
      lines.push("");
      for (const f of input.confirmed_findings.filter((finding) => finding.profile === profile)) {
        lines.push(`#### [${f.severity ?? "未评分"}] ${f.title}`);
        lines.push("");
        if (f.category) lines.push(`- 分类：${f.category}`);
        if (f.scoring) lines.push(`- 评分：${String(f.scoring.standard)} ${String(f.scoring.version)} · ${String(f.scoring.base_score ?? "未计算")} · ${String(f.scoring.exploitability_label ?? "未知难度")}`);
        if (f.location) lines.push(`- 位置：\`${f.location}\``);
        if (f.summary) lines.push(`- 摘要：${f.summary}`);
        for (const quantity of f.quantities ?? []) {
          lines.push(`- 数值口径：${formatQuantityLine(quantity)}`);
        }
        lines.push(`- 验证轮次：${f.final_verification_round?.attempt ?? "?"}`);
        lines.push("");
      }
    }
  }
  lines.push("## 待人工确认 / 验证限制");
  lines.push("");
  if (input.needs_human_findings.length === 0) {
    lines.push("_无_");
  } else {
    for (const f of input.needs_human_findings) {
      lines.push(`### [${f.severity ?? "未评分"}] ${f.title}`);
      lines.push("");
      lines.push(`- Profile：${f.profile}`);
      if (f.scoring) lines.push(`- 评分：${String(f.scoring.standard)} ${String(f.scoring.version)} · ${String(f.scoring.base_score ?? "未计算")}`);
      if (f.location) lines.push(`- 位置：\`${f.location}\``);
      if (f.summary) lines.push(`- 摘要：${f.summary}`);
      const err = f.final_verification_round?.error ?? f.final_verification_round?.summary;
      if (err) lines.push(`- 阻塞：${err}`);
      lines.push("");
    }
  }
  lines.push("## 未自动验证（严重度策略）");
  lines.push("");
  if (input.excluded_findings.length === 0) {
    lines.push("_无_");
  } else {
    lines.push("以下 Finding 明确低于任务的自动验证阈值；它们未占用 Verify 资源，也不等于误报或待人工结论。");
    lines.push("");
    for (const f of input.excluded_findings) {
      lines.push(`### [${f.severity ?? "未评分"}] ${f.title}`);
      lines.push("");
      lines.push(`- Profile：${f.profile}`);
      lines.push(`- 自动验证阈值：${f.verification_policy?.min_verify_severity ?? "未知"}`);
      if (f.location) lines.push(`- 位置：\`${f.location}\``);
      if (f.summary) lines.push(`- 摘要：${f.summary}`);
      lines.push("");
    }
  }
  const factQuantities = (input.facts ?? []).filter(
    (fact) => factQuantityParticipatesInGate(fact.verification_status) && fact.quantities.length > 0,
  );
  if (factQuantities.length > 0) {
    lines.push("## 事实数值口径");
    lines.push("");
    for (const fact of factQuantities) {
      lines.push(`### ${fact.title}`);
      lines.push("");
      for (const quantity of fact.quantities) {
        lines.push(`- ${formatQuantityLine(quantity)}`);
      }
      lines.push("");
    }
  }
  lines.push("## 范围与覆盖");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(input.scope_and_coverage, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("_本报告由 DeepSonar 调度器在分析收敛后自动生成；SARIF 仅含 confirmed Finding。_");
  return lines.join("\n");
}

export type ReportMarkdownFallback = "coverage" | "numeric" | null;

function taskReportCoverageOk(input: ReportInput, markdown: string): boolean {
  return (
    input.findings.length === 0 ||
    input.findings.every(
      (f) =>
        markdown.includes(f.id) ||
        markdown.includes(f.title) ||
        (f.verify_status === "confirmed" && markdown.includes("已确认")) ||
        (f.verify_status === "needs_human" && (markdown.includes("人工") || markdown.includes("待"))) ||
        (f.verification_policy?.eligibility === "below_min_verify_severity" && markdown.includes("未自动验证")),
    )
  );
}

/**
 * Coverage/short Agent markdown falls back to the deterministic template.
 * Numeric fail on Agent-produced, coverage-ok markdown also falls back;
 * only a template that still fails the gate hard-fails the report.
 */
export function finalizeTaskReportMarkdown(
  input: ReportInput,
  agentText: string,
): {
  markdown: string;
  numeric: NumericFidelityResult;
  coverageOk: boolean;
  usedDefault: ReportMarkdownFallback;
} {
  let markdown = agentText.trim();
  const coverageOk = taskReportCoverageOk(input, markdown);
  let usedDefault: ReportMarkdownFallback = null;
  if (markdown.length < 20 || !coverageOk) {
    markdown = defaultMarkdown(input);
    usedDefault = "coverage";
  }
  const declared = declaredQuantitiesFromPayloads(input.confirmed_findings, input.facts ?? []);
  let numeric = checkReportNumericFidelity(declared, { markdown });
  if (!numeric.ok && usedDefault === null && coverageOk) {
    markdown = defaultMarkdown(input);
    usedDefault = "numeric";
    numeric = checkReportNumericFidelity(declared, { markdown });
  }
  return { markdown, numeric, coverageOk, usedDefault };
}

export function finalizeFindingReportMarkdown(
  input: FindingReportInput,
  agentText: string,
): {
  markdown: string;
  numeric: NumericFidelityResult;
  usedDefault: ReportMarkdownFallback;
} {
  let markdown = agentText.trim();
  const coverageOk = markdown.includes(input.finding.id) || markdown.includes(input.finding.title);
  let usedDefault: ReportMarkdownFallback = null;
  if (markdown.length < 20 || !coverageOk) {
    markdown = defaultFindingMarkdown(input);
    usedDefault = "coverage";
  }
  const declared = declaredQuantitiesFromPayloads([
    { id: input.finding.id, verify_status: "confirmed", quantities: input.finding.quantities },
  ]);
  let numeric = checkReportNumericFidelity(declared, { markdown });
  if (!numeric.ok && usedDefault === null && coverageOk) {
    markdown = defaultFindingMarkdown(input);
    usedDefault = "numeric";
    numeric = checkReportNumericFidelity(declared, { markdown });
  }
  return { markdown, numeric, usedDefault };
}

function defaultFindingMarkdown(input: FindingReportInput): string {
  const f = input.finding;
  const lines = [
    `# [${f.severity ?? "未评分"}] ${f.title}`,
    "",
    `- Finding ID: \`${f.id}\``,
    `- Fingerprint: \`${f.fingerprint}\``,
    `- Project: ${input.project.name}`,
    `- Task: ${input.task.title}`,
    `- Verification: confirmed`,
    `- Profile: ${f.profile}`,
    `- Category: ${f.category ?? "uncategorized"}`,
    `- Report version: ${input.report_version}`,
  ];
  if (f.scoring) {
    lines.push(`- Scoring: ${String(f.scoring.standard)} ${String(f.scoring.version)} · ${String(f.scoring.base_score ?? "unsupported")}`);
    lines.push(`- Vector: \`${String(f.scoring.vector ?? "unknown")}\``);
  }
  if (f.location) lines.push(`- Location: \`${f.location}\``);
  lines.push("", "## Summary", "", f.summary || "No summary was recorded.");
  if ((f.quantities ?? []).length > 0) {
    lines.push("", "## Quantities", "");
    for (const quantity of f.quantities ?? []) {
      lines.push(`- ${formatQuantityLine(quantity)}`);
    }
  }
  lines.push("", "## Verification", "");
  for (const round of input.verification_rounds) {
    lines.push(`- Round ${round.attempt}: ${round.final_outcome ?? round.status}${round.summary ? ` - ${round.summary}` : ""}`);
  }
  lines.push("", "## Evidence snapshot", "", `- Review evidence: ${input.evidence.review.length}`);
  lines.push(`- Test evidence: ${input.evidence.test.length}`);
  if (input.input_truncated) {
    lines.push(`- Input truncated to ${input.input_budget_chars} characters`);
    lines.push(`- Omitted: review=${input.evidence.omitted.review}, test=${input.evidence.omitted.test}, rounds=${input.evidence.omitted.rounds}`);
  }
  if (input.limitations.length > 0) lines.push(`- Limitations: ${input.limitations.join(", ")}`);
  if (Object.keys(f.details).length > 0) {
    lines.push("", "## Structured details", "", "```json", JSON.stringify(f.details, null, 2), "```");
  }
  lines.push("", "---", `_Frozen at ${input.frozen_at}; this report does not change Finding state._`);
  return lines.join("\n");
}

export interface FindingReportDispatchResult {
  dispatched: boolean;
  reason?: string;
  report_id?: string;
  job_id?: string;
  version?: number;
}

/**
 * 为 confirmed Finding 创建一个版本化报告 Job。
 * Finding 行作为串行锁，自动与手工触发不会创建重叠的活跃版本。
 */
export async function maybeDispatchFindingReport(
  tx: Tx,
  findingId: string,
  opts: { force?: boolean } = {},
): Promise<FindingReportDispatchResult> {
  const [finding] = await tx`
    SELECT f.id, f.project_id, f.verify_status, j.canvas_id
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE f.id = ${findingId}
    FOR UPDATE OF f`;
  if (!finding) return { dispatched: false, reason: "no_finding" };
  if (finding.verify_status !== "confirmed") return { dispatched: false, reason: "not_confirmed" };
  if (!finding.canvas_id) return { dispatched: false, reason: "no_canvas" };

  const [latest] = await tx`
    SELECT id, version, status, report_job_id
    FROM finding_reports
    WHERE finding_id = ${findingId}
    ORDER BY version DESC
    LIMIT 1
    FOR UPDATE`;
  if (latest && ACTIVE_REPORT_STATUSES.includes(String(latest.status))) {
    const reconciled = await reconcileTerminalFindingReportJob(tx, latest as Record<string, unknown>);
    if (!reconciled) {
      return {
        dispatched: false,
        reason: "report_in_flight",
        report_id: String(latest.id),
        job_id: latest.report_job_id ? String(latest.report_job_id) : undefined,
        version: Number(latest.version),
      };
    }
  }
  if (latest?.status === "succeeded" && !opts.force) {
    return { dispatched: false, reason: "already_succeeded", report_id: String(latest.id), version: Number(latest.version) };
  }

  const projectId = String(finding.project_id);
  const canvasId = String(finding.canvas_id);
  const version = Number(latest?.version ?? 0) + 1;
  const snapshot = await freezeAgentSnapshotNetworkPolicy(
    tx as unknown as typeof sql,
    canvasId,
    await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "report", [findingId]),
  );
  try {
    await assertFrozenRuntimeImageLocal(snapshot, { roleName: "report" });
  } catch (error) {
    if (error instanceof RuntimeImageNotLocalError) {
      return { dispatched: false, reason: "runtime_image_not_local" };
    }
    throw error;
  }
  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  const input = await buildFindingReportInput(findingId, version, tx as unknown as typeof sql);
  const inputJson = JSON.stringify(input);
  const inputSha = sha256(inputJson);
  const dir = findingReportDir(findingId, version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report-input.json"), inputJson, "utf8");
  const inputUri = path.posix.join("finding-reports", findingId, `v${version}`, "report-input.json");
  const reportId = randomUUID();
  const ingressKey = `finding-report:${findingId}:v${version}`;

  const [job] = await tx`
    INSERT INTO jobs ${tx({
      project_id: projectId,
      canvas_id: canvasId,
      finding_id: findingId,
      agent_snapshot_json: snapshot as never,
      type: "report",
      priority: fixedPriorityForJob({ type: "report", purpose: "report" }),
      ingress_key: ingressKey,
      payload_json: {
        scheduling_purpose: "report",
        kind: "finding_report",
        finding_id: findingId,
        finding_report_id: reportId,
        report_version: version,
        report_input_uri: inputUri,
      } as never,
      timeout_sec: rules.auditTimeoutSec,
      followup_depth: 0,
    })}
    RETURNING id`;
  await recordJobSharedAssets(tx as unknown as typeof sql, job.id as string, snapshot.shared_assets ?? []);
  if (!job?.id) return { dispatched: false, reason: "insert_failed" };
  await tx`
    INSERT INTO finding_reports ${tx({
      id: reportId,
      finding_id: findingId,
      canvas_id: canvasId,
      project_id: projectId,
      version,
      report_job_id: job.id,
      // 报告 Job 在调度器抢占前保持 pending；抢占事务会随 Job CAS 一并把
      // 此行推进到 generating，使状态表达实际执行生命周期而非入队时刻。
      status: "pending",
      input_uri: inputUri,
      input_sha256: inputSha,
    })}`;
  await tx`SELECT pg_notify('deepsonar_jobs', ${`finding_report:${findingId}`})`;
  return { dispatched: true, report_id: reportId, job_id: String(job.id), version };
}

/**
 * Report 门禁失败：Root 退出 analysis_complete/reporting，force 回弹 Hub 并列出有问题的 Finding。
 */
async function bounceReportGateToHub(
  tx: Tx,
  canvasId: string,
  projectId: string,
  problems: FindingStatusProblem[],
  extra?: { minVerifySeverity?: string; careSeverities?: string[]; reason?: string },
): Promise<{ dispatched: false; reason: string; bounced: true; problems: FindingStatusProblem[] }> {
  const problemsJson = problems.slice(0, 50).map((p) => ({
    finding_id: p.finding_id,
    title: p.title,
    severity: p.severity,
    verify_status: p.verify_status,
    issue: p.issue,
    in_care_scope: p.in_care_scope,
  }));
  await tx`
    UPDATE canvas_nodes SET
      status = 'running',
      body_json = body_json || ${tx.json({
        report_gate_rejected: {
          at: new Date().toISOString(),
          reason: extra?.reason ?? "care_findings_not_confirmed",
          minVerifySeverity: extra?.minVerifySeverity ?? null,
          careSeverities: extra?.careSeverities ?? [],
          problems: problemsJson,
        },
      })},
      updated_at = now()
    WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

  // 失败中的 report 元数据标 failed，避免卡在 generating
  await tx`
    UPDATE task_reports SET
      status = 'failed',
      error = ${`report_gate: ${problems.length} care finding(s) not confirmed`},
      updated_at = now()
    WHERE canvas_id = ${canvasId} AND status IN ('pending', 'generating')`;

  await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
    auto_stopped: false,
    paused_reason: undefined,
    paused_at: undefined,
  });

  const problemSummary = problems
    .slice(0, 12)
    .map((p) => `[${p.severity}] ${p.title || p.finding_id}: status=${p.verify_status} — ${p.issue}`)
    .join("\n");

  await maybeTriggerHub(
    tx,
    {
      id: null,
      project_id: projectId,
      canvas_id: canvasId,
      type: "report_gate",
      priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
    },
    {
      force: true,
      trigger: {
        kind: "report_gate_failed",
        minVerifySeverity: extra?.minVerifySeverity,
        careSeverities: extra?.careSeverities,
        problem_count: problems.length,
        problems: problemsJson,
        summary:
          `Report 被拒绝：自动验证范围内 Finding 须为 confirmed 或 needs_human。\n` +
          problemSummary,
      },
    },
  );

  console.warn(
    `[report] canvas ${canvasId} 门禁失败，回弹 Hub：${problems.length} 个问题 Finding`,
  );
  return {
    dispatched: false,
    reason: "report_gate_failed_bounced_hub",
    bounced: true,
    problems,
  };
}

/**
 * 在 Root 为 analysis_complete 且验证范围内 Finding ∈ {confirmed, needs_human} 时，幂等创建唯一 Report Job。
 * 低于阈值项单列为未自动验证；needs_human 进报告待人工章节，SARIF 仅 confirmed。
 *
 * 时序：Hub complete 同事务内当前 Hub 可能仍 running —— 此时只 **等待**，保持 analysis_complete，
 * **禁止** bounceReportGateToHub（否则 Root 被打回 running，空转烧 maxHubRounds）。
 * Hub finalize 后 finalizeJob 会再次调用本函数。
 */
export async function maybeDispatchReport(
  tx: Tx,
  canvasId: string,
  opts?: { excludeJobId?: string | null },
): Promise<{
  dispatched: boolean;
  reason?: string;
  bounced?: boolean;
  problems?: FindingStatusProblem[];
}> {
  // 报告入口统一锁顺序为 canvas -> task_reports -> jobs。所有重试/派发入口
  // 都必须遵守，避免并发 finalize/retry 死锁或竞争 ingress key。
  const [canvas] = await tx`
    SELECT id, project_id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
  if (!canvas) return { dispatched: false, reason: "no_canvas" };
  const [root] = await tx`
    SELECT id, status FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (!root) return { dispatched: false, reason: "no_root" };
  if (!["analysis_complete", "reporting", "succeeded"].includes(String(root.status))) {
    return { dispatched: false, reason: `root_status:${root.status}` };
  }

  const projectId = canvas.project_id as string;

  // 统一完成门：Finding 收敛 + 角色工作 + 无活跃 Job（可排除当前 Hub）
  const careMeta = await careSeverityMeta(tx, projectId);
  const gate = await evaluateAnalysisCompleteGate(tx, canvasId, {
    excludeJobId: opts?.excludeJobId ?? null,
  });
  if (!gate.ok) {
    // active_work：保持 analysis_complete，等当前 Job 终态后再派（不 bounce）
    if (gate.blockers.includes("active_work")) {
      return { dispatched: false, reason: "active_work", problems: gate.problems };
    }
    // 空图：不回弹空转
    if (gate.blockers.includes("no_role_work")) {
      return { dispatched: false, reason: "no_role_work", problems: gate.problems };
    }
    // Finding 真正未收敛：回弹 Hub
    return bounceReportGateToHub(tx, canvasId, projectId, gate.problems, {
      minVerifySeverity: careMeta.minVerifySeverity,
      careSeverities: careMeta.careSeverities,
      reason: "findings_not_converged",
    });
  }

  const [existing] = await tx`
    SELECT id, version, status, report_job_id, input_uri, input_sha256
    FROM task_reports
    WHERE canvas_id = ${canvasId}
    ORDER BY version DESC
    LIMIT 1
    FOR UPDATE`;
  if (existing?.status === "generating" || existing?.status === "pending") {
    if (existing.report_job_id) {
      const [j] = await tx`SELECT status FROM jobs WHERE id = ${existing.report_job_id as string}`;
      if (j && ["pending", "claimed", "provisioning", "running"].includes(j.status as string)) {
        return { dispatched: false, reason: "report_in_flight" };
      }
    }
  }

  // 先冻结并摘要本轮确定性输入。成功版本只在输入摘要未变化时幂等返回；
  // Finding、验证结论或范围变化后追加新版本，绝不覆盖历史产物。
  const reportInput = await buildReportInput(canvasId, tx as unknown as typeof sql);
  const inputBytes = JSON.stringify(reportInput, null, 2);
  const inputSha = sha256(inputBytes);
  const versionPlan = planTaskReportVersion(
    existing
      ? { version: Number(existing.version), status: String(existing.status), input_sha256: String(existing.input_sha256) }
      : null,
    inputSha,
  );
  if (versionPlan.alreadySucceeded) {
    return { dispatched: false, reason: "already_succeeded" };
  }
  const { reuseVersion, version } = versionPlan;
  if (existing && ["pending", "generating"].includes(String(existing.status)) && !reuseVersion) {
    await tx`
      UPDATE task_reports SET status = 'failed',
        error = COALESCE(error, '关联报告 Job 已结束但报告未收口'), updated_at = now()
      WHERE id = ${existing.id as string}`;
  }

  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  let resolvedSnapshot: Awaited<ReturnType<typeof resolveAgentSnapshotForJob>>;
  try {
    resolvedSnapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "report");
  } catch (e) {
    console.warn(`[report] resolve snapshot failed:`, e);
    return { dispatched: false, reason: "no_report_role" };
  }
  const snapshot = await freezeAgentSnapshotNetworkPolicy(
    tx as unknown as typeof sql,
    canvasId,
    resolvedSnapshot,
  );
  try {
    await assertFrozenRuntimeImageLocal(snapshot, { roleName: "report" });
  } catch (error) {
    if (error instanceof RuntimeImageNotLocalError) {
      return { dispatched: false, reason: "runtime_image_not_local" };
    }
    throw error;
  }

  // 显式创建可运行 Report Job：持有 ingress 的旧终态 Job 先 retire，再 INSERT（不用 ON CONFLICT DO NOTHING 绑回 failed Job）
  const ingressKey = `report:${canvasId}`;
  const [held] = await tx`
    SELECT id, status FROM jobs
    WHERE project_id = ${projectId} AND ingress_key = ${ingressKey}
    LIMIT 1`;
  if (held) {
    if (["pending", "claimed", "provisioning", "running"].includes(held.status as string)) {
      return { dispatched: false, reason: "report_job_exists" };
    }
    // failed/timeout/cancelled/orphan/succeeded 残留键：释放后重建
    await tx`
      UPDATE jobs SET ingress_key = ${`${ingressKey}:retired:${held.id}`}
      WHERE id = ${held.id as string}`;
  }

  // 派发前冻结版本化输入，供 Report Agent 与终态收口共同消费。
  const dir = reportDir(canvasId, version);
  await mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, "report-input.json");
  await writeFile(inputPath, inputBytes, "utf8");
  const inputUri = path.posix.join("reports", canvasId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown", `v${version}`, "report-input.json");

  const [job] = await tx`
    INSERT INTO jobs ${tx({
      project_id: projectId,
      canvas_id: canvasId,
      agent_snapshot_json: snapshot as never,
      type: "report",
      priority: fixedPriorityForJob({ type: "report", purpose: "report" }),
      ingress_key: ingressKey,
      payload_json: {
        scheduling_purpose: "report",
        kind: "task_report",
        report_version: version,
        report_input_uri: inputUri,
        report_input_sha256: inputSha,
        findings_total: reportInput.statistics.findings_total,
        confirmed_count: reportInput.statistics.confirmed_count,
        needs_human_count: reportInput.statistics.needs_human_count,
        excluded_count: reportInput.statistics.excluded_count,
      } as never,
      timeout_sec: rules.auditTimeoutSec,
      followup_depth: 0,
    })}
    RETURNING id`;
  await recordJobSharedAssets(tx as unknown as typeof sql, job.id as string, (snapshot as { shared_assets?: Parameters<typeof recordJobSharedAssets>[2] }).shared_assets ?? []);
  const reportJobId = job?.id as string | undefined;
  if (!reportJobId) return { dispatched: false, reason: "insert_failed" };

  if (reuseVersion) {
    await tx`
      UPDATE task_reports SET
        status = 'generating',
        report_job_id = ${reportJobId},
        input_uri = ${inputUri},
        input_sha256 = ${inputSha},
        error = null,
        updated_at = now()
      WHERE id = ${existing.id as string}`;
  } else {
    await tx`
      INSERT INTO task_reports ${tx({
        canvas_id: canvasId,
        project_id: projectId,
        version,
        report_job_id: reportJobId,
        status: "generating",
        input_uri: inputUri,
        input_sha256: inputSha,
      })}`;
  }

  await tx`
    UPDATE canvas_nodes SET status = 'reporting', updated_at = now()
    WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

  // 报告节点
  const existingNode = await tx`
    SELECT id FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'report' LIMIT 1`;
  if (existingNode.length === 0) {
    await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: reportJobId,
        node_type: "report",
        title: "任务报告",
        body_json: { type: "report", version } as never,
        x: 60,
        y: 520,
        status: "pending",
      })}`;
  } else {
    await tx`
      UPDATE canvas_nodes SET job_id = ${reportJobId}, status = 'pending',
        body_json = body_json || ${tx.json({ version })}, updated_at = now()
      WHERE id = ${existingNode[0].id as string}`;
  }

  console.info(`[report] canvas ${canvasId} 派发任务报告 v${version} Job ${reportJobId}`);
  return { dispatched: true };
}

async function finalizeFindingReportJob(
  tx: Tx,
  job: Record<string, unknown>,
  opts: { summary?: string | null; markdown?: string | null; error?: string | null; failed?: boolean },
): Promise<void> {
  const jobId = String(job.id);
  const [report] = await tx`
    SELECT * FROM finding_reports WHERE report_job_id = ${jobId} FOR UPDATE`;
  if (!report) return;
  if (opts.failed) {
    await tx`
      UPDATE finding_reports SET status = 'failed', error = ${opts.error ?? "report_failed"}, updated_at = now()
      WHERE id = ${report.id as string}`;
    return;
  }

  try {
    const inputBytes = await readReportBlob(String(report.input_uri));
    const input = JSON.parse(inputBytes.toString("utf8")) as FindingReportInput;
    if (input.scope !== "finding" || input.finding.id !== report.finding_id || input.report_version !== report.version) {
      throw new Error(`finding report ${report.id as string} input identity mismatch`);
    }
    if (sha256(inputBytes) !== report.input_sha256) {
      throw new Error(`finding report ${report.id as string} input checksum mismatch`);
    }

    const resolved = finalizeFindingReportMarkdown(
      input,
      opts.markdown?.trim() || opts.summary?.trim() || "",
    );
    const markdown = resolved.markdown;
    const numeric = resolved.numeric;
    if (resolved.usedDefault === "coverage") {
      console.warn(`[report] finding job markdown 覆盖不足或过短，回退确定性模板`);
    } else if (resolved.usedDefault === "numeric") {
      console.warn(`[report] finding job numeric 口径未逐字保留，回退确定性模板`);
    }
    if (!numeric.ok) {
      await tx`
        UPDATE finding_reports SET status = 'failed', error = ${numericInconsistentError(numeric)}, updated_at = now()
        WHERE id = ${report.id as string}`;
      return;
    }
    const dir = findingReportDir(input.finding.id, input.report_version);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "report.md"), markdown, "utf8");
    const markdownUri = path.posix.join("finding-reports", input.finding.id, `v${input.report_version}`, "report.md");
    const summary = {
      finding_id: input.finding.id,
      fingerprint: input.finding.fingerprint,
      severity: input.finding.severity,
      profile: input.finding.profile,
      category: input.finding.category,
      scoring: input.finding.scoring,
      verification_attempts: input.verification_rounds.length,
      report_version: input.report_version,
      frozen_at: input.frozen_at,
      generated_at: new Date().toISOString(),
    };
    await tx`
      UPDATE finding_reports SET
        status = 'succeeded', summary_json = ${tx.json(summary as never)},
        markdown_uri = ${markdownUri}, markdown_sha256 = ${sha256(markdown)},
        error = null, updated_at = now()
      WHERE id = ${report.id as string}`;
  } catch (error) {
    await tx`
      UPDATE finding_reports SET status = 'failed', error = ${error instanceof Error ? error.message : String(error)}, updated_at = now()
      WHERE id = ${report.id as string}`;
  }
}

/**
 * Report Job 成功：写产物、校验、Root → succeeded。
 * fake/real 均可调用；markdown 可来自 Agent summary 或确定性模板。
 */
export async function finalizeReportJob(
  tx: Tx,
  jobId: string,
  opts: { summary?: string | null; markdown?: string | null; error?: string | null; failed?: boolean } = {},
): Promise<void> {
  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job || job.type !== "report" || !job.canvas_id) return;
  const canvasId = job.canvas_id as string;
  // Recovery/Reaper 会绕过 finalizeJob 直接调用本函数，因此锁顺序必须与
  // 标准派发/重试入口一致：canvas -> task_reports -> jobs/nodes。
  const [canvas] = await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
  if (!canvas) return;

  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  if (payload.kind === "finding_report") {
    await finalizeFindingReportJob(tx, job as Record<string, unknown>, opts);
    return;
  }

  if (opts.failed) {
    await tx`
      UPDATE task_reports SET status = 'failed', error = ${opts.error ?? "report_failed"}, updated_at = now()
      WHERE report_job_id = ${jobId}`;
    await tx`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = 'report'`;
    // Root 保持 reporting
    return;
  }

  const [report] = await tx`
    SELECT id, version, input_uri, input_sha256
    FROM task_reports
    WHERE canvas_id = ${canvasId} AND report_job_id = ${jobId}
    FOR UPDATE`;
  if (!report) throw new Error(`task report not found for job ${jobId}`);
  const inputBytes = await readReportBlob(String(report.input_uri));
  if (sha256(inputBytes) !== report.input_sha256) {
    throw new Error(`task report input digest mismatch: ${report.id}`);
  }
  const input = JSON.parse(inputBytes.toString("utf8")) as ReportInput;
  const version = Number(report.version);
  const dir = reportDir(canvasId, version);
  await mkdir(dir, { recursive: true });

  const reportJson = {
    ...input,
    agent_summary: opts.summary ?? null,
    generated_at: new Date().toISOString(),
  };
  // Agent summary 作 Markdown；覆盖不全、过短或口径被改写时回退确定性模板。
  const resolved = finalizeTaskReportMarkdown(
    input,
    opts.markdown?.trim() || opts.summary?.trim() || "",
  );
  const markdown = resolved.markdown;
  if (resolved.usedDefault === "coverage") {
    console.warn(
      `[report] job ${jobId} markdown 覆盖不足或过短，回退确定性模板 (coverageOk=${resolved.coverageOk})`,
    );
  } else if (resolved.usedDefault === "numeric") {
    console.warn(`[report] job ${jobId} numeric 口径未逐字保留，回退确定性模板`);
  }

  const sarif = buildSarifFromConfirmed(input);
  const sarifStr = JSON.stringify(sarif, null, 2);
  const numeric = resolved.numeric;
  if (!numeric.ok) {
    const error = numericInconsistentError(numeric);
    await tx`
      UPDATE task_reports SET status = 'failed', error = ${error}, updated_at = now()
      WHERE report_job_id = ${jobId}`;
    await tx`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = 'report'`;
    console.warn(`[report] job ${jobId} ${error}`);
    return;
  }
  const reportJsonStr = JSON.stringify(reportJson, null, 2);

  const reportJsonPath = path.join(dir, "report.json");
  const mdPath = path.join(dir, "report.md");
  const sarifPath = path.join(dir, "report.sarif.json");
  await writeFile(reportJsonPath, reportJsonStr, "utf8");
  await writeFile(mdPath, markdown, "utf8");
  await writeFile(sarifPath, sarifStr, "utf8");

  const mdSha = sha256(markdown);
  const sarifSha = sha256(sarifStr);
  // 相对 blob 根的 URI
  const safeCanvasId = canvasId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
  const mdUri = path.posix.join("reports", safeCanvasId, `v${version}`, "report.md");
  const sarifUri = path.posix.join("reports", safeCanvasId, `v${version}`, "report.sarif.json");

  const summaryJson = {
    confirmed_count: input.statistics.confirmed_count,
    needs_human_count: input.statistics.needs_human_count,
    excluded_count: input.statistics.excluded_count,
    findings_total: input.statistics.findings_total,
    confirmed_by_severity: input.statistics.confirmed_by_severity,
    generated_at: new Date().toISOString(),
  };

  await tx`
    UPDATE task_reports SET
      status = 'succeeded',
      summary_json = ${tx.json(summaryJson as never)},
      markdown_uri = ${mdUri},
      markdown_sha256 = ${mdSha},
      sarif_uri = ${sarifUri},
      sarif_sha256 = ${sarifSha},
      error = null,
      updated_at = now()
    WHERE id = ${report.id as string}`;

  await tx`
    UPDATE canvas_nodes SET status = 'succeeded',
      body_json = body_json || ${tx.json({ summary: summaryJson, version })},
      updated_at = now()
    WHERE job_id = ${jobId} AND node_type = 'report'`;

  await tx`
    UPDATE canvas_nodes SET status = 'succeeded', updated_at = now()
    WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

  console.info(`[report] canvas ${canvasId} 任务报告 v${version} 成功，Root → succeeded`);
}

export async function readReportBlob(uri: string): Promise<Buffer> {
  const full = path.join(config.storage.blobDir, uri);
  return readFile(full);
}

export async function getTaskReport(canvasId: string) {
  const [row] = await sql`
    SELECT * FROM task_reports WHERE canvas_id = ${canvasId}
    ORDER BY version DESC LIMIT 1`;
  return row ?? null;
}

export async function listTaskReports(canvasId: string) {
  return sql`
    SELECT * FROM task_reports WHERE canvas_id = ${canvasId}
    ORDER BY version DESC`;
}

export type TaskReportAvailabilityReason =
  | "canvas_not_found"
  | "root_not_found"
  | "root_not_ready"
  | "active_work"
  | "no_role_work"
  | "findings_not_converged"
  | "report_not_dispatched";

export interface TaskReportBlockingFinding {
  finding_id: string;
  title: string;
  severity: string | null;
  verify_status: string;
  issue: string;
}

export interface TaskReportAvailability {
  reason: TaskReportAvailabilityReason;
  root_status: string | null;
  min_verify_severity: string | null;
  blockers: string[];
  blocking_findings: TaskReportBlockingFinding[];
}

/** 将完成门结果转换成报告面板可直接展示的服务端状态。 */
export function classifyTaskReportAvailability(input: {
  canvasExists?: boolean;
  rootStatus: string | null;
  minVerifySeverity: string | null;
  blockers: string[];
  problems: FindingStatusProblem[];
}): TaskReportAvailability {
  let reason: TaskReportAvailabilityReason = "report_not_dispatched";
  if (input.canvasExists === false) reason = "canvas_not_found";
  else if (input.rootStatus === null) reason = "root_not_found";
  else if (![
    "analysis_complete",
    "reporting",
    "succeeded",
  ].includes(input.rootStatus)) reason = "root_not_ready";
  else if (input.blockers.includes("active_work")) reason = "active_work";
  else if (input.blockers.includes("no_role_work")) reason = "no_role_work";
  else if (input.blockers.length > 0) reason = "findings_not_converged";

  const seen = new Set<string>();
  const blockingFindings = input.problems
    .filter((problem) => problem.finding_id && problem.in_care_scope)
    .filter((problem) => {
      if (seen.has(problem.finding_id)) return false;
      seen.add(problem.finding_id);
      return true;
    })
    .slice(0, 20)
    .map((problem) => ({
      finding_id: problem.finding_id,
      title: problem.title,
      severity: problem.severity || null,
      verify_status: problem.verify_status,
      issue: problem.issue,
    }));

  return {
    reason,
    root_status: input.rootStatus,
    min_verify_severity: input.minVerifySeverity,
    blockers: input.blockers.slice(0, 20),
    blocking_findings: blockingFindings,
  };
}

/** 查询不存在任务报告时的权威阻塞原因；不修改任何报告或画布状态。 */
export async function getTaskReportAvailability(canvasId: string): Promise<TaskReportAvailability> {
  const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${canvasId}`;
  if (!canvas) {
    return classifyTaskReportAvailability({
      canvasExists: false,
      rootStatus: null,
      minVerifySeverity: null,
      blockers: [],
      problems: [],
    });
  }

  const [root] = await sql`
    SELECT status FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (!root) {
    return classifyTaskReportAvailability({
      rootStatus: null,
      minVerifySeverity: null,
      blockers: [],
      problems: [],
    });
  }

  const meta = await careSeverityMeta(sql, canvas.project_id as string);
  const gate = await evaluateAnalysisCompleteGate(sql, canvasId);
  return classifyTaskReportAvailability({
    rootStatus: String(root.status),
    minVerifySeverity: meta.minVerifySeverity,
    blockers: gate.blockers,
    problems: gate.problems,
  });
}

export async function getTaskReportById(id: string) {
  const [row] = await sql`SELECT * FROM task_reports WHERE id = ${id}`;
  return row ?? null;
}

export async function getFindingReport(findingId: string) {
  const [row] = await sql`
    SELECT * FROM finding_reports WHERE finding_id = ${findingId} ORDER BY version DESC LIMIT 1`;
  return row ?? null;
}

export async function getFindingReportById(id: string) {
  const [row] = await sql`SELECT * FROM finding_reports WHERE id = ${id}`;
  return row ?? null;
}

export async function createFindingReport(
  findingId: string,
  force = true,
): Promise<FindingReportDispatchResult> {
  return sql.begin(async (txRaw) =>
    maybeDispatchFindingReport(txRaw as unknown as Tx, findingId, { force })
  );
}

/**
 * 显式重试失败报告。
 * - 已 succeeded：幂等拒绝，**绝不**降级 Root
 * - 仅 failed（或 generating 但 Job 已死）可重试：retire 旧 ingress 后由 maybeDispatchReport 新建 Job
 */
export async function retryReport(canvasId: string): Promise<{ ok: boolean; reason?: string }> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    // 与 maybeDispatchReport 保持 canvas -> task_reports 锁顺序。
    const [canvas] = await tx`
      SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
    if (!canvas) return { ok: false, reason: "no_canvas" };
    const [report] = await tx`
      SELECT id, status, report_job_id FROM task_reports
      WHERE canvas_id = ${canvasId}
      ORDER BY version DESC LIMIT 1 FOR UPDATE`;
    if (!report) return { ok: false, reason: "no_report" };
    if (report.status === "succeeded") return { ok: false, reason: "already_succeeded" };

    const [root] = await tx`
      SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
    if (!root) return { ok: false, reason: "no_root" };
    // 成功任务禁止因 retry 降级
    if (root.status === "succeeded") {
      return { ok: false, reason: "root_already_succeeded" };
    }
    if (!["analysis_complete", "reporting"].includes(root.status as string)) {
      return { ok: false, reason: `root_status:${root.status}` };
    }

    // 仅 failed，或 generating 但绑定 Job 已终态失败，才允许重试
    if (report.status === "generating" || report.status === "pending") {
      if (report.report_job_id) {
        const [j] = await tx`SELECT status FROM jobs WHERE id = ${report.report_job_id as string}`;
        if (j && ["pending", "claimed", "provisioning", "running"].includes(j.status as string)) {
          return { ok: false, reason: "report_in_flight" };
        }
      }
    } else if (report.status !== "failed") {
      return { ok: false, reason: `report_status:${report.status}` };
    }

    // 释放旧 report job 的 ingress，确保后续 INSERT 能建新 pending Job
    const ingressKey = `report:${canvasId}`;
    const [held] = await tx`
      SELECT id, status FROM jobs
      WHERE ingress_key = ${ingressKey}
      LIMIT 1`;
    if (held && !["pending", "claimed", "provisioning", "running"].includes(held.status as string)) {
      await tx`
        UPDATE jobs SET ingress_key = ${`${ingressKey}:retired:${held.id}`}
        WHERE id = ${held.id as string}`;
    }

    await tx`
      UPDATE task_reports SET status = 'pending', error = null, updated_at = now()
      WHERE id = ${report.id as string}`;

    // Root 保持 analysis_complete，便于 maybeDispatchReport 入队
    if (root.status === "reporting") {
      await tx`
        UPDATE canvas_nodes SET status = 'analysis_complete', updated_at = now()
        WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
    }

    const r = await maybeDispatchReport(tx, canvasId);
    return { ok: r.dispatched, reason: r.reason };
  });
}

/** 检查当前收敛输入；仅在摘要变化时追加任务报告版本。 */
export async function refreshTaskReport(canvasId: string): Promise<{ ok: boolean; report_id?: string; reason?: string }> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const result = await maybeDispatchReport(tx, canvasId);
    if (!result.dispatched) return { ok: result.reason === "already_succeeded", reason: result.reason };
    const [latest] = await tx`
      SELECT id FROM task_reports WHERE canvas_id = ${canvasId}
      ORDER BY version DESC LIMIT 1`;
    return { ok: true, report_id: latest?.id as string | undefined };
  });
}
