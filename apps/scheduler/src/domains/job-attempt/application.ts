import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateContextState, type ContextState } from "@deepsonar/runtime-sandbox";
import { CONTROL_INPUT_ERROR_CODES, ControlInputError } from "../../control-input.js";
import { sql } from "../../db.js";
import {
  ATTEMPT_MAX_STATE_BYTES,
  ATTEMPT_MAX_ERROR_CHARS,
  ATTEMPT_MAX_IDENTITY_BYTES,
  ATTEMPT_MAX_OUTCOME_BYTES,
  ATTEMPT_MAX_RESOURCE_BYTES,
  assertBoundedJson,
  buildAttemptState,
  compactAttemptOutcome,
  sanitizeError,
  validateEffectDescriptor,
  type AttemptPhase,
  type AttemptSnapshotIdentity,
  type AttemptState,
  type AttemptStatus,
  type EffectDescriptor,
  type EffectSettlement,
} from "./model.js";

export type AttemptDatabase = typeof sql;
export type AttemptRow = Record<string, unknown>;

function decodeJson(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`${label} 不是合法 JSON`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function stateFromRow(row: AttemptRow): AttemptState {
  const state = decodeJson(row.state_json, "Attempt state") as unknown as AttemptState;
  if (state.version !== 1 || state.attempt_id !== String(row.id) || state.job_id !== String(row.job_id)) {
    throw new Error(`Attempt ${String(row.id)} 的 total state 身份不一致`);
  }
  return state;
}

export async function getActiveAttempt(
  db: AttemptDatabase,
  jobId: string,
  forUpdate = false,
): Promise<AttemptRow | null> {
  const rows = forUpdate
    ? await db`SELECT * FROM job_attempts WHERE job_id = ${jobId} AND status = 'active' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`
    : await db`SELECT * FROM job_attempts WHERE job_id = ${jobId} AND status = 'active' ORDER BY attempt_no DESC LIMIT 1`;
  return rows[0] ? (rows[0] as AttemptRow) : null;
}

export async function createAttempt(
  db: AttemptDatabase,
  jobId: string,
  snapshotIdentity: AttemptSnapshotIdentity = {},
  resourceLabels: Record<string, string> = {},
): Promise<AttemptRow> {
  assertBoundedJson(snapshotIdentity, "snapshot_identity", ATTEMPT_MAX_IDENTITY_BYTES);
  assertBoundedJson(resourceLabels, "resource_labels", ATTEMPT_MAX_RESOURCE_BYTES);
  const [job] = await db`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  if (!job) throw new Error(`Job ${jobId} 不存在，无法创建 Attempt`);
  const active = await getActiveAttempt(db, jobId, true);
  if (active) return active;
  const [last] = await db`SELECT COALESCE(MAX(attempt_no), 0)::int AS attempt_no FROM job_attempts WHERE job_id = ${jobId}`;
  const attemptNo = Number(last?.attempt_no ?? 0) + 1;
  const id = randomUUID();
  const state = buildAttemptState({
    attemptId: id,
    jobId,
    attemptNo,
    snapshotIdentity,
    resourceLabels,
  });
  const [row] = await db`
    INSERT INTO job_attempts ${db({
      id,
      job_id: jobId,
      attempt_no: attemptNo,
      snapshot_identity_json: snapshotIdentity as never,
      state_json: state as never,
      resource_labels_json: resourceLabels as never,
      started_at: new Date(),
    })}
    RETURNING *`;
  if (!row) throw new Error(`Job ${jobId} 创建 Attempt 失败`);
  return row as AttemptRow;
}

export async function createOrGetActiveAttempt(
  db: AttemptDatabase,
  jobId: string,
  snapshotIdentity: AttemptSnapshotIdentity = {},
  resourceLabels: Record<string, string> = {},
): Promise<AttemptRow> {
  return createAttempt(db, jobId, snapshotIdentity, resourceLabels);
}

async function updateState(
  db: AttemptDatabase,
  attemptId: string,
  patch: Partial<AttemptState> & { phase?: AttemptPhase },
  statePatch: Record<string, unknown> = {},
): Promise<AttemptRow | null> {
  const [row] = await db`SELECT * FROM job_attempts WHERE id = ${attemptId} FOR UPDATE`;
  if (!row) return null;
  const current = stateFromRow(row as AttemptRow);
  if (patch.session_id !== undefined && current.session_id !== null && patch.session_id !== current.session_id) {
    throw new Error("Attempt session_id 已绑定，禁止切换会话");
  }
  if (patch.session_file !== undefined && current.session_file !== null && patch.session_file !== current.session_file) {
    throw new Error("Attempt session_file 已绑定，禁止切换会话文件");
  }
  const next = { ...current, ...patch, ...statePatch } as AttemptState;
  assertBoundedJson(next, "attempt state", ATTEMPT_MAX_STATE_BYTES);
  const [updated] = await db`
    UPDATE job_attempts SET
      phase = ${next.phase},
      cancel_requested = ${next.cancel_requested},
      cancel_requested_at = CASE WHEN ${next.cancel_requested} THEN COALESCE(cancel_requested_at, now()) ELSE cancel_requested_at END,
      sandbox_id = ${next.sandbox_id},
      session_id = ${next.session_id},
      state_json = ${db.json(next as never)},
      updated_at = now()
    WHERE id = ${attemptId} AND status = 'active'
    RETURNING *`;
  return updated ? (updated as AttemptRow) : null;
}

export async function beginEffect(db: AttemptDatabase, attemptId: string, descriptor: EffectDescriptor): Promise<AttemptRow | null> {
  const normalized = validateEffectDescriptor(descriptor);
  const [attempt] = await db`SELECT * FROM job_attempts WHERE id = ${attemptId} FOR UPDATE`;
  if (!attempt || attempt.status !== "active") return null;
  const state = stateFromRow(attempt as AttemptRow);
  if (state.cancel_requested) throw new Error("Attempt 已持久化取消，禁止启动新的外部效果");
  const [effect] = await db`
    INSERT INTO job_attempt_effects ${db({
      attempt_id: attemptId,
      job_id: attempt.job_id,
      effect_id: normalized.effectId,
      effect_kind: normalized.kind,
      step: normalized.step,
      replay_policy: normalized.replayPolicy,
      status: "effect_pending",
      input_digest: normalized.inputDigest ?? null,
      resource_identity_json: normalized.resourceIdentity as never,
      intent_json: normalized.intent as never,
      effect_started_at: new Date(),
    })}
    ON CONFLICT (attempt_id, effect_id) DO NOTHING
    RETURNING id`;
  if (!effect) {
    const [existing] = await db`SELECT status FROM job_attempt_effects WHERE attempt_id = ${attemptId} AND effect_id = ${normalized.effectId}`;
    if (existing?.status === "settled") return attempt as AttemptRow;
    throw new Error(`效果 ${normalized.effectId} 已存在且未收口`);
  }
  // 投递和模型请求可以在 Agent 主执行期间并发发生，只记录各自效果，
  // 不覆盖 Attempt 主程序计数器和 current_effect_id。
  if (normalized.kind === "canvas_delivery" || normalized.kind === "gateway_model_request") {
    return attempt as AttemptRow;
  }
  const nextPhase: AttemptPhase = normalized.kind === "provision" ? "provision.effect_pending" : "agent.effect_pending";
  return updateState(db, attemptId, { phase: nextPhase, current_effect_id: normalized.effectId }, {
    current_effect_id: normalized.effectId,
  });
}

export async function settleEffect(
  db: AttemptDatabase,
  attemptId: string,
  effectId: string,
  settlement: EffectSettlement,
): Promise<AttemptRow | null> {
  const error = settlement.error ? sanitizeError(settlement.error) : null;
  if (error && error.length > ATTEMPT_MAX_ERROR_CHARS) throw new Error("effect error 超出长度限制");
  const outcome = settlement.outcome ?? {};
  assertBoundedJson(outcome, "effect settlement", 8 * 1024);
  const [effect] = await db`
    UPDATE job_attempt_effects SET
      status = ${settlement.status},
      settlement_json = ${db.json(outcome as never)},
      error = ${error},
      evidence_ref = ${settlement.evidenceRef ?? null},
      settled_at = now(),
      updated_at = now()
    WHERE attempt_id = ${attemptId} AND effect_id = ${effectId}
      AND status = 'effect_pending'
    RETURNING effect_kind`;
  if (!effect) return getActiveAttempt(db, String((await db`SELECT job_id FROM job_attempts WHERE id = ${attemptId}`)[0]?.job_id ?? ""));
  if (effect.effect_kind === "canvas_delivery" || effect.effect_kind === "gateway_model_request") {
    return getActiveAttempt(db, String((await db`SELECT job_id FROM job_attempts WHERE id = ${attemptId}`)[0]?.job_id ?? ""));
  }
  const nextPhase: AttemptPhase = effect.effect_kind === "provision" && settlement.status === "settled"
    ? "provisioned"
    : settlement.status === "unknown"
      ? "unknown"
      : "settling";
  return updateState(db, attemptId, { phase: nextPhase, current_effect_id: null }, {
    current_effect_id: null,
    last_effect: { effect_id: effectId, status: settlement.status },
  });
}

export async function markEffectUnknown(
  db: AttemptDatabase,
  attemptId: string,
  effectId: string,
  error: unknown,
): Promise<AttemptRow | null> {
  return settleEffect(db, attemptId, effectId, {
    status: "unknown",
    error: sanitizeError(error),
    outcome: { result: "unknown_effect" },
  });
}

export async function updateAttemptResource(
  db: AttemptDatabase,
  attemptId: string,
  resource: { sandboxId?: string | null; sessionId?: string | null; phase?: AttemptPhase },
): Promise<AttemptRow | null> {
  const patch: Partial<AttemptState> & { phase?: AttemptPhase } = {};
  if (resource.phase !== undefined) patch.phase = resource.phase;
  if (resource.sandboxId !== undefined) {
    patch.sandbox_id = resource.sandboxId === null ? null : String(resource.sandboxId).slice(0, 255);
  }
  if (resource.sessionId !== undefined) {
    patch.session_id = resource.sessionId === null ? null : String(resource.sessionId).slice(0, 255);
  }
  return updateState(db, attemptId, patch);
}

export async function updateAttemptSession(
  db: AttemptDatabase,
  attemptId: string,
  session: { sessionId: string; sessionFile?: string },
): Promise<AttemptRow | null> {
  const sessionId = String(session.sessionId).trim();
  if (!sessionId || sessionId.length > 255) throw new Error("Attempt session_id 格式非法或超出长度限制");
  const sessionFile = session.sessionFile === undefined ? undefined : String(session.sessionFile).trim();
  if (sessionFile !== undefined && (
    !sessionFile.startsWith("/workspace/")
    || path.posix.normalize(sessionFile) !== sessionFile
    || sessionFile.length > 1024
  )) {
    throw new Error("Attempt session_file 必须是 workspace 内的有界绝对路径");
  }
  return updateState(db, attemptId, {
    session_id: sessionId,
    ...(sessionFile === undefined ? {} : { session_file: sessionFile }),
  });
}

export async function updateAttemptContext(
  db: AttemptDatabase,
  attemptId: string,
  context: ContextState,
): Promise<AttemptRow | null> {
  validateContextState(context);
  const [row] = await db`SELECT * FROM job_attempts WHERE id = ${attemptId} FOR UPDATE`;
  if (!row) return null;
  const current = stateFromRow(row as AttemptRow);
  const next = { ...current, runtime_context: context } satisfies AttemptState;
  assertBoundedJson(next, "attempt state", ATTEMPT_MAX_STATE_BYTES);
  const [updated] = await db`
    UPDATE job_attempts SET state_json = ${db.json(next as never)}, updated_at = now()
    WHERE id = ${attemptId} AND status = 'active'
    RETURNING *`;
  return updated ? (updated as AttemptRow) : null;
}

export async function requestAttemptCancel(
  db: AttemptDatabase,
  jobId: string,
  reason?: string,
): Promise<AttemptRow | null> {
  const [attempt] = await db`SELECT * FROM job_attempts WHERE job_id = ${jobId} AND status = 'active' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  if (!attempt) return null;
  const current = stateFromRow(attempt as AttemptRow);
  const next = {
    ...current,
    cancel_requested: true,
    phase: current.phase === "provision.effect_pending" || current.phase === "agent.effect_pending" ? current.phase : "settling",
    outcome: { ...current.outcome, cancel_reason: sanitizeError(reason ?? "cancelled") },
  } satisfies AttemptState;
  assertBoundedJson(next, "attempt state", ATTEMPT_MAX_STATE_BYTES);
  const [updated] = await db`
    UPDATE job_attempts SET cancel_requested = true, cancel_requested_at = COALESCE(cancel_requested_at, now()),
      state_json = ${db.json(next as never)}, updated_at = now()
    WHERE id = ${attempt.id} AND status = 'active'
    RETURNING *`;
  return updated ? (updated as AttemptRow) : null;
}

export async function settleAttemptTerminal(
  db: AttemptDatabase,
  jobId: string,
  status: AttemptStatus,
  outcome: Record<string, unknown> = {},
  error?: unknown,
): Promise<AttemptRow | null> {
  if (status === "active" || status === "interrupted" || status === "unknown") {
    throw new Error(`Attempt 终态 ${status} 不能通过 terminal 收口`);
  }
  const compacted = compactAttemptOutcome(outcome);
  try {
    assertBoundedJson(compacted, "attempt outcome", ATTEMPT_MAX_OUTCOME_BYTES);
  } catch (boundError) {
    throw new ControlInputError(
      CONTROL_INPUT_ERROR_CODES.invalidDone,
      boundError instanceof Error ? boundError.message : "attempt outcome 超过字节限制",
      typeof outcome.summary === "string" ? "summary" : undefined,
    );
  }
  outcome = compacted;
  const safeError = error ? sanitizeError(error) : null;
  const [attempt] = await db`SELECT * FROM job_attempts WHERE job_id = ${jobId} AND status = 'active' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  if (!attempt) return null;
  const current = stateFromRow(attempt as AttemptRow);
  const nextStatus = status;
  const next = {
    ...current,
    phase: "terminal" as const,
    current_effect_id: null,
    outcome: { ...current.outcome, ...outcome },
  } satisfies AttemptState;
  assertBoundedJson(next, "attempt state", ATTEMPT_MAX_STATE_BYTES);
  // 终态与未收口外部效果必须在调用方同一事务中提交。只有主 Agent run
  // 可由成功终态证明已完成；并发投递/网关效果未显式结算时仍必须 unknown。
  await db`
    UPDATE job_attempt_effects
       SET status = CASE
             WHEN ${status} = 'succeeded' AND effect_kind = 'agent_run' THEN 'settled'
             ELSE 'unknown'
           END,
           settlement_json = ${db.json({ job_status: status } as never)},
           error = COALESCE(error, ${safeError}),
           settled_at = COALESCE(settled_at, now()),
           updated_at = now()
     WHERE attempt_id = ${attempt.id} AND status = 'effect_pending'`;
  const [updated] = await db`
    UPDATE job_attempts SET status = ${nextStatus}, phase = 'terminal', state_json = ${db.json(next as never)}, outcome_json = ${db.json(outcome as never)},
      error = ${safeError}, finished_at = now(), updated_at = now()
    WHERE id = ${attempt.id} AND status = 'active'
    RETURNING *`;
  return updated ? (updated as AttemptRow) : null;
}

export async function markAttemptInterrupted(db: AttemptDatabase, jobId: string, reason: unknown): Promise<AttemptRow | null> {
  const safeReason = sanitizeError(reason);
  const [attempt] = await db`SELECT * FROM job_attempts WHERE job_id = ${jobId} AND status = 'active' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  if (!attempt) return null;
  const current = stateFromRow(attempt as AttemptRow);
  const next = { ...current, phase: "interrupted" as const, current_effect_id: null, outcome: { ...current.outcome, result: "interrupted" } } satisfies AttemptState;
  await db`UPDATE job_attempt_effects SET status = 'unknown', error = COALESCE(error, ${safeReason}), settled_at = now(), updated_at = now() WHERE attempt_id = ${attempt.id} AND status = 'effect_pending'`;
  const [updated] = await db`
    UPDATE job_attempts SET status = 'interrupted', phase = 'interrupted', state_json = ${db.json(next as never)}, outcome_json = ${db.json(next.outcome as never)},
      error = ${safeReason}, finished_at = now(), updated_at = now()
    WHERE id = ${attempt.id} AND status = 'active'
    RETURNING *`;
  return updated ? (updated as AttemptRow) : null;
}
