/**
 * Finding 多轮 Verify：自动派生、证据硬门、统一收口、Hub 回弹与再验。
 * 见 docs/TODO_VERIFY_CONFIRMED_ONLY_AND_HUB_BOUNCE.md
 *
 * 注意：通过动态 import("./core.js") 访问 core，避免与 core → verify 形成静态环。
 */
import { VerificationEvidence, type VerificationEvidence as VerificationEvidenceType } from "@deepsonar/shared-types";
import { sql } from "./db.js";

type Tx = typeof sql;

async function core() {
  return import("./core.js");
}

const ACTIVE_JOB = ["pending", "claimed", "provisioning", "running", "waiting_human"] as const;
const TERMINAL_JOB = ["succeeded", "failed", "timeout", "cancelled", "orphan"] as const;

export type ProposedVerdict = "confirmed" | "rework" | "needs_human";
export type RoundOutcome = "confirmed" | "rework" | "needs_human";

export function mapProposedVerdict(raw: string | undefined | null): ProposedVerdict {
  const v = String(raw ?? "").toLowerCase();
  if (v === "confirmed") return "confirmed";
  if (v === "needs_human") return "needs_human";
  // false_positive 兼容期统一映射为 rework
  return "rework";
}

export interface EvidenceSnapshot {
  review: Array<Record<string, unknown>>;
  test: Array<Record<string, unknown>>;
  missing: string[];
  conflicting_node_ids: string[];
  qualified: boolean;
  reason?: string;
}

const VALID_OUTCOMES = new Set(["supports", "refutes", "inconclusive"]);

/**
 * 收集绑定到 Finding 的合格 review/test 证据节点。
 * - 排除原始 Finding Job 与自证
 * - **仅计来源 Job status=succeeded**（失败/timeout 半成品不计）
 * - outcome 必须是 supports|refutes|inconclusive
 */
export async function collectEvidenceSnapshot(
  tx: Tx,
  findingId: string,
  originJobId: string | null,
): Promise<EvidenceSnapshot> {
  const nodes = await tx`
    SELECT n.id, n.job_id, n.body_json, n.title, j.type AS job_type, j.status AS job_status
    FROM canvas_nodes n
    JOIN jobs j ON j.id = n.job_id
    WHERE n.node_type = 'fact'
      AND n.body_json ? 'verification'
      AND n.body_json->'verification'->>'finding_id' = ${findingId}
      AND j.status = 'succeeded'`;

  const review: Array<Record<string, unknown>> = [];
  const test: Array<Record<string, unknown>> = [];
  const conflicting: string[] = [];

  for (const n of nodes) {
    const verRaw = ((n.body_json as Record<string, unknown>)?.verification ?? {}) as Record<string, unknown>;
    const kind = String(verRaw.evidence_kind ?? "");
    const outcome = String(verRaw.outcome ?? "");
    const jobId = (n.job_id as string | null) ?? null;
    // 同一 Job 自证 / 原始 Finding Job 产出不计
    if (!jobId || (originJobId && jobId === originJobId)) continue;
    // 非法 outcome 不计（不再用 !== inconclusive 放宽）
    if (!VALID_OUTCOMES.has(outcome)) continue;

    const base = {
      node_id: n.id as string,
      job_id: jobId,
      job_type: n.job_type as string | null,
      job_status: n.job_status as string,
      outcome,
      subject_revision: verRaw.subject_revision ?? null,
      steps: verRaw.steps ?? null,
      expected: verRaw.expected ?? null,
      actual: verRaw.actual ?? null,
      artifact_refs: verRaw.artifact_refs ?? null,
      limitations: verRaw.limitations ?? null,
      environment: verRaw.environment ?? null,
      title: n.title as string,
      description: ((n.body_json as Record<string, unknown>)?.description as string) ?? null,
    };

    if (kind === "review") {
      // review：仅 supports/refutes 计入确认门槛；inconclusive 忽略
      if (outcome === "inconclusive") continue;
      if (outcome === "refutes") conflicting.push(n.id as string);
      if (outcome === "supports" || outcome === "refutes") review.push(base);
    } else if (kind === "test") {
      const steps = Array.isArray(verRaw.steps) ? verRaw.steps : [];
      const hasRevision = typeof verRaw.subject_revision === "string" && verRaw.subject_revision.trim().length > 0;
      const hasActual =
        (typeof verRaw.actual === "string" && verRaw.actual.trim().length > 0) ||
        (Array.isArray(verRaw.artifact_refs) && verRaw.artifact_refs.length > 0);
      const hasSteps = steps.length > 0;
      const hasExpected = typeof verRaw.expected === "string" && verRaw.expected.trim().length > 0;
      // test 必须字段完整才计为合格（subject_revision 仅要求非空可审计，不强绑任务冻结 commit）
      if (!hasRevision || !hasSteps || !hasExpected || !hasActual) continue;
      if (outcome === "inconclusive") continue;
      if (outcome === "refutes") conflicting.push(n.id as string);
      if (outcome === "supports" || outcome === "refutes") test.push(base);
    }
  }

  // 独立：review 与 test 须来自不同 Job
  const reviewJobs = new Set(review.map((r) => r.job_id as string));
  const testJobs = new Set(test.map((t) => t.job_id as string));
  const independent =
    review.length > 0 &&
    test.length > 0 &&
    [...reviewJobs].some((rj) => ![...testJobs].includes(rj));

  const supportsTest = test.some((t) => t.outcome === "supports");
  const missing: string[] = [];
  if (review.length === 0) missing.push("independent_review");
  if (test.length === 0) missing.push("runtime_test");
  if (review.length > 0 && test.length > 0 && !independent) missing.push("independent_jobs");
  if (test.length > 0 && !supportsTest) missing.push("supporting_test");
  if (conflicting.length > 0) missing.push("unresolved_conflict");

  const qualified = missing.length === 0 && independent && supportsTest && conflicting.length === 0;
  return {
    review,
    test,
    missing,
    conflicting_node_ids: conflicting,
    qualified,
    reason: qualified ? undefined : `evidence_gate_failed:${missing.join(",")}`,
  };
}

