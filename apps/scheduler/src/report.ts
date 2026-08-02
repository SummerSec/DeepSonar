/**
 * 任务级最终报告：收敛后幂等派发 Report Job，确定性输入 + 产物校验 + SARIF。
 * 见 docs/TODO_VERIFY_CONFIRMED_ONLY_AND_HUB_BOUNCE.md §5
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sql } from "./db.js";
import { canvasFindingsConverged, type FindingStatusProblem } from "./verify.js";

type Tx = typeof sql;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function reportDir(canvasId: string): string {
  const safe = canvasId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return path.join(config.storage.blobDir, "reports", safe || "unknown");
}

export interface ReportInputFinding {
  id: string;
  title: string;
  severity: string;
  location: string | null;
  summary: string | null;
  verify_status: string;
  final_verification_round: Record<string, unknown> | null;
  review_evidence: unknown[];
  test_evidence: unknown[];
  limitations: string[];
}

export interface ReportInput {
  task: { canvas_id: string; title: string; goal: string; project_id: string };
  statistics: {
    findings_total: number;
    confirmed_count: number;
    needs_human_count: number;
    confirmed_by_severity: Record<string, number>;
  };
  findings: ReportInputFinding[];
  confirmed_findings: ReportInputFinding[];
  needs_human_findings: ReportInputFinding[];
  scope_and_coverage: Record<string, unknown>;
  evidence: unknown[];
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
  const findings = await db`
    SELECT f.id, f.title, f.severity, f.location, f.summary, f.verify_status, f.raw_json, f.job_id, f.node_id
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
    items.push({
      id: f.id as string,
      title: f.title as string,
      severity: f.severity as string,
      location: (f.location as string) ?? null,
      summary: (f.summary as string) ?? null,
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
    });
  }

  const confirmed = items.filter((i) => i.verify_status === "confirmed");
  const needsHuman = items.filter((i) => i.verify_status === "needs_human");
  const bySev: Record<string, number> = {};
  for (const c of confirmed) {
    bySev[c.severity] = (bySev[c.severity] ?? 0) + 1;
  }

  return {
    task: {
      canvas_id: canvasId,
      title: canvas.title as string,
      goal: String(target.goal ?? canvas.title ?? ""),
      project_id: canvas.project_id as string,
    },
    statistics: {
      findings_total: items.length,
      confirmed_count: confirmed.length,
      needs_human_count: needsHuman.length,
      confirmed_by_severity: bySev,
    },
    findings: items,
    confirmed_findings: confirmed,
    needs_human_findings: needsHuman,
    scope_and_coverage: {
      goal: String(target.goal ?? ""),
      network_policy: target.network_policy ?? null,
    },
    evidence: [],
  };
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
      verify_status: "confirmed",
      title: f.title,
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
                level: f.severity === "critical" || f.severity === "high" ? "error" : "warning",
              },
              properties: { severity: f.severity },
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
  lines.push("");
  lines.push("## 执行摘要");
  lines.push("");
  lines.push(
    `本次共发现 **${input.statistics.findings_total}** 条 Finding：已确认 **${input.statistics.confirmed_count}**，待人工 **${input.statistics.needs_human_count}**。`,
  );
  if (input.statistics.confirmed_count === 0) {
    lines.push("");
    lines.push("**本次未形成已确认漏洞**；这不代表系统绝对安全，仅表示自动验证未通过确认门槛。");
  }
  lines.push("");
  lines.push("## 已确认问题");
  lines.push("");
  if (input.confirmed_findings.length === 0) {
    lines.push("_无_");
  } else {
    for (const f of input.confirmed_findings) {
      lines.push(`### [${f.severity}] ${f.title}`);
      lines.push("");
      if (f.location) lines.push(`- 位置：\`${f.location}\``);
      if (f.summary) lines.push(`- 摘要：${f.summary}`);
      lines.push(`- 验证轮次：${f.final_verification_round?.attempt ?? "?"}`);
      lines.push("");
    }
  }
  lines.push("## 待人工确认 / 验证限制");
  lines.push("");
  if (input.needs_human_findings.length === 0) {
    lines.push("_无_");
  } else {
    for (const f of input.needs_human_findings) {
      lines.push(`### [${f.severity}] ${f.title}`);
      lines.push("");
      if (f.location) lines.push(`- 位置：\`${f.location}\``);
      if (f.summary) lines.push(`- 摘要：${f.summary}`);
      const err = f.final_verification_round?.error ?? f.final_verification_round?.summary;
      if (err) lines.push(`- 阻塞：${err}`);
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

  const { maybeTriggerHub, patchCanvasConvergence } = await import("./core.js");
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
      priority: 40,
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
          `Report 被拒绝：全部 Finding 须为 confirmed 或 needs_human（severity 不影响收敛集合）。\n` +
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
 * 在 Root 为 analysis_complete 且全部 Finding ∈ {confirmed, needs_human} 时，幂等创建唯一 Report Job。
 * severity 只影响优先级，不改变收敛集合；needs_human 进报告待人工章节，SARIF 仅 confirmed。
 * 未收敛则回弹 Hub 并列出问题 Finding。
 */
