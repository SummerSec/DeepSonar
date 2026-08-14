/**
 * Finding 多轮 Verify：自动派生、证据硬门、统一收口、Hub 回弹与再验。
 * As-built 语义见根目录 DESIGN.md（Verify / 收敛 / minVerifySeverity）。
 *
 * Core owns composition and supplies the transaction-aware convergence helpers.
 * The static imports make this dependency visible to the bounded-context map.
 */
import { VerificationEvidence, type VerificationEvidence as VerificationEvidenceType } from "@deepsonar/shared-types";
import { sql } from "./db.js";
import { invalidVerification } from "./control-input.js";
import {
  careSeverities,
  fixedPriorityForJob,
  isSeverityInVerifyScope as coreIsSeverityInVerifyScope,
  lockCanvasForConvergence,
  patchCanvasConvergence,
  recoverVerifyJobTerminal,
  resolveAgentSnapshotForJob,
  rulesForProject,
  SEVERITY_RANK,
} from "./core.js";
import { recordJobSharedAssets } from "./domains/shared-assets/index.js";
import { maybeDispatchFindingReport } from "./report.js";
import { freezeAgentSnapshotNetworkPolicy } from "./domains/role-runtime-snapshot/index.js";

export function isSeverityInVerifyScope(minSeverity: string, severity: unknown): boolean {
  return coreIsSeverityInVerifyScope(minSeverity, severity);
}

type Tx = typeof sql;
type SavepointTx = Tx & {
  savepoint<T>(callback: (tx: Tx) => T | Promise<T>): Promise<T>;
};

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

export type VerificationEligibility = "eligible" | "waiting_evidence" | "blocked" | "below_min_verify_severity";

function evidenceSignature(evidence: Pick<EvidenceSnapshot, "review" | "test" | "missing">): string {
  return JSON.stringify({
    review: evidence.review.map((row) => row.node_id).sort(),
    test: evidence.test.map((row) => row.node_id).sort(),
    missing: [...evidence.missing].sort(),
  });
}

function verificationState(
  eligibility: VerificationEligibility,
  evidence: EvidenceSnapshot,
): Record<string, unknown> {
  return {
    eligibility,
    missing_evidence: evidence.missing,
    evidence_signature: evidenceSignature(evidence),
    updated_at: new Date().toISOString(),
  };
}

const VALID_OUTCOMES = new Set(["supports", "refutes", "inconclusive"]);

type EvidenceNodeRow = Record<string, unknown>;