/** 创建下一轮 verify_finding（幂等：已有活跃 verify 则跳过）。 */
export async function createVerifyRound(
  tx: Tx,
  opts: {
    projectId: string;
    canvasId: string | null;
    finding: Record<string, unknown>;
    parentJobId: string;
    followupDepth: number;
    priorityBase: number;
    reason?: string;
  },
): Promise<{ jobId: string; roundId: string; attempt: number } | null> {
  const findingId = opts.finding.id as string;
  const { rulesForProject, resolveAgentSnapshotForJob, severityPriorityDelta } = await core();
  const rules = await rulesForProject(tx as unknown as typeof sql, opts.projectId);

  if (opts.followupDepth >= rules.maxFollowupDepth) {
    await markFindingNeedsHuman(tx, findingId, "max_followup_depth", opts.canvasId);
    return null;
  }

  const [{ max_attempt }] = await tx<[{ max_attempt: number | null }]>`
    SELECT MAX(attempt) AS max_attempt FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
  const nextAttempt = (max_attempt ?? 0) + 1;
  if (nextAttempt > rules.maxVerificationRounds) {
    await markFindingNeedsHuman(tx, findingId, "max_verification_rounds", opts.canvasId);
    return null;
  }

  const active = await tx`
    SELECT id FROM jobs
    WHERE finding_id = ${findingId} AND type = 'verify_finding'
      AND status = ANY(${ACTIVE_JOB as unknown as string[]})
    LIMIT 1`;
  if (active.length > 0) return null;

  const openRound = await tx`
    SELECT id FROM finding_verification_rounds
    WHERE finding_id = ${findingId} AND status IN ('pending','running')
    LIMIT 1`;
  if (openRound.length > 0) return null;

  const severity = String(opts.finding.severity ?? "").toLowerCase();
  const snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, opts.projectId, "verify_finding");
  const priority = opts.priorityBase + 1 + severityPriorityDelta(severity);

  const evidence = await collectEvidenceSnapshot(tx, findingId, (opts.finding.job_id as string) ?? null);

  let verifyJob: { id: string };
  try {
    const [row] = await tx`
      INSERT INTO jobs ${tx({
        project_id: opts.projectId,
        canvas_id: opts.canvasId,
        agent_snapshot_json: snapshot as never,
        plane_issue_id: null,
        parent_job_id: opts.parentJobId,
        finding_id: findingId,
        type: "verify_finding",
        priority,
        payload_json: {
          finding: {
            fingerprint: opts.finding.fingerprint,
            title: opts.finding.title,
            location: opts.finding.location,
            summary: opts.finding.summary,
            severity,
          },
          verification_attempt: nextAttempt,
          reason: opts.reason ?? "auto",
        } as never,
        timeout_sec: rules.verifyTimeoutSec,
        followup_depth: opts.followupDepth,
      })}
      RETURNING id`;
    verifyJob = row as { id: string };
  } catch (e) {
    // 局部唯一索引：并发下另一活跃 verify 已存在
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("jobs_one_active_verify_per_finding")) return null;
    throw e;
  }

  const [round] = await tx`
    INSERT INTO finding_verification_rounds ${tx({
      finding_id: findingId,
      attempt: nextAttempt,
      verify_job_id: verifyJob.id,
      status: "pending",
      requirements_json: {
        need_review: true,
        need_test: true,
        missing: evidence.missing,
      } as never,
      evidence_snapshot_json: evidence as never,
    })}
    RETURNING id`;

  await tx`UPDATE findings SET verify_status = 'verifying', updated_at = now() WHERE id = ${findingId}`;

  // 画布：finding → verifies → verify job
  const [findingNode] = await tx`SELECT node_id FROM findings WHERE id = ${findingId}`;
  if (findingNode?.node_id) {
    const [source] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE id = ${findingNode.node_id}`;
    if (source) {
      const [verifyNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: source.canvas_id as string,
          job_id: verifyJob.id,
          node_type: "job",
          title: `验证#${nextAttempt}：${String(opts.finding.title).slice(0, 90)}`,
          body_json: {
            type: "verify_finding",
            finding_id: findingId,
            attempt: nextAttempt,
            round_id: round.id,
          } as never,
          x: (source.x as number) + 340,
          y: (source.y as number) + (nextAttempt - 1) * 40,
          status: "pending",
        })}
        RETURNING id`;
      await insertEdgeIfAbsent(
        tx,
        source.canvas_id as string,
        source.id as string,
        verifyNode.id as string,
        "verifies",
      );
      await tx`UPDATE canvas_nodes SET status = 'verifying', updated_at = now() WHERE id = ${source.id}`;
    }
  }

  return { jobId: verifyJob.id, roundId: round.id as string, attempt: nextAttempt };
}

/** Finding 创建后自动进入第 1 轮 Verify（severity 只影响 priority）。 */
export async function evaluateFollowup(
  tx: Tx,
  job: Record<string, unknown>,
  finding: Record<string, unknown>,
): Promise<void> {
  const { rulesForProject } = await core();
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  const canvasId = (job.canvas_id as string) ?? null;
  const findingId = finding.id as string;

  if ((job.followup_depth as number) >= rules.maxFollowupDepth) {
    await markFindingNeedsHuman(tx, findingId, "max_followup_depth", canvasId);
    return;
  }

  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${job.id as string}`;
  if (count >= rules.maxFollowupsPerJob) {
    console.warn(`[verify] job ${job.id} followup 超过上限 ${rules.maxFollowupsPerJob}`);
    await markFindingNeedsHuman(tx, findingId, "max_followups_per_job", canvasId);
    return;
  }

  await createVerifyRound(tx, {
    projectId: job.project_id as string,
    canvasId,
    finding,
    parentJobId: job.id as string,
    followupDepth: (job.followup_depth as number) + 1,
    priorityBase: (job.priority as number) ?? 0,
    reason: "finding_created",
  });
}

