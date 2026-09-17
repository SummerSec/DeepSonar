/**
 * Attach structured verification Fact evidence to a Finding (#399 / #577).
 */
import { VerificationEvidence, type VerificationEvidence as VerificationEvidenceType } from "@deepsonar/shared-types";
import { invalidVerification } from "./control-input.js";
import type { sql } from "./db.js";

type Tx = typeof sql;

async function insertEdgeIfAbsent(tx: Tx, canvasId: string, fromId: string, toId: string, edgeType: string): Promise<void> {
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

  // 补证 Job 仍要求角色与 evidence_kind 一致；其它工作角色可提交结构化 verification Fact。
  const jobType = String(job.type ?? "");
  const payload = (job.payload_json ?? {}) as Record<string, unknown>;
  const vf = payload.verification_followup as { finding_id?: string } | undefined;
  if (vf?.finding_id) {
    if (jobType !== ver.evidence_kind) {
      throw invalidVerification(
        `verification.evidence_kind=${ver.evidence_kind} 与当前角色 ${jobType} 不匹配。`,
        "verification.evidence_kind",
      );
    }
    if (vf.finding_id !== ver.finding_id) {
      throw invalidVerification(
        "verification.finding_id 必须匹配当前 Scheduler 绑定的补证 Finding。",
        "verification.finding_id",
      );
    }
  } else if (["hub_reason", "verify_finding", "verify", "report"].includes(jobType)) {
    throw invalidVerification("系统 Job 不能提交 Finding 验证 Fact。", "verification");
  }

  const [finding] = await tx`
    SELECT id, node_id, project_id, job_id, raw_json FROM findings WHERE id = ${ver.finding_id}`;
  if (!finding?.node_id) {
    throw invalidVerification("verification.finding_id 不存在或尚未生成 Finding 节点。", "verification.finding_id");
  }
  const frozenRevision = String(
    (((finding.raw_json as Record<string, unknown> | undefined)?.verification_state as Record<string, unknown> | undefined)
      ?.subject_revision as string | undefined) ?? "",
  ).trim();
  if (frozenRevision && ver.subject_revision.trim() !== frozenRevision) {
    throw invalidVerification(
      `verification.subject_revision 必须与已冻结值完全一致（${frozenRevision}）。`,
      "verification.subject_revision",
    );
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
        runtime_digest: ver.runtime_digest ?? null,
        exit_code: typeof ver.exit_code === "number" ? ver.exit_code : null,
        limitations: ver.limitations ?? [],
        source_job_id: String(job.id),
        source_role: String(job.type),
      },
    })}
    WHERE id = ${nodeId} AND job_id = ${job.id as string} AND canvas_id = ${canvasId}
    RETURNING id`;
  if (updated.length === 0) throw invalidVerification("验证事实节点不存在，证据未附着。", "verification");

  await insertEdgeIfAbsent(tx, canvasId, finding.node_id as string, nodeId, edgeType);
  const [findingState] = await tx`SELECT raw_json FROM findings WHERE id = ${ver.finding_id}`;
  const state = ((findingState?.raw_json as Record<string, unknown> | undefined)?.verification_state as Record<string, unknown> | undefined) ?? {};
  if (typeof state.subject_revision !== "string" || !state.subject_revision.trim()) {
    await tx`
      UPDATE findings SET
        raw_json = raw_json || ${tx.json({
          verification_state: { ...state, subject_revision: ver.subject_revision },
        } as never)},
        updated_at = now()
      WHERE id = ${ver.finding_id}`;
  }
  return true;
}