/** Single source of truth for the review/test evidence hard gate. */
export function buildEvidenceSnapshot(
  rows: readonly EvidenceNodeRow[],
  originJobId: string | null,
): EvidenceSnapshot {
  const review: Array<Record<string, unknown>> = [];
  const test: Array<Record<string, unknown>> = [];
  const conflicting: string[] = [];
  for (const row of rows) {
    const body = (row.body_json ?? {}) as Record<string, unknown>;
    const verification = (body.verification ?? {}) as Record<string, unknown>;
    const kind = String(verification.evidence_kind ?? "");
    const outcome = String(verification.outcome ?? "");
    const jobId = (row.job_id as string | null) ?? null;
    if (!jobId || (originJobId && jobId === originJobId)) continue;
    if (!VALID_OUTCOMES.has(outcome)) continue;
    const base = {
      node_id: row.id as string,
      job_id: jobId,
      job_type: row.job_type as string | null,
      job_status: row.job_status as string,
      outcome,
      subject_revision: verification.subject_revision ?? null,
      steps: verification.steps ?? null,
      expected: verification.expected ?? null,
      actual: verification.actual ?? null,
      artifact_refs: verification.artifact_refs ?? null,
      limitations: verification.limitations ?? null,
      environment: verification.environment ?? null,
      title: row.title as string,
      description: (body.description as string) ?? null,
    };
    if (kind === "review") {
      if (outcome === "inconclusive") continue;
      if (outcome === "refutes") conflicting.push(String(row.id));
      if (outcome === "supports" || outcome === "refutes") review.push(base);
    } else if (kind === "test") {
      const steps = Array.isArray(verification.steps) ? verification.steps : [];
      const hasRevision = typeof verification.subject_revision === "string" && verification.subject_revision.trim().length > 0;
      const hasActual =
        (typeof verification.actual === "string" && verification.actual.trim().length > 0) ||
        (Array.isArray(verification.artifact_refs) && verification.artifact_refs.length > 0);
      const hasSteps = steps.length > 0;
      const hasExpected = typeof verification.expected === "string" && verification.expected.trim().length > 0;
      if (!hasRevision || !hasSteps || !hasExpected || !hasActual) continue;
      if (outcome === "inconclusive") continue;
      if (outcome === "refutes") conflicting.push(String(row.id));
      if (outcome === "supports" || outcome === "refutes") test.push(base);
    }
  }
  const reviewJobs = new Set(review.map((row) => row.job_id as string));
  const testJobs = new Set(test.map((row) => row.job_id as string));
  const independent = review.length > 0 && test.length > 0 && [...reviewJobs].some((id) => !testJobs.has(id));
  const supportsTest = test.some((row) => row.outcome === "supports");
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
    reason: qualified ? undefined : "evidence_gate_failed:" + missing.join(","),
  };
}

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

  return buildEvidenceSnapshot(nodes as unknown as EvidenceNodeRow[], originJobId);
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
    manualOverride?: boolean;
  },
): Promise<{ jobId: string; roundId: string; attempt: number } | null> {
  const findingId = opts.finding.id as string;
  if (!(await lockCanvasForConvergence(tx, opts.canvasId))) return null;
  const rules = await rulesForProject(tx as unknown as typeof sql, opts.projectId);

  const severity = String(opts.finding.severity ?? "").trim().toLowerCase();
  if (!opts.manualOverride && !isSeverityInVerifyScope(rules.minVerifySeverity, severity)) {
    await markFindingBelowMinVerifySeverity(tx, findingId, rules.minVerifySeverity);
    return null;
  }

  if (opts.followupDepth >= rules.maxFollowupDepth) {
    await markFindingNeedsHuman(tx, findingId, "max_followup_depth");
    return null;
  }

  const [openRound] = await tx`
    SELECT * FROM finding_verification_rounds
    WHERE finding_id = ${findingId} AND status IN ('pending','running')
    ORDER BY attempt DESC LIMIT 1`;
  const [{ max_attempt }] = await tx<[{ max_attempt: number | null }]>`
    SELECT MAX(attempt) AS max_attempt FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
  const nextAttempt = Number(openRound?.attempt ?? ((max_attempt ?? 0) + 1));
  if (nextAttempt > rules.maxVerificationRounds) {
    await markFindingNeedsHuman(tx, findingId, "max_verification_rounds");
    return null;
  }

  const active = await tx`
    SELECT id FROM jobs
    WHERE finding_id = ${findingId} AND type = 'verify_finding'
      AND status = ANY(${ACTIVE_JOB as unknown as string[]})
    LIMIT 1`;
  if (active.length > 0) return null;

  const evidence = await collectEvidenceSnapshot(tx, findingId, (opts.finding.job_id as string) ?? null);
  const signature = evidenceSignature(evidence);
  const existingRequirements = (openRound?.requirements_json ?? {}) as Record<string, unknown>;
  // Any open round without a runnable Job is scheduler-owned state that must
  // be reclassified from current evidence. This also repairs legacy rows with
  // a stale/missing eligibility marker instead of leaving them invisible.
  const existingRoundIsWaiting = Boolean(openRound) && !openRound?.verify_job_id;

  // An in-scope Finding enters the Verify lifecycle, but a round with missing
  // independent evidence is represented explicitly and has no runnable Job.
  // This avoids a pending verify spinning through rework while Hub is waiting
  // for review/test evidence.
  if (!opts.manualOverride && !evidence.qualified && (!openRound || existingRoundIsWaiting)) {
    const requirements = {
      ...existingRequirements,
      need_review: true,
      need_test: true,
      eligibility: "waiting_evidence" as VerificationEligibility,
      missing: evidence.missing,
      evidence_signature: signature,
      hub_evidence_signature: existingRequirements.hub_evidence_signature ?? null,
    };
    if (openRound) {
      await tx`
        UPDATE finding_verification_rounds SET
          requirements_json = ${tx.json(requirements as never)},
          evidence_snapshot_json = ${tx.json(evidence as never)},
          status = 'pending', verify_job_id = NULL
        WHERE id = ${openRound.id as string}`;
    } else {
      await tx`
        INSERT INTO finding_verification_rounds ${tx({
          finding_id: findingId,
          attempt: nextAttempt,
          verify_job_id: null,
          status: "pending",
          requirements_json: requirements as never,
          evidence_snapshot_json: evidence as never,
        })}`;
    }
    await tx`
      UPDATE findings SET
        verify_status = 'pending',
        raw_json = raw_json || ${tx.json({ verification_state: verificationState("waiting_evidence", evidence) } as never)},
        updated_at = now()
      WHERE id = ${findingId}`;
    if (opts.finding.node_id) {
      await tx`
        UPDATE canvas_nodes SET status = 'verifying', updated_at = now()
        WHERE id = ${opts.finding.node_id as string}`;
    }
    return null;
  }

  if (openRound && !existingRoundIsWaiting) return null;

  const snapshot = await freezeAgentSnapshotNetworkPolicy(
    tx as unknown as typeof sql,
    opts.canvasId,
    await resolveAgentSnapshotForJob(tx as unknown as typeof sql, opts.projectId, "verify_finding", [findingId]),
  );
  const priority = fixedPriorityForJob({ type: "verify_finding", purpose: "verify", severity });

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
          scheduling_purpose: "verify",
          verification_eligibility: "eligible",
          finding: {
            fingerprint: opts.finding.fingerprint,
            title: opts.finding.title,
            location: opts.finding.location,
            summary: opts.finding.summary,
            severity,
          },
          verification_attempt: nextAttempt,
          reason: opts.reason ?? "auto",
          ...(opts.manualOverride
            ? { manual_override: { source: "operator", reason: opts.reason ?? "manual_verify" } }
            : {}),
        } as never,
        timeout_sec: rules.verifyTimeoutSec,
        followup_depth: opts.followupDepth,
      })}
      RETURNING id`;
    verifyJob = row as { id: string };
    await recordJobSharedAssets(tx as unknown as typeof sql, verifyJob.id, snapshot.shared_assets ?? []);
  } catch (e) {
    // 局部唯一索引：并发下另一活跃 verify 已存在
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("jobs_one_active_verify_per_finding")) return null;
    throw e;
  }

  let round: Record<string, unknown> | undefined;
  if (openRound && existingRoundIsWaiting) {
    const requirements = {
      ...existingRequirements,
      need_review: true,
      need_test: true,
      eligibility: "eligible" as VerificationEligibility,
      missing: opts.manualOverride ? evidence.missing : [],
      evidence_signature: signature,
      ...(opts.manualOverride ? { manual_override: true } : {}),
    };
    const [updated] = await tx`
      UPDATE finding_verification_rounds SET
        verify_job_id = ${verifyJob.id}, status = 'pending',
        requirements_json = ${tx.json(requirements as never)},
        evidence_snapshot_json = ${tx.json(evidence as never)}
      WHERE id = ${openRound.id as string}
      RETURNING id`;
    round = updated as Record<string, unknown>;
  } else {
    const [created] = await tx`
      INSERT INTO finding_verification_rounds ${tx({
        finding_id: findingId,
        attempt: nextAttempt,
        verify_job_id: verifyJob.id,
        status: "pending",
        requirements_json: {
          need_review: true,
          need_test: true,
          eligibility: "eligible",
          missing: opts.manualOverride ? evidence.missing : [],
          evidence_signature: signature,
          ...(opts.manualOverride ? { manual_override: true } : {}),
        } as never,
        evidence_snapshot_json: evidence as never,
      })}
      RETURNING id`;
    round = created as Record<string, unknown>;
  }

  await tx`
    UPDATE findings SET
      verify_status = 'verifying',
      raw_json = raw_json || ${tx.json({ verification_state: verificationState("eligible", evidence) } as never)},
      updated_at = now()
    WHERE id = ${findingId}`;

  // 画布：finding → verifies → verify job
  const [findingNode] = await tx`SELECT node_id FROM findings WHERE id = ${findingId}`;
  if (findingNode?.node_id && round?.id) {
    const [source] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE id = ${findingNode.node_id}`;
    if (source) {
      const existingNode = await tx`
        SELECT id FROM canvas_nodes WHERE job_id = ${verifyJob.id} AND node_type = 'job' LIMIT 1`;
      if (existingNode.length > 0) return { jobId: verifyJob.id, roundId: round.id as string, attempt: nextAttempt };
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

export interface VerificationRoundNormalizationSummary {
  missingJobExamined: number;
  missingJobReclassified: number;
  staleJobExamined: number;
  staleJobRepaired: number;
}

/**
 * Repair open verification rounds left by older scheduler versions. A plain
 * pending row with a NULL verify_job_id and no eligibility marker used to be
 * invisible to the dispatcher forever. Re-read and lock each row before
 * reusing it so a restart cannot create a duplicate attempt. Terminal jobs
 * are recovered through the same close/rework path used by Reaper and the
 * dispatcher failure handler.
 */
export async function normalizePendingVerificationRounds(
  db: typeof sql = sql,
): Promise<VerificationRoundNormalizationSummary> {
  const missingJobRounds = await db`
    SELECT r.id, r.finding_id, r.status, r.verify_job_id,
           f.project_id, f.job_id AS origin_job_id, f.verify_status,
           j.canvas_id AS origin_canvas_id, j.followup_depth AS origin_followup_depth
    FROM finding_verification_rounds r
    JOIN findings f ON f.id = r.finding_id
    JOIN jobs j ON j.id = f.job_id
    WHERE r.status IN ('pending','running')
      AND r.verify_job_id IS NULL
    ORDER BY r.created_at ASC, r.id ASC`;
  let missingJobReclassified = 0;
  for (const candidate of missingJobRounds) {
    const outcome = await db.begin(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      if (!(await lockCanvasForConvergence(tx, (candidate.origin_canvas_id as string | null) ?? null))) return "gone" as const;
      const [round] = await tx`
        SELECT id, finding_id, status, verify_job_id, requirements_json
        FROM finding_verification_rounds
        WHERE id = ${candidate.id as string}
          AND status IN ('pending','running')
        FOR UPDATE`;
      if (!round || round.verify_job_id) return "gone" as const;
      const [finding] = await tx`
        SELECT f.*, j.canvas_id AS origin_canvas_id, j.followup_depth AS origin_followup_depth
        FROM findings f JOIN jobs j ON j.id = f.job_id
        WHERE f.id = ${round.finding_id as string}`;
      if (!finding) return "gone" as const;
      const canvasId = (finding.origin_canvas_id as string | null) ?? null;
      if (finding.verify_status === "confirmed" || finding.verify_status === "needs_human") {
        // The Finding status is already terminal. Close only this stale open
        // round; never rewrite the terminal Finding or any prior round.
        const terminalStatus = finding.verify_status === "confirmed" ? "confirmed" : "needs_human";
        await tx`
          UPDATE finding_verification_rounds SET
            status = ${terminalStatus}, final_outcome = ${terminalStatus},
            error = 'boot_stale_open_verification_round',
            finished_at = COALESCE(finished_at, now())
          WHERE id = ${round.id as string}`;
        return "closed" as const;
      }
      const created = await createVerifyRound(tx, {
        projectId: finding.project_id as string,
        canvasId,
        finding: finding as Record<string, unknown>,
        parentJobId: finding.job_id as string,
        followupDepth: Number(finding.origin_followup_depth ?? 0),
        priorityBase: 0,
        reason: "boot_reconcile",
      });
      return created ? "eligible" as const : "classified" as const;
    });
    if (outcome !== "gone") missingJobReclassified += 1;
  }

  const staleJobs = await db`
    SELECT r.id AS round_id, r.finding_id, r.verify_job_id,
           j.canvas_id,
           j.status AS job_status, j.error AS job_error
    FROM finding_verification_rounds r
    JOIN jobs j ON j.id = r.verify_job_id
    WHERE r.status IN ('pending','running')
      AND j.status = ANY(${TERMINAL_JOB as unknown as string[]})
    ORDER BY r.created_at ASC, r.id ASC`;
  let staleJobRepaired = 0;
  for (const stale of staleJobs) {
    const status = String(stale.job_status) as (typeof TERMINAL_JOB)[number];
    if (status === "failed" || status === "timeout" || status === "orphan" || status === "cancelled") {
      await recoverVerifyJobTerminal(
        stale.verify_job_id as string,
        status,
        (stale.job_error as string | null) ?? "boot_stale_terminal_verify",
      );
      staleJobRepaired += 1;
      continue;
    }
    // A succeeded Verify without a closed round has no durable verdict to
    // replay. Hand it to a human rather than inventing an outcome or
    // scheduling another attempt on every restart.
    const repaired = await db.begin(async (txRaw) => {
      const tx = txRaw as unknown as Tx;
      if (!(await lockCanvasForConvergence(tx, (stale.canvas_id as string | null) ?? null))) return false;
      const [round] = await tx`
        SELECT id, finding_id FROM finding_verification_rounds
        WHERE id = ${stale.round_id as string}
          AND status IN ('pending','running')
        FOR UPDATE`;
      if (!round) return false;
      const [job] = await tx`
        SELECT j.status, j.canvas_id, f.verify_status
        FROM jobs j JOIN findings f ON f.id = ${round.finding_id as string}
        WHERE j.id = ${stale.verify_job_id as string}`;
      if (job?.status !== "succeeded") return false;
      if (job.verify_status === "confirmed" || job.verify_status === "needs_human") {
        const terminalStatus = job.verify_status === "confirmed" ? "confirmed" : "needs_human";
        await tx`
          UPDATE finding_verification_rounds SET
            status = ${terminalStatus}, final_outcome = ${terminalStatus},
            error = 'boot_stale_verify_success',
            finished_at = COALESCE(finished_at, now())
          WHERE id = ${round.id as string}`;
        return true;
      }
      await markFindingNeedsHuman(
        tx,
        round.finding_id as string,
        "boot_stale_verify_success",
      );
      return true;
    });
    if (repaired) staleJobRepaired += 1;
  }

  return {
    missingJobExamined: missingJobRounds.length,
    missingJobReclassified,
    staleJobExamined: staleJobs.length,
    staleJobRepaired,
  };
}

/** Finding 创建后按最低关注级别进入 Verify；缺证据时先登记等待态。 */
export async function evaluateFollowup(
  tx: Tx,
  job: Record<string, unknown>,
  finding: Record<string, unknown>,
): Promise<void> {
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  const canvasId = (job.canvas_id as string) ?? null;
  const findingId = finding.id as string;
  if (!(await lockCanvasForConvergence(tx, canvasId))) return;

  if (!isSeverityInVerifyScope(rules.minVerifySeverity, finding.severity)) {
    await markFindingBelowMinVerifySeverity(tx, findingId, rules.minVerifySeverity);
    return;
  }

  if ((job.followup_depth as number) >= rules.maxFollowupDepth) {
    await markFindingNeedsHuman(tx, findingId, "max_followup_depth");
    return;
  }

  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${job.id as string}`;
  if (count >= rules.maxFollowupsPerJob) {
    console.warn(`[verify] job ${job.id} followup 超过上限 ${rules.maxFollowupsPerJob}`);
    await markFindingNeedsHuman(tx, findingId, "max_followups_per_job");
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
  if (!(await lockCanvasForConvergence(tx, canvasId))) return { settled: 0 };
  const [canvas] = await tx`SELECT project_id FROM canvases WHERE id = ${canvasId}`;
  const rules = canvas?.project_id
    ? await rulesForProject(tx as unknown as typeof sql, String(canvas.project_id))
    : null;
  const rows = await tx`
    SELECT f.id, f.node_id, f.verify_status, f.severity
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}
      AND f.verify_status IN ('pending', 'verifying', 'false_positive')`;
  let settled = 0;
  for (const f of rows) {
    if (rules && !isSeverityInVerifyScope(rules.minVerifySeverity, f.severity)) {
      await markFindingBelowMinVerifySeverity(tx, f.id as string, rules.minVerifySeverity);
      continue;
    }
    // 关闭未结束的 round
    await tx`
      UPDATE finding_verification_rounds SET
        status = 'needs_human',
        final_outcome = 'needs_human',
        error = ${reason},
        finished_at = COALESCE(finished_at, now())
      WHERE finding_id = ${f.id as string} AND status IN ('pending', 'running')`;
    await markFindingNeedsHuman(tx, f.id as string, reason);
    settled += 1;
  }
  return { settled };
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

  if (!(await lockCanvasForConvergence(tx, (job.canvas_id as string | null) ?? null))) {
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
    // A report is a read-only derivative. Dispatch failures must never roll
    // back the technical confirmation or block the Verify state machine.
    try {
      await (tx as SavepointTx).savepoint((reportTx) =>
        maybeDispatchFindingReport(reportTx, findingId)
      );
    } catch (error) {
      console.error(`[verify] finding ${findingId} report dispatch failed:`, error);
    }
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

  if (!(await lockCanvasForConvergence(tx, canvasId))) return;

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
    SELECT id, attempt, requirements_json, evidence_snapshot_json FROM finding_verification_rounds
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

  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  const attempt = Number(prev?.attempt ?? 0);

  // 无增量证据：若已达验证轮次上限 → needs_human；否则保持既有
  // waiting_evidence 资格态。重复回弹 Hub 会在每个 role 终态制造同一
  // 个决策 Job，形成 churn，因此没有新的证据就不再派生任何 Job。
  if (prev && prevSnap === curSnap && evidence.missing.length > 0) {
    const previousNoNew = Number(
      ((prev.requirements_json as Record<string, unknown> | undefined)?.no_new_evidence_count ?? 0),
    );
    const noNewCount = previousNoNew + 1;
    await tx`
      UPDATE finding_verification_rounds
      SET requirements_json = requirements_json || ${tx.json({ no_new_evidence_count: noNewCount } as never)}
      WHERE id = ${prev.id as string}`;
    if (attempt >= rules.maxVerificationRounds || noNewCount >= rules.maxVerificationRounds) {
      await markFindingNeedsHuman(tx, findingId, "max_verification_rounds_no_new_evidence");
      return;
    }
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
  role: string,
): Record<string, unknown> | null {
  if (!trigger) return null;
  const kind = String(trigger.kind ?? "");
  if (kind !== "verify_rework" && kind !== "verify_failed" && kind !== "hub_finding") return null;
  if (kind === "hub_finding" && role !== "review" && role !== "test") return null;
  const findingId = trigger.finding_id as string | undefined;
  if (!findingId) return null;
  const missing = Array.isArray(trigger.missing_evidence)
    ? (trigger.missing_evidence as string[])
    : ["independent_review", "runtime_test"];
  return {
    finding_id: findingId,
    // 每个补证 Job 只承担一种证据职责；服务端接收证据时再次校验 role ↔ evidence_kind。
    required_evidence: [role],
    missing_evidence: missing,
    trigger_kind: kind,
    from: intentFrom ?? [],
  };
}

/**
 * 接受结构化验证证据 fact：Zod 校验 + 绑定校验后写入 body_json 与边。
 * 任一绑定失败都抛出稳定控制面错误；调用方所在事件事务会回滚，
 * 绝不把补证失败降级成普通 fact。
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
    throw invalidVerification(`verification 字段不符合严格契约（job=${String(job.id)}）。`);
  }
  const ver: VerificationEvidenceType = parsed.data;

  // built-in 补证职责不可由 Agent 自报冒充：review 只能提交 review，test 只能提交 test。
  // Hub 的 verify_rework/verify_failed 路径也只允许创建这两类 Job。
  if (String(job.type ?? "") !== ver.evidence_kind) {
    throw invalidVerification(
      `verification.evidence_kind=${ver.evidence_kind} 与当前角色 ${String(job.type)} 不匹配。`,
      "verification.evidence_kind",
    );
  }

  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  const vf = payload.verification_followup as { finding_id?: string } | undefined;
  if (!vf?.finding_id || vf.finding_id !== ver.finding_id) {
    throw invalidVerification(
      "verification.finding_id 必须匹配当前 Scheduler 绑定的补证 Finding。",
      "verification.finding_id",
    );
  }

  const [finding] = await tx`
    SELECT id, node_id, project_id, job_id FROM findings WHERE id = ${ver.finding_id}`;
  if (!finding?.node_id) {
    throw invalidVerification("verification.finding_id 不存在或尚未生成 Finding 节点。", "verification.finding_id");
  }

  // Re-check all ownership links at the authoritative write boundary. The
  // follow-up payload is scheduler-owned, but a forged internal call could
  // still point it at a Finding from another project or at the producing Job
  // itself. Neither may attach independent evidence.
  if (String(finding.project_id) !== String(job.project_id)) {
    throw invalidVerification("verification.finding_id 不属于当前 Job 所在项目。", "verification.finding_id");
  }
  const [originJob] = await tx`
    SELECT id, project_id FROM jobs WHERE id = ${finding.job_id}`;
  if (!originJob || String(originJob.project_id) !== String(finding.project_id)) {
    throw invalidVerification("verification.finding_id 的原始 Job 绑定无效。", "verification.finding_id");
  }
  if (finding.job_id && String(finding.job_id) === String(job.id)) {
    throw invalidVerification("验证证据 Job 不能与 Finding 的原始 Job 相同。", "verification.finding_id");
  }
  if (job.finding_id && String(job.finding_id) !== String(ver.finding_id)) {
    throw invalidVerification("当前 Job 绑定的 Finding 与 verification.finding_id 不一致。", "verification.finding_id");
  }

  // 确认 finding 属于当前画布
  const [fn] = await tx`
    SELECT canvas_id FROM canvas_nodes WHERE id = ${finding.node_id as string}`;
  if (!fn || fn.canvas_id !== canvasId) {
    throw invalidVerification("verification.finding_id 不属于当前任务画布。", "verification.finding_id");
  }

  const [evidenceNode] = await tx`
    SELECT id, canvas_id, job_id FROM canvas_nodes WHERE id = ${nodeId} FOR UPDATE`;
  if (!evidenceNode || evidenceNode.canvas_id !== canvasId || String(evidenceNode.job_id) !== String(job.id)) {
    throw invalidVerification("验证事实节点不属于当前 Job/Canvas。", "verification");
  }

  const edgeType = ver.evidence_kind === "review" ? "reviewed_by" : "tested_by";
  const updated = await tx`
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
    WHERE id = ${nodeId} AND job_id = ${job.id as string} AND canvas_id = ${canvasId}
    RETURNING id`;
  if (updated.length === 0) throw invalidVerification("验证事实节点不存在，证据未附着。", "verification");

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
 * 该范围同时用于自动 Verify 和收敛门；info 是现有配置中的全量严格模式。
 */
export async function careSeverityMeta(
  tx: Tx,
  projectId: string,
): Promise<{ careSeverities: string[]; minVerifySeverity: string }> {
  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  return {
    careSeverities: careSeverities(rules.minVerifySeverity).map((s) => s.toLowerCase()),
    minVerifySeverity: rules.minVerifySeverity,
  };
}

/**
 * @deprecated 名称易误解。请用 canvasFindingsConverged；保留别名以免外部误用旧语义。
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
 * 阈值范围内每条 Finding 的 verify_status ∈ {confirmed, needs_human}；
 * confirmed 须有可追溯 verification round；无未关闭 round。
 * 低于 minVerifySeverity 的 Finding 保持 pending 并由策略标记，不阻塞门。
 */
export async function canvasFindingsConverged(
  tx: Tx,
  canvasId: string,
  opts?: { projectId?: string; requireCareConfirmed?: boolean },
): Promise<{ ok: boolean; blockers: string[]; problems: FindingStatusProblem[] }> {
  // requireCareConfirmed 已废弃：阈值内 needs_human 仍是可报告终态。
  const projectId = opts?.projectId ?? (await tx`SELECT project_id FROM canvases WHERE id = ${canvasId}`)[0]?.project_id;
  const rules = projectId
    ? await rulesForProject(tx as unknown as typeof sql, String(projectId))
    : null;
  const minVerifySeverity = rules?.minVerifySeverity ?? "high";

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

    if (!isSeverityInVerifyScope(minVerifySeverity, sev)) continue;

    if (st !== "confirmed" && st !== "needs_human") {
      blockers.push(`finding:${f.id}:${st}`);
      problems.push({
        finding_id: f.id as string,
        title: String(f.title ?? ""),
        severity: sev,
        verify_status: st,
        issue: `Finding 未收敛（须 confirmed 或 needs_human，当前 ${st}）`,
        in_care_scope: true,
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
          in_care_scope: true,
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
          in_care_scope: true,
        });
      }
    }
  }

  const careSeveritiesForRounds = careSeverities(minVerifySeverity);
  const openRounds = await tx`
    SELECT r.id, r.finding_id, f.title, f.severity, f.verify_status FROM finding_verification_rounds r
    JOIN findings f ON f.id = r.finding_id
    JOIN jobs j ON j.id = f.job_id
    WHERE j.canvas_id = ${canvasId}
      AND r.status IN ('pending','running')
      AND (
        f.severity IS NULL
        OR NOT (lower(f.severity) = ANY(${SEVERITY_RANK as readonly string[]}))
        OR lower(f.severity) = ANY(${careSeveritiesForRounds})
      )
    LIMIT 5`;
  for (const r of openRounds) {
    blockers.push(`open_round:${r.id}`);
    if (!problems.some((problem) => problem.finding_id === r.finding_id)) {
      problems.push({
        finding_id: r.finding_id as string,
        title: String(r.title ?? ""),
        severity: String(r.severity ?? "").toLowerCase(),
        verify_status: String(r.verify_status ?? ""),
        issue: "Finding 仍有未关闭的 verification round",
        in_care_scope: true,
      });
    }
  }

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
 * - 阈值范围内 Finding ∈ {confirmed, needs_human}（含 human blocker 校验）
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

export async function markFindingNeedsHuman(
  tx: Tx,
  findingId: string,
  reason: string,
  options: { requireWaitingHumanHub?: boolean } = {},
): Promise<boolean> {
  const [origin] = await tx`
    SELECT f.id, f.project_id, f.node_id, f.verify_status,
           origin.project_id AS origin_project_id, origin.canvas_id AS origin_canvas_id
    FROM findings f
    JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
    WHERE f.id = ${findingId}`;
  if (!origin || origin.verify_status === "confirmed") return false;
  const canvasId = (origin.origin_canvas_id as string | null) ?? null;
  const [finding] = await tx`
    SELECT f.id, f.node_id, f.verify_status, f.project_id,
           origin.project_id AS origin_project_id, origin.canvas_id AS origin_canvas_id
    FROM findings f
    JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
    WHERE f.id = ${findingId}
    FOR UPDATE`;
  if (
    !finding ||
    finding.verify_status === "confirmed" ||
    finding.project_id !== finding.origin_project_id ||
    finding.origin_canvas_id !== canvasId
  ) return false;
  if (options.requireWaitingHumanHub) {
    const [waitingHub] = await tx`
      SELECT id
      FROM jobs
      WHERE canvas_id = ${canvasId as string}
        AND status = 'waiting_human'
        AND type = 'hub_reason'
      LIMIT 1`;
    if (!waitingHub) return false;
  }
  // 等待证据的轮次没有可收口 Job；人工接管 Finding 时显式关闭它，
  // 避免收敛门继续被该轮次阻塞。
  await tx`
    UPDATE finding_verification_rounds SET
      status = 'needs_human', final_outcome = 'needs_human',
      error = ${reason}, finished_at = COALESCE(finished_at, now())
    WHERE finding_id = ${findingId} AND status IN ('pending','running')`;
  await setFindingStatus(tx, findingId, "needs_human", finding.node_id as string | null);
  if (canvasId) {
    await ensureHumanBlocker(tx, canvasId, findingId, finding.node_id as string | null, {
      reason,
      summary: reason,
    });
  }
  return true;
}

/**
 * 标记低于自动 Verify 阈值的 Finding。schema/shared-types 没有
 * skipped/ignored 状态，因此保留合法 pending；该策略标记供图和报告
 * 解释，收敛门按同一阈值跳过它。
 */
async function markFindingBelowMinVerifySeverity(
  tx: Tx,
  findingId: string,
  minVerifySeverity: string,
) {
  const [finding] = await tx`
    SELECT id, node_id, verify_status
    FROM findings
    WHERE id = ${findingId}
    FOR UPDATE`;
  if (!finding || finding.verify_status === "confirmed" || finding.verify_status === "needs_human") return;

  await tx`
    UPDATE finding_verification_rounds
    SET status = 'failed', final_outcome = NULL,
        error = 'below_min_verify_severity', finished_at = COALESCE(finished_at, now())
    WHERE finding_id = ${findingId} AND status IN ('pending', 'running')`;
  await tx`
    UPDATE findings SET
      verify_status = 'pending',
      raw_json = raw_json || ${tx.json({
        verification_state: {
          eligibility: "below_min_verify_severity",
          min_verify_severity: minVerifySeverity,
          updated_at: new Date().toISOString(),
        },
      } as never)},
      updated_at = now()
    WHERE id = ${findingId}`;
  if (finding.node_id) {
    await tx`
      UPDATE canvas_nodes SET status = 'open', updated_at = now()
      WHERE id = ${finding.node_id as string}`;
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
  await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
    auto_stopped: false,
    paused_reason: undefined,
    paused_at: undefined,
  });
}

/** 导出给 graph 的 Finding 验证摘要 */
/**
 * Batch Finding verification summaries for graph projections.
 * Findings, latest rounds and evidence nodes are loaded in three queries.
 */
export async function findingVerificationSummaries(
  tx: Tx,
  findingIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(findingIds.filter((id) => typeof id === "string" && id.trim()))];
  const result = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return result;
  const findings = await tx`
    SELECT id, verify_status, job_id, raw_json
    FROM findings WHERE id = ANY(${ids as unknown as string[]}::uuid[])`;
  const rounds = await tx`
    SELECT DISTINCT ON (finding_id)
      finding_id, attempt, status, final_outcome, proposed_verdict, verify_job_id,
      requirements_json, summary, error
    FROM finding_verification_rounds
    WHERE finding_id = ANY(${ids as unknown as string[]}::uuid[])
    ORDER BY finding_id, attempt DESC`;
  const evidenceRows = await tx`
    SELECT n.id, n.job_id, n.body_json, n.title, j.type AS job_type, j.status AS job_status
    FROM canvas_nodes n
    JOIN jobs j ON j.id = n.job_id
    WHERE n.node_type = 'fact'
      AND n.body_json ? 'verification'
      AND n.body_json->'verification'->>'finding_id' = ANY(${ids as unknown as string[]}::text[])
      AND j.status = 'succeeded'`;
  const roundByFinding = new Map(rounds.map((row) => [String(row.finding_id), row]));
  const evidenceByFinding = new Map<string, EvidenceNodeRow[]>();
  for (const row of evidenceRows) {
    const body = (row.body_json ?? {}) as Record<string, unknown>;
    const findingId = String(((body.verification ?? {}) as Record<string, unknown>).finding_id ?? "");
    if (!findingId) continue;
    const list = evidenceByFinding.get(findingId) ?? [];
    list.push(row as EvidenceNodeRow);
    evidenceByFinding.set(findingId, list);
  }
  for (const finding of findings) {
    const findingId = String(finding.id);
    const round = roundByFinding.get(findingId);
    const evidence = buildEvidenceSnapshot(evidenceByFinding.get(findingId) ?? [], (finding.job_id as string) ?? null);
    const state = ((finding.raw_json as Record<string, unknown> | undefined)?.verification_state as Record<string, unknown> | undefined) ?? {};
    const requirements = (round?.requirements_json as Record<string, unknown> | undefined) ?? {};
    result.set(findingId, {
      verify_status: finding.verify_status ?? "pending",
      eligibility: state.eligibility ?? requirements.eligibility ?? (round?.verify_job_id ? "eligible" : "waiting_evidence"),
      verification_attempt: round?.attempt ?? 0,
      latest_outcome: round?.final_outcome ?? round?.status ?? null,
      proposed_verdict: round?.proposed_verdict ?? null,
      missing_evidence: evidence.missing,
      review_evidence_ids: evidence.review.map((item) => item.node_id),
      test_evidence_ids: evidence.test.map((item) => item.node_id),
      conflicting_evidence_ids: evidence.conflicting_node_ids,
      summary: round?.summary ?? null,
      error: round?.error ?? null,
    });
  }
  return result;
}

/** Single-Finding compatibility wrapper backed by the batch implementation. */
export async function findingVerificationSummary(
  tx: Tx,
  findingId: string,
): Promise<Record<string, unknown>> {
  return (
    (await findingVerificationSummaries(tx, [findingId])).get(findingId) ?? {
      verify_status: "pending",
      verification_attempt: 0,
      latest_outcome: null,
      missing_evidence: ["independent_review", "runtime_test"],
      review_evidence_ids: [],
      test_evidence_ids: [],
      conflicting_evidence_ids: [],
    }
  );
}

void TERMINAL_JOB;