/**
 * 护栏耗尽（maxHubRounds 等）：把画布上仍 pending/verifying 的 Finding 统一收口为 needs_human，
 * 避免永久 pending 堵死 complete/report。
 */
export async function settleCanvasFindingsAtGuardrail(
  tx: Tx,
  canvasId: string,
  reason: string,
): Promise<{ settled: number }> {
  const rows = await tx`
    SELECT f.id, f.node_id, f.verify_status
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}
      AND f.verify_status IN ('pending', 'verifying', 'false_positive')`;
  for (const f of rows) {
    // 关闭未结束的 round
    await tx`
      UPDATE finding_verification_rounds SET
        status = 'needs_human',
        final_outcome = 'needs_human',
        error = ${reason},
        finished_at = COALESCE(finished_at, now())
      WHERE finding_id = ${f.id as string} AND status IN ('pending', 'running')`;
    await markFindingNeedsHuman(tx, f.id as string, reason, canvasId);
  }
  return { settled: rows.length };
}

export interface CloseVerifyResult {
  outcome: RoundOutcome | "skipped";
  forceHub: boolean;
  hubTrigger?: Record<string, unknown>;
  sourceNodeIds?: string[];
}

/**
 * 统一 Verify 收口：finalizeJob / dispatcher catch / reaper / cancel 均走此入口。
 * 幂等：round 已终态则跳过。
 */
