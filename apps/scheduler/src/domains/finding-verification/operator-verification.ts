import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { FindingInconclusiveBody, FindingVerificationControl } from "@deepsonar/shared-types";
import { recordDurableAudit } from "../../audit.js";
import { lockCanvasForConvergence } from "../../core.js";
import { sql } from "../../db.js";
import { collectEvidenceSnapshot, factFirstRecordsFromSnapshot, resolveFindingSubjectRevision } from "../../verify.js";
import { redactJobHumanRequestText } from "../job-control/job-human-request.js";

/** 调用方已持有同 scope Canvas/Finding 锁，状态和轮次必须一起读取。 */
async function readVerificationControl(db: typeof sql, finding: Record<string, unknown>): Promise<FindingVerificationControl> {
  const [latest] = await db`
    SELECT id FROM finding_verification_rounds WHERE finding_id = ${String(finding.id)}
    ORDER BY attempt DESC LIMIT 1`;
  const evidence = await collectEvidenceSnapshot(db, String(finding.id), String(finding.job_id));
  return {
    verify_status: String(finding.verify_status),
    subject_revision: resolveFindingSubjectRevision(finding, factFirstRecordsFromSnapshot(evidence)),
    latest_round_id: latest ? String(latest.id) : null,
  };
}

export async function readFindingVerificationSnapshot(id: string) {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as typeof sql;
    const [origin] = await tx`
      SELECT j.canvas_id FROM findings f JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      WHERE f.id = ${id}`;
    if (!origin) return null;
    const canvasId = origin.canvas_id ? String(origin.canvas_id) : null;
    if (canvasId && !(await lockCanvasForConvergence(tx, canvasId))) return null;
    const [finding] = await tx`
      SELECT f.*, p.name AS project_name, j.canvas_id, j.type AS source_job_type,
        j.status AS source_job_status, c.title AS canvas_title,
        EXISTS (SELECT 1 FROM jobs waiting_job WHERE waiting_job.canvas_id = j.canvas_id
          AND waiting_job.status = 'waiting_human' AND waiting_job.type = 'hub_reason') AS has_waiting_human
      FROM findings f JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
      WHERE f.id = ${id} AND j.canvas_id IS NOT DISTINCT FROM ${canvasId}::text FOR UPDATE OF f`;
    if (!finding) return null;
    return { finding, control: canvasId ? await readVerificationControl(tx, finding) : null };
  });
}

function conflict(error_code: string, error: string) {
  return { status: 409, body: { error_code, error } };
}