export async function maybeDispatchReport(tx: Tx, canvasId: string): Promise<{
  dispatched: boolean;
  reason?: string;
  bounced?: boolean;
  problems?: FindingStatusProblem[];
}> {
  const [root] = await tx`
    SELECT id, status FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (!root) return { dispatched: false, reason: "no_root" };
  if (root.status !== "analysis_complete" && root.status !== "reporting") {
    return { dispatched: false, reason: `root_status:${root.status}` };
  }

  const [canvas] = await tx`SELECT project_id FROM canvases WHERE id = ${canvasId}`;
  if (!canvas) return { dispatched: false, reason: "no_canvas" };
  const projectId = canvas.project_id as string;

  // 统一完成门子集：Finding 收敛 + 至少一次角色工作（与 Hub complete 一致，防空图报告）
  const { careSeverityMeta, evaluateAnalysisCompleteGate } = await import("./verify.js");
  const careMeta = await careSeverityMeta(tx, projectId);
  const gate = await evaluateAnalysisCompleteGate(tx, canvasId);
  if (!gate.ok) {
    // 仅 Finding 未收敛时回弹 Hub；no_role_work 不应回弹空转，直接拒绝
    if (gate.blockers.includes("no_role_work")) {
      return { dispatched: false, reason: "no_role_work", problems: gate.problems };
    }
    return bounceReportGateToHub(tx, canvasId, projectId, gate.problems, {
      minVerifySeverity: careMeta.minVerifySeverity,
      careSeverities: careMeta.careSeverities,
      reason: "analysis_complete_gate_failed",
    });
  }

  // 活跃普通/Hub/Verify 工作（允许 report 自身）
  const active = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND type <> 'report'
      AND status IN ('pending','claimed','provisioning','running','waiting_human')
    LIMIT 1`;
  if (active.length > 0) return { dispatched: false, reason: "active_work" };

  const [existing] = await tx`
    SELECT id, status, report_job_id FROM task_reports WHERE canvas_id = ${canvasId}`;
  if (existing?.status === "succeeded") return { dispatched: false, reason: "already_succeeded" };
  if (existing?.status === "generating" || existing?.status === "pending") {
    if (existing.report_job_id) {
      const [j] = await tx`SELECT status FROM jobs WHERE id = ${existing.report_job_id as string}`;
      if (j && ["pending", "claimed", "provisioning", "running"].includes(j.status as string)) {
        return { dispatched: false, reason: "report_in_flight" };
      }
    }
  }

  const { resolveAgentSnapshotForJob, rulesForProject } = await import("./core.js");
  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  let snapshot: unknown;
  try {
    snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "report");
  } catch (e) {
    console.warn(`[report] resolve snapshot failed:`, e);
    return { dispatched: false, reason: "no_report_role" };
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

  // 派发前冻结确定性输入，供 Report Agent 消费
  const reportInput = await buildReportInput(canvasId, tx as unknown as typeof sql);
  const dir = reportDir(canvasId);
  await mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, "report-input.json");
  await writeFile(inputPath, JSON.stringify(reportInput, null, 2), "utf8");
  const inputUri = path.posix.join("reports", path.basename(dir), "report-input.json");

  const [job] = await tx`
    INSERT INTO jobs ${tx({
      project_id: projectId,
      canvas_id: canvasId,
      agent_snapshot_json: snapshot as never,
      type: "report",
      priority: 50,
      ingress_key: ingressKey,
      payload_json: {
        kind: "task_report",
        report_input_uri: inputUri,
        findings_total: reportInput.statistics.findings_total,
        confirmed_count: reportInput.statistics.confirmed_count,
        needs_human_count: reportInput.statistics.needs_human_count,
      } as never,
      timeout_sec: rules.auditTimeoutSec,
      followup_depth: 0,
    })}
    RETURNING id`;
  const reportJobId = job?.id as string | undefined;
  if (!reportJobId) return { dispatched: false, reason: "insert_failed" };

  if (existing) {
    await tx`
      UPDATE task_reports SET
        status = 'generating',
        report_job_id = ${reportJobId},
        error = null,
        updated_at = now()
      WHERE canvas_id = ${canvasId}`;
  } else {
    try {
      await tx`
        INSERT INTO task_reports ${tx({
          canvas_id: canvasId,
          project_id: projectId,
          report_job_id: reportJobId,
          status: "generating",
        })}`;
    } catch {
      await tx`
        UPDATE task_reports SET
          status = 'generating',
          report_job_id = ${reportJobId},
          error = null,
          updated_at = now()
        WHERE canvas_id = ${canvasId}`;
    }
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
        body_json: { type: "report" } as never,
        x: 60,
        y: 520,
        status: "pending",
      })}`;
  } else {
    await tx`
      UPDATE canvas_nodes SET job_id = ${reportJobId}, status = 'pending', updated_at = now()
      WHERE id = ${existingNode[0].id as string}`;
  }

  console.info(`[report] canvas ${canvasId} 派发 Report Job ${reportJobId}`);
  return { dispatched: true };
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

  if (opts.failed) {
    await tx`
      UPDATE task_reports SET status = 'failed', error = ${opts.error ?? "report_failed"}, updated_at = now()
      WHERE canvas_id = ${canvasId}`;
    await tx`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = 'report'`;
    // Root 保持 reporting
    return;
  }

  const input = await buildReportInput(canvasId, tx as unknown as typeof sql);
  const dir = reportDir(canvasId);
  await mkdir(dir, { recursive: true });

  const reportJson = {
    ...input,
    agent_summary: opts.summary ?? null,
    generated_at: new Date().toISOString(),
  };
  // Agent summary 作 Markdown；覆盖不全或过短时回退确定性模板（不因文笔失败而丢报告）
  let markdown = (opts.markdown?.trim() || opts.summary?.trim() || "").trim();
  const coverageOk =
    input.findings.length === 0 ||
    input.findings.every(
      (f) =>
        markdown.includes(f.id) ||
        markdown.includes(f.title) ||
        (f.verify_status === "confirmed" && markdown.includes("已确认")) ||
        (f.verify_status === "needs_human" && (markdown.includes("人工") || markdown.includes("待"))),
    );
  if (markdown.length < 20 || !coverageOk) {
    console.warn(
      `[report] job ${jobId} markdown 覆盖不足或过短，回退确定性模板 (len=${markdown.length}, coverageOk=${coverageOk})`,
    );
    markdown = defaultMarkdown(input);
  }

  const sarif = buildSarifFromConfirmed(input);
  const reportJsonStr = JSON.stringify(reportJson, null, 2);
  const sarifStr = JSON.stringify(sarif, null, 2);

  const reportJsonPath = path.join(dir, "report.json");
  const mdPath = path.join(dir, "report.md");
  const sarifPath = path.join(dir, "report.sarif.json");
  await writeFile(reportJsonPath, reportJsonStr, "utf8");
  await writeFile(mdPath, markdown, "utf8");
  await writeFile(sarifPath, sarifStr, "utf8");

  const mdSha = sha256(markdown);
  const sarifSha = sha256(sarifStr);
  // 相对 blob 根的 URI
  const mdUri = path.posix.join("reports", path.basename(dir), "report.md");
  const sarifUri = path.posix.join("reports", path.basename(dir), "report.sarif.json");

  const summaryJson = {
    confirmed_count: input.statistics.confirmed_count,
    needs_human_count: input.statistics.needs_human_count,
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
    WHERE canvas_id = ${canvasId}`;

  await tx`
    UPDATE canvas_nodes SET status = 'succeeded',
      body_json = body_json || ${tx.json({ summary: summaryJson })},
      updated_at = now()
    WHERE job_id = ${jobId} AND node_type = 'report'`;

  await tx`
    UPDATE canvas_nodes SET status = 'succeeded', updated_at = now()
    WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

  console.info(`[report] canvas ${canvasId} 报告成功，Root → succeeded`);
}

export async function readReportBlob(uri: string): Promise<Buffer> {
  const full = path.join(config.storage.blobDir, uri);
  return readFile(full);
}

export async function getTaskReport(canvasId: string) {
  const [row] = await sql`SELECT * FROM task_reports WHERE canvas_id = ${canvasId}`;
  return row ?? null;
}

export async function getTaskReportById(id: string) {
  const [row] = await sql`SELECT * FROM task_reports WHERE id = ${id}`;
  return row ?? null;
}

/**
 * 显式重试失败报告。
 * - 已 succeeded：幂等拒绝，**绝不**降级 Root
 * - 仅 failed（或 generating 但 Job 已死）可重试：retire 旧 ingress 后由 maybeDispatchReport 新建 Job
 */
export async function retryReport(canvasId: string): Promise<{ ok: boolean; reason?: string }> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [report] = await tx`
      SELECT id, status, report_job_id FROM task_reports WHERE canvas_id = ${canvasId} FOR UPDATE`;
    if (!report) return { ok: false, reason: "no_report" };
    if (report.status === "succeeded") {
      return { ok: false, reason: "already_succeeded" };
    }

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
      WHERE canvas_id = ${canvasId}`;

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