export async function closeVerifyRound(
  tx: Tx,
  jobId: string,
  opts: {
    jobStatus: "succeeded" | "failed" | "timeout" | "orphan" | "cancelled";
    proposedVerdict?: string | null;
    summary?: string | null;
    error?: string | null;
  },
): Promise<CloseVerifyResult> {
  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job || job.type !== "verify_finding" || !job.finding_id) {
    return { outcome: "skipped", forceHub: false };
  }

  const findingId = job.finding_id as string;
  const [finding] = await tx`SELECT * FROM findings WHERE id = ${findingId}`;
  if (!finding) return { outcome: "skipped", forceHub: false };

  // 锁 finding + 当前 round
  await tx`SELECT id FROM findings WHERE id = ${findingId} FOR UPDATE`;
  let [round] = await tx`
    SELECT * FROM finding_verification_rounds
    WHERE verify_job_id = ${jobId}
    FOR UPDATE`;
  if (!round) {
    // 历史 verify 无 round 行：补一条只读历史
    const [{ max_attempt }] = await tx<[{ max_attempt: number | null }]>`
      SELECT MAX(attempt) AS max_attempt FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
    const [created] = await tx`
      INSERT INTO finding_verification_rounds ${tx({
        finding_id: findingId,
        attempt: (max_attempt ?? 0) + 1,
        verify_job_id: jobId,
        status: "running",
      })}
      ON CONFLICT (verify_job_id) DO NOTHING
      RETURNING *`;
    round = created ?? (
      await tx`SELECT * FROM finding_verification_rounds WHERE verify_job_id = ${jobId}`
    )[0];
  }
  if (!round) return { outcome: "skipped", forceHub: false };
  if (["confirmed", "rework", "needs_human", "failed"].includes(round.status as string) && round.finished_at) {
    return { outcome: "skipped", forceHub: false };
  }

  const originJobId = (finding.job_id as string) ?? null;
  const evidence = await collectEvidenceSnapshot(tx, findingId, originJobId);
  const canvasId = (job.canvas_id as string) ?? null;
  const { rulesForProject } = await core();
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);

  // 基础设施失败 / 取消
  if (opts.jobStatus !== "succeeded") {
    const attempt = round.attempt as number;
    const atLimit = attempt >= rules.maxVerificationRounds;
    if (atLimit || opts.jobStatus === "cancelled") {
      const outcome: RoundOutcome = "needs_human";
      await finishRound(tx, round.id as string, {
        status: "failed",
        proposed: null,
        final: outcome,
        evidence,
        summary: opts.summary ?? null,
        error: opts.error ?? `verify_${opts.jobStatus}`,
      });
      await setFindingStatus(tx, findingId, "needs_human", finding.node_id as string | null);
      if (canvasId) {
        await ensureHumanBlocker(tx, canvasId, findingId, finding.node_id as string | null, {
          reason: `verify_${opts.jobStatus}`,
          summary: opts.error ?? opts.summary ?? `Verify ${opts.jobStatus}`,
        });
      }
      return { outcome, forceHub: false };
    }

    await finishRound(tx, round.id as string, {
      status: "failed",
      proposed: null,
      final: "rework",
      evidence,
      summary: opts.summary ?? null,
      error: opts.error ?? `verify_${opts.jobStatus}`,
    });
    await setFindingStatus(tx, findingId, "pending", finding.node_id as string | null, "open");
    const hubTrigger = {
      kind: "verify_failed",
      finding_id: findingId,
      attempt: round.attempt,
      job_status: opts.jobStatus,
      missing_evidence: evidence.missing,
      summary: opts.error ?? opts.summary ?? `Verify job ${opts.jobStatus}`,
    };
    if (canvasId) {
      await clearAutoStopped(tx, canvasId);
    }
    return {
      outcome: "rework",
      forceHub: true,
      hubTrigger,
      sourceNodeIds: finding.node_id ? [finding.node_id as string] : [],
    };
  }

  // 成功路径：提案 + 硬门
  const proposed = mapProposedVerdict(opts.proposedVerdict);
  let final: RoundOutcome = proposed;
  let missing = evidence.missing;
  let gateFailed = false;

  if (proposed === "confirmed") {
    if (!evidence.qualified) {
      final = "rework";
      gateFailed = true;
      missing = evidence.missing.length > 0 ? evidence.missing : ["evidence_incomplete"];
    }
  } else if (proposed === "needs_human") {
    // 仅当明确阻塞时接受；否则也可回弹（本实现：直接接受 needs_human）
    final = "needs_human";
  } else {
    final = "rework";
  }

  // 轮次上限：rework 且已达上限 → needs_human
  if (final === "rework" && (round.attempt as number) >= rules.maxVerificationRounds) {
    final = "needs_human";
  }

  await finishRound(tx, round.id as string, {
    status: final === "confirmed" ? "confirmed" : final === "needs_human" ? "needs_human" : "rework",
    proposed,
    final,
    evidence,
    summary: opts.summary ?? null,
    error: gateFailed ? evidence.reason ?? "evidence_hard_gate_failed" : null,
  });

  if (final === "confirmed") {
    await setFindingStatus(tx, findingId, "confirmed", finding.node_id as string | null, "confirmed");
    return {
      outcome: "confirmed",
      forceHub: true,
      hubTrigger: {
        kind: "confirmed_finding",
        finding_id: findingId,
        attempt: round.attempt,
      },
      sourceNodeIds: finding.node_id ? [finding.node_id as string] : [],
    };
  }

  if (final === "needs_human") {
    await setFindingStatus(tx, findingId, "needs_human", finding.node_id as string | null);
    if (canvasId) {
      await ensureHumanBlocker(tx, canvasId, findingId, finding.node_id as string | null, {
        reason: proposed === "needs_human" ? "verify_needs_human" : "verification_limit",
        summary: opts.summary ?? "自动验证无法闭环",
        missing_evidence: missing,
      });
    }
    return { outcome: "needs_human", forceHub: false };
  }

  // rework → pending + force Hub
  await setFindingStatus(tx, findingId, "pending", finding.node_id as string | null, "open");
  if (canvasId) await clearAutoStopped(tx, canvasId);
  return {
    outcome: "rework",
    forceHub: true,
    hubTrigger: {
      kind: "verify_rework",
      finding_id: findingId,
      attempt: round.attempt,
      proposed_verdict: proposed,
      missing_evidence: missing,
      conflicting_evidence_node_ids: evidence.conflicting_node_ids,
      gate_failed: gateFailed,
      summary: opts.summary ?? (gateFailed ? "提议 confirmed 但证据硬门未通过" : "需要补充证据"),
    },
    sourceNodeIds: finding.node_id ? [finding.node_id as string] : [],
  };
}

/**
 * 补证 Job 全部终态后：有新增合格证据则再验，否则回弹 Hub。
 *
 * 并发安全：必须先 `SELECT findings ... FOR UPDATE` 串行化「最后一个完成者」判定，
 * 否则 review/test 同时 finalize 时双方都看到对方仍 active，都会 return，导致无人创建下一轮 Verify。
 */
export async function maybeReverifyAfterFollowup(
  tx: Tx,
  job: Record<string, unknown>,
): Promise<void> {
  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  const vf = payload.verification_followup as
    | { finding_id?: string; round_id?: string; required_evidence?: string[] }
    | undefined;
  if (!vf?.finding_id) return;

  const findingId = vf.finding_id;
  const canvasId = job.canvas_id as string | null;
  if (!canvasId) return;
  const selfJobId = String(job.id ?? "");

  // 串行化同一 Finding 的补证收口（关键：拿锁后再看 active）
  const [finding] = await tx`
    SELECT * FROM findings WHERE id = ${findingId} FOR UPDATE`;
  if (!finding) return;
  if (finding.verify_status === "confirmed" || finding.verify_status === "needs_human") return;

  // 同画布、同 finding 的其它活跃补证 job 是否都结束（排除本 Job）
  const activeFollowups = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND id <> ${selfJobId}
      AND status = ANY(${ACTIVE_JOB as unknown as string[]})
      AND payload_json->'verification_followup'->>'finding_id' = ${findingId}
    LIMIT 1`;
  if (activeFollowups.length > 0) return;

  // 已有活跃 verify → 不重复
  const activeVerify = await tx`
    SELECT 1 FROM jobs
    WHERE finding_id = ${findingId} AND type = 'verify_finding'
      AND status = ANY(${ACTIVE_JOB as unknown as string[]})
    LIMIT 1`;
  if (activeVerify.length > 0) return;

  const originJobId = (finding.job_id as string) ?? null;
  const evidence = await collectEvidenceSnapshot(tx, findingId, originJobId);

  // 对比上一轮证据快照哈希：无增量则回弹 Hub 说明无新证据
  const [prev] = await tx`
    SELECT id, attempt, evidence_snapshot_json FROM finding_verification_rounds
    WHERE finding_id = ${findingId}
    ORDER BY attempt DESC LIMIT 1`;
  const prevSnap = JSON.stringify(
    ((prev?.evidence_snapshot_json as EvidenceSnapshot | undefined)?.review ?? []).map((r) => r.node_id).sort(),
  ) +
    JSON.stringify(
      ((prev?.evidence_snapshot_json as EvidenceSnapshot | undefined)?.test ?? []).map((t) => t.node_id).sort(),
    );
  const curSnap =
    JSON.stringify(evidence.review.map((r) => r.node_id).sort()) +
    JSON.stringify(evidence.test.map((t) => t.node_id).sort());

  const { rulesForProject } = await core();
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  const attempt = Number(prev?.attempt ?? 0);

  // 无增量证据：若已达验证轮次上限 → needs_human；否则 force Hub 说明无新证据
  if (prev && prevSnap === curSnap && evidence.missing.length > 0) {
    if (attempt >= rules.maxVerificationRounds) {
      await markFindingNeedsHuman(tx, findingId, "max_verification_rounds_no_new_evidence", canvasId);
      return;
    }
    await clearAutoStopped(tx, canvasId);
    const { maybeTriggerHub } = await core();
    await maybeTriggerHub(
      tx,
      {
        id: job.id,
        project_id: job.project_id,
        canvas_id: canvasId,
        type: "verify_followup_empty",
        priority: job.priority ?? 0,
      },
      {
        force: true,
        sourceNodeIds: finding.node_id ? [finding.node_id as string] : [],
        trigger: {
          kind: "verify_rework",
          finding_id: findingId,
          attempt: prev.attempt,
          missing_evidence: evidence.missing,
          summary: "补证轮次未产生新增合格证据，请改派非重复工作或转人工",
          no_new_evidence: true,
        },
      },
    );
    return;
  }

  const created = await createVerifyRound(tx, {
    projectId: job.project_id as string,
    canvasId,
    finding,
    parentJobId: (finding.job_id as string) ?? (job.id as string),
    followupDepth: ((job.followup_depth as number) ?? 0) + 1,
    priorityBase: (job.priority as number) ?? 0,
    reason: "followup_evidence_ready",
  });
  // createVerifyRound 在达上限时已 mark needs_human
  void created;
}