/** Canvas 锁串行化管理动作与验证收敛，轮次保存幂等结果，审计失败回滚整笔。 */
export async function closeFindingInconclusive(req: FastifyRequest, id: string, input: FindingInconclusiveBody) {
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as typeof sql;
    const [origin] = await tx`
      SELECT j.canvas_id FROM findings f JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      WHERE f.id = ${id}`;
    if (!origin) return { status: 404, body: { error_code: "FINDING_NOT_FOUND", error: "Finding 不存在" } };
    const canvasId = String(origin.canvas_id ?? "");
    if (!canvasId || !(await lockCanvasForConvergence(tx, canvasId))) {
      return conflict("FINDING_CANVAS_INVALID", "Finding 缺少有效画布");
    }
    const [finding] = await tx`
      SELECT f.* FROM findings f JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      WHERE f.id = ${id} AND j.canvas_id = ${canvasId} FOR UPDATE OF f`;
    if (!finding) return { status: 404, body: { error_code: "FINDING_NOT_FOUND", error: "Finding 不存在" } };
    const actor = { type: req.actor?.type ?? "anonymous", id: req.actor?.id ?? req.actor?.name ?? "anonymous" };
    const reason = String(redactJobHumanRequestText(input.reason));
    const reasonDigest = createHash("sha256").update(input.reason).digest("hex");
    const mutation = { reason, reason_sha256: reasonDigest, expected: input.expected, actor };
    const [previous] = await tx`
      SELECT id, requirements_json FROM finding_verification_rounds
      WHERE finding_id = ${id} AND requirements_json->'operator_decision'->>'mutation_id' = ${input.mutation_id}
      LIMIT 1`;
    if (previous) {
      const decision = previous.requirements_json.operator_decision;
      // 比较明确字段，避免 JSON 对象键顺序影响重试。
      if (decision.reason_sha256 !== reasonDigest || decision.actor.type !== actor.type || decision.actor.id !== actor.id
        || decision.expected.verify_status !== input.expected.verify_status
        || decision.expected.subject_revision !== input.expected.subject_revision
        || decision.expected.latest_round_id !== input.expected.latest_round_id) {
        return conflict("FINDING_MUTATION_CONFLICT", "同一个操作编号已用于另一项决定");
      }
      return { status: 200, body: decision.result };
    }
    const current = await readVerificationControl(tx, finding);
    if (current.verify_status !== input.expected.verify_status
      || current.subject_revision !== input.expected.subject_revision
      || current.latest_round_id !== input.expected.latest_round_id) {
      return conflict("FINDING_VERIFICATION_STALE", "技术状态、对象版本或验证轮次已变化，请刷新后重新决定");
    }
    if (current.verify_status !== "needs_human") {
      return conflict("FINDING_VERIFY_STATUS_NOT_CHANGEABLE", "仅等待人工决定的 Finding 可结束为无定论");
    }
    const jobs = await tx`
      SELECT id, status FROM jobs WHERE finding_id = ${id} OR id = ${String(finding.job_id)} FOR UPDATE`;
    if (jobs.some((job) => ["pending", "claimed", "provisioning", "running", "waiting_human"].includes(String(job.status)))) {
      return conflict("FINDING_VERIFICATION_ACTIVE", "该 Finding 仍有活动执行，请先处理当前执行");
    }
    const unresolved = await tx`
      SELECT e.id FROM job_attempt_effects e JOIN jobs j ON j.id = e.job_id
      WHERE (j.finding_id = ${id} OR j.id = ${String(finding.job_id)})
        AND e.status IN ('effect_pending','unknown') FOR UPDATE OF e`;
    if (unresolved.length) return conflict("FINDING_EFFECT_UNRESOLVED", "执行效果尚未对账，当前不能人工结束验证");
    const activeAttempts = await tx`
      SELECT a.id FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE (j.finding_id = ${id} OR j.id = ${String(finding.job_id)}) AND a.status IN ('active','unknown')
      FOR UPDATE OF a`;
    if (activeAttempts.length) return conflict("FINDING_VERIFICATION_ACTIVE", "该 Finding 的执行尚未可靠结束");
    const rounds = await tx`
      SELECT id, attempt, status FROM finding_verification_rounds WHERE finding_id = ${id} ORDER BY attempt DESC FOR UPDATE`;
    if (rounds.some((round) => ["pending", "running"].includes(String(round.status)))) {
      return conflict("FINDING_VERIFICATION_ACTIVE", "仍有未结束的验证轮次，请先处理当前轮次");
    }
    const [round] = await tx`
      INSERT INTO finding_verification_rounds
        (finding_id, attempt, status, final_outcome, summary, finished_at)
      VALUES (${id}, ${Number(rounds[0]?.attempt ?? 0) + 1}, 'inconclusive', 'inconclusive', ${reason}, now())
      RETURNING id`;
    const result = { finding_id: id, verify_status: "inconclusive", round_id: String(round.id), mutation_id: input.mutation_id };
    await tx`
      UPDATE finding_verification_rounds SET requirements_json = ${tx.json({
        operator_decision: { ...mutation, mutation_id: input.mutation_id, result },
      })}, evidence_snapshot_json = ${tx.json({ subject_revision: current.subject_revision, source_round_id: current.latest_round_id })}
      WHERE id = ${String(round.id)}`;
    await tx`
      UPDATE findings SET verify_status = 'inconclusive', updated_at = now(),
        raw_json = jsonb_set(COALESCE(raw_json, '{}'::jsonb), '{verification_state}',
          COALESCE(raw_json->'verification_state', '{}'::jsonb) || ${tx.json({
            eligibility: "inconclusive", reason: "operator_inconclusive", subject_revision: current.subject_revision,
            operator_round_id: String(round.id), updated_at: new Date().toISOString(),
          })}) WHERE id = ${id}`;
    if (finding.node_id) await tx`UPDATE canvas_nodes SET status = 'inconclusive', updated_at = now() WHERE id = ${String(finding.node_id)}`;
    await tx`
      UPDATE canvas_nodes SET status = 'closed', updated_at = now(),
        body_json = body_json || ${tx.json({ resolved_by_round_id: String(round.id) })}
      WHERE canvas_id = ${canvasId} AND node_type = 'human'
        AND body_json->>'kind' = 'verification_blocker' AND body_json->>'finding_id' = ${id}`;
    await recordDurableAudit(req, {
      action: "finding.verify_status.inconclusive", projectId: String(finding.project_id), resourceType: "finding", resourceId: id,
      before: current, after: { ...result, actor_id: actor.id, subject_revision: current.subject_revision, reason },
    }, tx);
    return { status: 200, body: result };
  });
}