/** Hub 派发的补证 intent：冻结 verification_followup 绑定。 */
export function buildVerificationFollowupPayload(
  trigger: Record<string, unknown> | undefined,
  intentFrom: string[] | undefined,
): Record<string, unknown> | null {
  if (!trigger) return null;
  const kind = String(trigger.kind ?? "");
  if (kind !== "verify_rework" && kind !== "verify_failed") return null;
  const findingId = trigger.finding_id as string | undefined;
  if (!findingId) return null;
  const missing = Array.isArray(trigger.missing_evidence)
    ? (trigger.missing_evidence as string[])
    : ["independent_review", "runtime_test"];
  return {
    finding_id: findingId,
    required_evidence: missing.includes("independent_review") && missing.includes("runtime_test")
      ? ["review", "test"]
      : missing.map((m) => (m.includes("review") ? "review" : m.includes("test") ? "test" : m)),
    trigger_kind: kind,
    from: intentFrom ?? [],
  };
}

/**
 * 接受结构化验证证据 fact：Zod 校验 + 绑定校验后写入 body_json 与边。
 * 非法 verification 字段被忽略（仍保留普通 fact description）。
 */
export async function attachVerificationEvidence(
  tx: Tx,
  job: Record<string, unknown>,
  nodeId: string,
  canvasId: string,
  verification: unknown,
): Promise<boolean> {
  const parsed = VerificationEvidence.safeParse(verification);
  if (!parsed.success) {
    console.warn(`[verify] ignore invalid verification on job ${String(job.id)}:`, parsed.error.flatten());
    return false;
  }
  const ver: VerificationEvidenceType = parsed.data;

  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  const vf = payload.verification_followup as { finding_id?: string } | undefined;
  if (!vf?.finding_id || vf.finding_id !== ver.finding_id) {
    // 无绑定或 finding 不匹配：忽略验证字段，当作普通 fact
    return false;
  }

  const [finding] = await tx`
    SELECT id, node_id, project_id FROM findings WHERE id = ${ver.finding_id}`;
  if (!finding?.node_id) return false;

  // 确认 finding 属于当前画布
  const [fn] = await tx`
    SELECT canvas_id FROM canvas_nodes WHERE id = ${finding.node_id as string}`;
  if (!fn || fn.canvas_id !== canvasId) return false;

  const edgeType = ver.evidence_kind === "review" ? "reviewed_by" : "tested_by";
  await tx`
    UPDATE canvas_nodes
    SET body_json = body_json || ${tx.json({
      verification: {
        finding_id: ver.finding_id,
        evidence_kind: ver.evidence_kind,
        outcome: ver.outcome,
        subject_revision: ver.subject_revision,
        environment: ver.environment ?? null,
        steps: ver.steps ?? [],
        expected: ver.expected ?? null,
        actual: ver.actual ?? null,
        artifact_refs: ver.artifact_refs ?? [],
        limitations: ver.limitations ?? [],
        source_job_id: String(job.id),
        source_role: String(job.type),
      },
    })}
    WHERE id = ${nodeId}`;

  await insertEdgeIfAbsent(tx, canvasId, finding.node_id as string, nodeId, edgeType);
  return true;
}

export interface FindingStatusProblem {
  finding_id: string;
  title: string;
  severity: string;
  verify_status: string;
  /** 为何阻塞 complete/report */
  issue: string;
  in_care_scope: boolean;
}

/**
 * 关注级别元数据（minVerifySeverity 及以上 severity 列表）。
 * **severity 只影响 Verify 优先级 / Hub 等待门，不改变收敛集合。**
 * 收敛门：全部 Finding ∈ {confirmed, needs_human}（见 canvasFindingsConverged）。
 */
export async function careSeverityMeta(
  tx: Tx,
  projectId: string,
): Promise<{ careSeverities: string[]; minVerifySeverity: string }> {
  const { rulesForProject, careSeverities } = await core();
  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  return {
    careSeverities: careSeverities(rules.minVerifySeverity).map((s) => s.toLowerCase()),
    minVerifySeverity: rules.minVerifySeverity,
  };
}

/**
 * @deprecated 名称易误解。历史上曾要求 care 必须 confirmed；现与全量收敛一致。
 * 请用 canvasFindingsConverged。保留别名以免外部误用旧语义。
 */
export async function checkCareFindingsConfirmed(
  tx: Tx,
  canvasId: string,
  _projectId: string,
): Promise<{
  ok: boolean;
  careSeverities: string[];
  minVerifySeverity: string;
  problems: FindingStatusProblem[];
}> {
  const conv = await canvasFindingsConverged(tx, canvasId);
  const meta = _projectId
    ? await careSeverityMeta(tx, _projectId)
    : { careSeverities: [] as string[], minVerifySeverity: "high" };
  return {
    ok: conv.ok,
    careSeverities: meta.careSeverities,
    minVerifySeverity: meta.minVerifySeverity,
    problems: conv.problems,
  };
}

/**
 * Hub complete / Report 统一收敛门（TODO §0.3 / §4.2 / §5）：
 * 每条 Finding 的 verify_status ∈ {confirmed, needs_human}；
 * confirmed 须有可追溯 verification round；无未关闭 round。
 * severity / minVerifySeverity **不**收窄该集合。
 */
export async function canvasFindingsConverged(
  tx: Tx,
  canvasId: string,
  _opts?: { projectId?: string; requireCareConfirmed?: boolean },
): Promise<{ ok: boolean; blockers: string[]; problems: FindingStatusProblem[] }> {
  // requireCareConfirmed 已废弃：忽略，避免 care needs_human 堵死 Report 活性
  void _opts;

  const findings = await tx`
    SELECT f.id, f.verify_status, f.title, f.severity
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}`;

  const blockers: string[] = [];
  const problems: FindingStatusProblem[] = [];

  for (const f of findings) {
    const st = f.verify_status as string;
    const sev = String(f.severity ?? "").toLowerCase();

    if (st !== "confirmed" && st !== "needs_human") {
      blockers.push(`finding:${f.id}:${st}`);
      problems.push({
        finding_id: f.id as string,
        title: String(f.title ?? ""),
        severity: sev,
        verify_status: st,
        issue: `Finding 未收敛（须 confirmed 或 needs_human，当前 ${st}）`,
        in_care_scope: false,
      });
      continue;
    }
    if (st === "confirmed") {
      const [round] = await tx`
        SELECT id FROM finding_verification_rounds
        WHERE finding_id = ${f.id as string} AND final_outcome = 'confirmed'
        LIMIT 1`;
      if (!round) {
        blockers.push(`finding:${f.id}:confirmed_without_round`);
        problems.push({
          finding_id: f.id as string,
          title: String(f.title ?? ""),
          severity: sev,
          verify_status: st,
          issue: "confirmed 缺少可追溯 verification round",
          in_care_scope: false,
        });
      }
    }
    // needs_human：须有绑定 finding_id 的 human 节点可审计（TODO §4.2）
    if (st === "needs_human") {
      const hasHuman = await tx`
        SELECT 1 FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'human'
          AND body_json->>'finding_id' = ${f.id as string}
        LIMIT 1`;
      if (hasHuman.length === 0) {
        blockers.push(`finding:${f.id}:needs_human_without_blocker`);
        problems.push({
          finding_id: f.id as string,
          title: String(f.title ?? ""),
          severity: sev,
          verify_status: st,
          issue: "needs_human 缺少 human/blocker 节点（无可审计阻塞原因）",
          in_care_scope: false,
        });
      }
    }
  }

  const openRounds = await tx`
    SELECT r.id, r.finding_id FROM finding_verification_rounds r
    JOIN findings f ON f.id = r.finding_id
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId} AND r.status IN ('pending','running')
    LIMIT 5`;
  for (const r of openRounds) blockers.push(`open_round:${r.id}`);

  return { ok: blockers.length === 0 && problems.length === 0, blockers, problems };
}

export async function hasActiveWorkJobs(
  tx: Tx,
  canvasId: string,
  excludeJobId?: string | null,
): Promise<boolean> {
  if (excludeJobId) {
    const rows = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId}
        AND id <> ${excludeJobId}
        AND type NOT IN ('report')
        AND status = ANY(${ACTIVE_JOB as unknown as string[]})
      LIMIT 1`;
    return rows.length > 0;
  }
  const rows = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND type NOT IN ('report')
      AND status = ANY(${ACTIVE_JOB as unknown as string[]})
    LIMIT 1`;
  return rows.length > 0;
}

/** 至少成功执行过一次非 Hub/Verify/Report 的普通角色 Job（TODO §4.2 空图护栏）。 */
export async function hasSucceededRoleWork(tx: Tx, canvasId: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND type NOT IN ('hub_reason', 'verify_finding', 'report')
      AND status = 'succeeded'
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * 统一分析完成门（Hub complete 与 maxHubRounds 护栏共用）。
 * - 全部 Finding ∈ {confirmed, needs_human}（含 human blocker 校验）
 * - 无未关闭 verification round
 * - 无活跃工作（可排除当前 job）
 * - 至少一次普通角色成功 Job（防空图成功报告）
 */
export async function evaluateAnalysisCompleteGate(
  tx: Tx,
  canvasId: string,
  opts?: { excludeJobId?: string | null },
): Promise<{ ok: boolean; blockers: string[]; problems: FindingStatusProblem[] }> {
  const conv = await canvasFindingsConverged(tx, canvasId);
  const blockers = [...conv.blockers];
  const problems = [...conv.problems];

  if (await hasActiveWorkJobs(tx, canvasId, opts?.excludeJobId)) {
    blockers.push("active_work");
    problems.push({
      finding_id: "",
      title: "",
      severity: "",
      verify_status: "",
      issue: "仍有活跃工作 Job（角色/Hub/Verify）",
      in_care_scope: false,
    });
  }

  if (!(await hasSucceededRoleWork(tx, canvasId))) {
    blockers.push("no_role_work");
    problems.push({
      finding_id: "",
      title: "",
      severity: "",
      verify_status: "",
      issue: "尚未执行任何普通角色 Job（空图不可 complete/Report）",
      in_care_scope: false,
    });
  }

  return { ok: blockers.length === 0, blockers, problems };
}

// ---------- internals ----------

async function insertEdgeIfAbsent(tx: Tx, canvasId: string, fromId: string, toId: string, edgeType: string) {
  const existing = await tx`
    SELECT 1 FROM canvas_edges
    WHERE canvas_id = ${canvasId} AND from_node_id = ${fromId} AND to_node_id = ${toId} AND edge_type = ${edgeType}
    LIMIT 1`;
  if (existing.length > 0) return;
  await tx`
    INSERT INTO canvas_edges ${tx({
      canvas_id: canvasId,
      from_node_id: fromId,
      to_node_id: toId,
      edge_type: edgeType,
    })}`;
}

async function finishRound(
  tx: Tx,
  roundId: string,
  opts: {
    status: string;
    proposed: ProposedVerdict | null;
    final: RoundOutcome;
    evidence: EvidenceSnapshot;
    summary: string | null;
    error: string | null;
  },
) {
  await tx`
    UPDATE finding_verification_rounds SET
      status = ${opts.status},
      proposed_verdict = ${opts.proposed},
      final_outcome = ${opts.final},
      evidence_snapshot_json = ${tx.json(opts.evidence as never)},
      summary = ${opts.summary},
      error = ${opts.error},
      finished_at = now()
    WHERE id = ${roundId}`;
}

async function setFindingStatus(
  tx: Tx,
  findingId: string,
  verifyStatus: string,
  nodeId: string | null,
  nodeStatus?: string,
) {
  await tx`UPDATE findings SET verify_status = ${verifyStatus}, updated_at = now() WHERE id = ${findingId}`;
  if (nodeId) {
    await tx`
      UPDATE canvas_nodes SET status = ${nodeStatus ?? verifyStatus}, updated_at = now()
      WHERE id = ${nodeId}`;
  }
}

async function markFindingNeedsHuman(
  tx: Tx,
  findingId: string,
  reason: string,
  canvasId: string | null,
) {
  const [finding] = await tx`SELECT id, node_id FROM findings WHERE id = ${findingId}`;
  if (!finding) return;
  await setFindingStatus(tx, findingId, "needs_human", finding.node_id as string | null);
  if (canvasId) {
    await ensureHumanBlocker(tx, canvasId, findingId, finding.node_id as string | null, {
      reason,
      summary: reason,
    });
  }
}

async function ensureHumanBlocker(
  tx: Tx,
  canvasId: string,
  findingId: string,
  findingNodeId: string | null,
  body: Record<string, unknown>,
) {
  const existing = await tx`
    SELECT id FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'human'
      AND body_json->>'finding_id' = ${findingId}
      AND body_json->>'kind' = 'verification_blocker'
    LIMIT 1`;
  if (existing.length > 0) return;

  let x = 200;
  let y = 400;
  if (findingNodeId) {
    const [n] = await tx`SELECT x, y FROM canvas_nodes WHERE id = ${findingNodeId}`;
    if (n) {
      x = (n.x as number) + 40;
      y = (n.y as number) + 180;
    }
  }
  const [human] = await tx`
    INSERT INTO canvas_nodes ${tx({
      canvas_id: canvasId,
      job_id: null,
      node_type: "human",
      title: `验证阻塞：${String(body.reason ?? "needs_human").slice(0, 80)}`,
      body_json: {
        kind: "verification_blocker",
        finding_id: findingId,
        ...body,
      } as never,
      x,
      y,
      status: "open",
    })}
    RETURNING id`;
  if (findingNodeId) {
    await insertEdgeIfAbsent(tx, canvasId, findingNodeId, human.id as string, "next");
  }
}

async function clearAutoStopped(tx: Tx, canvasId: string) {
  const { patchCanvasConvergence } = await core();
  await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
    auto_stopped: false,
    paused_reason: undefined,
    paused_at: undefined,
  });
}

/** 导出给 graph 的 Finding 验证摘要 */
export async function findingVerificationSummary(
  tx: Tx,
  findingId: string,
): Promise<Record<string, unknown>> {
  const [finding] = await tx`SELECT verify_status, job_id FROM findings WHERE id = ${findingId}`;
  const [round] = await tx`
    SELECT attempt, status, final_outcome, proposed_verdict, evidence_snapshot_json, summary, error
    FROM finding_verification_rounds
    WHERE finding_id = ${findingId}
    ORDER BY attempt DESC LIMIT 1`;
  const evidence = await collectEvidenceSnapshot(
    tx,
    findingId,
    (finding?.job_id as string) ?? null,
  );
  return {
    verify_status: finding?.verify_status ?? "pending",
    verification_attempt: round?.attempt ?? 0,
    latest_outcome: round?.final_outcome ?? round?.status ?? null,
    proposed_verdict: round?.proposed_verdict ?? null,
    missing_evidence: evidence.missing,
    review_evidence_ids: evidence.review.map((r) => r.node_id),
    test_evidence_ids: evidence.test.map((t) => t.node_id),
    conflicting_evidence_ids: evidence.conflicting_node_ids,
    summary: round?.summary ?? null,
    error: round?.error ?? null,
  };
}

void TERMINAL_JOB;
