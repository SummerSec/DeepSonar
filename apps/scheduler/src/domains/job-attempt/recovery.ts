import { createHash } from "node:crypto";
import {
  CompletionRecoveryDecision, CompletionRecoveryGrant, CompletionRecoveryProjection,
  projectCompletionRecovery, type RepairFeedback,
} from "@deepsonar/shared-types";
import { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { canvasExecutionIsPaused } from "../../task-execution-control.js";
import { controlInputDigest } from "../event-ingestion/control-receipt.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";
import { freezeAgentSnapshotNetworkPolicy } from "../role-runtime-snapshot/index.js";

// 2026-11-03: a root gets at most three directed wakes, including failed Hubs.
// This independent hard bound is frozen on first observation; normal Hub/repair budgets still apply.
export const COMPLETION_RECOVERY_WAKE_LIMIT = 3;
export const COMPLETION_RECOVERY_EFFECT_LIMIT = 32;
const subtype = "completion_recovery";
type Job = Record<string, unknown>;
export type CompletionRecoveryState = CompletionRecoveryProjection & {
  authority: "scheduler"; subtype: "completion_recovery"; kind: "state";
  project_id: string; canvas_id: string | null; snapshot_sha256: string;
  stop_reason?: CompletionRecoveryStopRequest["reason"];
};
export interface CompletionRecoveryStopRequest {
  recoveryRef: string; jobId: string; attemptId: string;
  reason: "platform_recovery_stop" | "platform_recovery_deadline" | "platform_recovery_exhausted";
}

export function completionRecoveryIdentity(jobId: string, attemptId: string, identity = "root"): string {
  const hex = createHash("sha256").update(`deepsonar:completion-recovery:v1:${jobId}:${attemptId}:${identity}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The current durable state, not mutable Canvas JSON. Receipts and state events are never rewritten. */
export async function readCompletionRecovery(db: typeof sql, jobId: string, attemptId: string): Promise<CompletionRecoveryState | null> {
  const [row] = await db`SELECT payload_json,job_seq FROM events WHERE job_id=${jobId} AND attempt_id=${attemptId}
    AND type='control_receipt' AND payload_json->>'authority'='scheduler'
    AND payload_json->>'subtype'=${subtype} AND payload_json->>'kind'='state' ORDER BY job_seq DESC LIMIT 1`;
  if (!row) return null;
  const projection = CompletionRecoveryProjection.parse(row.payload_json && projectCompletionRecovery(row.payload_json));
  const raw = row.payload_json as CompletionRecoveryState;
  if (projection.recovery_ref !== completionRecoveryIdentity(jobId, attemptId)
    || projection.target_job_id !== jobId || projection.target_attempt_id !== attemptId
    || projection.recovery_revision !== Number(row.job_seq)) throw new Error("completion recovery identity is invalid");
  const [{ count }] = await db`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'authority'='scheduler' AND payload_json->>'subtype'=${subtype}
    AND payload_json->>'kind'='wake' AND payload_json->>'recovery_ref'=${projection.recovery_ref}`;
  return { ...raw, ...projection, wakes_used: Number(count) };
}

export async function readCompletionRecoveryProjection(db: typeof sql, jobId: string, attemptId: string) {
  const state = await readCompletionRecovery(db, jobId, attemptId);
  return state ? projectCompletionRecovery(state) : undefined;
}

export interface CompletionRecoveryEvidence {
  sha256: string; blocking: CompletionRecoveryProjection["blocking"];
  effects: CompletionRecoveryProjection["effects"]; acceptedEffects: NonNullable<RepairFeedback["accepted_effects"]>;
  acceptedTotal: number; truncated: boolean; remaining: number;
  repairUsageStatus: "known" | "pending" | "unknown" | null;
}

/** Hash ALL scoped evidence in PostgreSQL; only bounded secret-free samples leave it. */
export async function readCompletionRecoveryEvidence(db: typeof sql, job: Job, attemptId: string): Promise<CompletionRecoveryEvidence> {
  const [attempt] = await db`SELECT status,cancel_requested FROM job_attempts WHERE job_id=${String(job.id)} AND id=${attemptId}`;
  const active = attempt?.status === "active" && !attempt.cancel_requested;
  const [counts] = await db`SELECT
    count(*) FILTER (WHERE e.status='unknown')::int AS unknown,
    count(*) FILTER (WHERE e.status='effect_pending' AND NOT
      (${active} AND e.attempt_id=${attemptId} AND e.effect_kind IN ('agent_run','agent_resume')))::int AS pending,
    count(*) FILTER (WHERE e.status='settled')::int AS accepted,
    encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(jsonb_build_array(e.id,e.attempt_id,e.effect_id,e.effect_kind,e.status,
      e.updated_at,e.settlement_json,l.id,l.settlement_status,l.input_tokens,l.output_tokens,l.total_tokens,
      l.cache_read_input_tokens,l.cache_creation_input_tokens,l.adjustment_tokens,l.source,l.observed_at)::text,'UTF8')),'hex'),
      '' ORDER BY e.id),''),'UTF8')),'hex') AS effects_sha256
    FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
      AND l.job_id=e.job_id AND l.project_id=${String(job.project_id)} WHERE e.job_id=${String(job.id)}`;
  const rows = await db`SELECT id,effect_kind,status FROM job_attempt_effects WHERE job_id=${String(job.id)}
    AND (status='unknown' OR (status='effect_pending' AND NOT
      (${active} AND attempt_id=${attemptId} AND effect_kind IN ('agent_run','agent_resume')))) ORDER BY id LIMIT 8`;
  const accepted = await db`SELECT id,status FROM job_attempt_effects WHERE job_id=${String(job.id)} AND status='settled'
    ORDER BY id LIMIT ${COMPLETION_RECOVERY_EFFECT_LIMIT}`;
  const blocking = { unknown: Number(counts.unknown), pending: Number(counts.pending) };
  const size = blocking.unknown + blocking.pending;
  const repairBudget = await readRepairTokenBudget(db, String(job.id));
  return {
    sha256: controlInputDigest({ effects: counts.effects_sha256, job_status: job.status, attempt_id: attemptId,
      attempt_status: attempt?.status, cancel_requested: attempt?.cancel_requested, repair_usage: repairBudget?.usage_status ?? "known",
      snapshot: controlInputDigest(job.agent_snapshot_json), started_at: job.started_at instanceof Date ? job.started_at.toISOString() : job.started_at, timeout_sec: job.timeout_sec }),
    blocking, effects: rows.map(row => ({ effect_ref: String(row.id), effect_kind: String(row.effect_kind), status: row.status as "unknown" | "effect_pending" })),
    acceptedEffects: accepted.map(row => ({ effect_id: String(row.id), status: String(row.status) })),
    acceptedTotal: Number(counts.accepted), truncated: size > rows.length, remaining: Math.max(0, size - rows.length),
    repairUsageStatus: repairBudget?.usage_status ?? null,
  };
}

async function appendState(db: typeof sql, _job: Job, state: CompletionRecoveryState, first = false): Promise<CompletionRecoveryState> {
  const current = first ? null : await readCompletionRecovery(db, state.target_job_id, state.target_attempt_id);
  const comparable = (value: CompletionRecoveryState) => controlInputDigest({ ...value, recovery_revision: 0, wakes_used: 0 });
  if (current && comparable(current) === comparable(state)) return current;
  const eventId = first ? state.recovery_ref : completionRecoveryIdentity(state.target_job_id, state.target_attempt_id,
    `state:${current?.recovery_revision ?? state.recovery_revision}:${state.evidence_sha256}:${state.status}:${state.code}`);
  const [existing] = await db`SELECT payload_json FROM events WHERE job_id=${state.target_job_id} AND event_id=${eventId}`;
  if (existing) return { ...existing.payload_json as CompletionRecoveryState, wakes_used: state.wakes_used };
  const [{ next }] = await db`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${state.target_job_id}`;
  const saved = { ...state, recovery_revision: Number(next) };
  await db`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${state.target_job_id})`;
  await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
    VALUES(${state.target_job_id},${eventId},${next},${state.target_attempt_id},'control_receipt',${db.json(saved as never)})`;
  return saved;
}

/** Canvas-first callers only. This is a reconstructable view, never the authority for recovery. */
export async function projectCompletionRecoveryToCanvas(db: typeof sql, state: CompletionRecoveryState) {
  if (state.canvas_id) await db`UPDATE canvas_nodes SET body_json=body_json || ${db.json({ recovery: projectCompletionRecovery(state) } as never)},updated_at=now()
    WHERE canvas_id=${state.canvas_id} AND job_id=${state.target_job_id} AND node_type='job'
      AND body_json->'recovery' IS DISTINCT FROM ${db.json(projectCompletionRecovery(state) as never)}`;
}

/** Caller already owns Job -> Attempt. This writes no Canvas lock or external action. */
export async function recordCompletionRecovery(db: typeof sql, job: Job, attemptId: string, receiptRef: string,
  code: string, evidence: CompletionRecoveryEvidence): Promise<CompletionRecoveryState> {
  const prior = await readCompletionRecovery(db, String(job.id), attemptId);
  if (prior && ["stop_requested", "closed", "completion_accepted"].includes(prior.status)) return prior;
  const [{ observed_at, deadline }] = await db`SELECT clock_timestamp() AS observed_at,
    started_at+timeout_sec*interval '1 second' AS deadline FROM jobs WHERE id=${String(job.id)}`;
  if (!deadline) throw new Error("completion recovery requires the original execution deadline");
  const state: CompletionRecoveryState = {
    v: 1, authority: "scheduler", subtype, kind: "state", recovery_ref: completionRecoveryIdentity(String(job.id), attemptId),
    target_job_id: String(job.id), target_attempt_id: attemptId, project_id: String(job.project_id),
    canvas_id: (job.canvas_id as string | null) ?? null, snapshot_sha256: controlInputDigest(job.agent_snapshot_json),
    recovery_revision: prior?.recovery_revision ?? 1, evidence_sha256: evidence.sha256,
    status: evidence.blocking.unknown + evidence.blocking.pending > 0 || (evidence.repairUsageStatus !== null && evidence.repairUsageStatus !== "known")
      ? "needed" : "awaiting_completion",
    code, receipt_ref: prior?.receipt_ref ?? receiptRef, first_observed_at: prior?.first_observed_at ?? new Date(observed_at).toISOString(),
    deadline: prior?.deadline ?? new Date(deadline).toISOString(), wake_limit: prior?.wake_limit ?? COMPLETION_RECOVERY_WAKE_LIMIT,
    wakes_used: prior?.wakes_used ?? 0, blocking: evidence.blocking, effects: evidence.effects,
    truncated: evidence.truncated, remaining: evidence.remaining,
  };
  if (prior?.evidence_sha256 === state.evidence_sha256 && prior.status === state.status) return prior;
  return appendState(db, job, state, !prior);
}

export function completionRecoveryFeedback(input: { key: string; revision: number; repairAttempt: number; remainingAttempts: number;
  state: CompletionRecoveryState; evidence: CompletionRecoveryEvidence; remainingTokens: number | null; remainingWallTime: number }): RepairFeedback {
  return {
    v: 1, category: "unknown_external_effect", code: input.state.code, operation: "mark_job_done",
    message: "Completion is blocked by unsettled external effects; no execution or cost is inferred.",
    expected: { recovery_ref: input.state.recovery_ref, recovery_revision: input.state.recovery_revision,
      evidence_sha256: input.state.evidence_sha256, accepted_effects_truncated: input.evidence.acceptedTotal > input.evidence.acceptedEffects.length,
      accepted_effects_remaining: Math.max(0, input.evidence.acceptedTotal - input.evidence.acceptedEffects.length) },
    observed_shape: { type: "object" }, accepted_effects: input.evidence.acceptedEffects,
    idempotency_key: input.key, proposal_revision: input.revision, repair_attempt: input.repairAttempt,
    remaining_budget: { attempts: input.remainingAttempts, wall_time_sec: Math.max(0, input.remainingWallTime),
      ...(input.remainingTokens !== null && input.remainingTokens >= 0 ? { tokens: input.remainingTokens } : {}) },
    current_state_ref: `/control/v1/jobs/${input.state.target_job_id}/operations/mark_job_done?receipt_key=${input.key}`,
    next_action: `读取 recovery 投影，等待受治理 Hub 对账；不要重放外部效果或把 pending 当未执行。原 Attempt 仍活动且证据改变后，用新 key 与 revision ${input.revision + 1} 重新提交合法 done；旧 key 永远保留原结果。`,
  };
}

export async function recordCompletionRecoveryAccepted(db: typeof sql, job: Job, attemptId: string, evidence: CompletionRecoveryEvidence) {
  const state = await readCompletionRecovery(db, String(job.id), attemptId);
  if (state) await appendState(db, job, { ...state, status: "completion_accepted", code: "COMPLETION_PERSISTED_DEFERRED",
    evidence_sha256: evidence.sha256, blocking: evidence.blocking, effects: evidence.effects, truncated: evidence.truncated, remaining: evidence.remaining });
}

/** Scope grant alone is insufficient: every directed wake is an immutable host receipt bound to its Hub. */
export function recoveryGrantForHub(hub: Job, decision: CompletionRecoveryDecision): CompletionRecoveryGrant {
  const trigger = (hub.payload_json as { trigger?: { kind?: string; recovery_refs?: unknown[] } } | undefined)?.trigger;
  if (hub.type !== "hub_reason" || trigger?.kind !== "completion_recovery" || !Array.isArray(trigger.recovery_refs)
    || trigger.recovery_refs.length !== 1) throw new ControlInputError("recovery_not_authorized", "Only a Scheduler-directed recovery Hub may propose recovery", "recovery");
  const parsed = CompletionRecoveryGrant.safeParse(trigger.recovery_refs[0]);
  if (!parsed.success || parsed.data.recovery_ref !== decision.recovery_ref || parsed.data.target_job_id !== decision.target_job_id
    || parsed.data.target_attempt_id !== decision.target_attempt_id || parsed.data.project_id !== hub.project_id
    || parsed.data.canvas_id !== hub.canvas_id || parsed.data.recovery_revision !== decision.expected_recovery_revision
    || parsed.data.evidence_sha256 !== decision.expected_evidence_sha256) {
    throw new ControlInputError("recovery_not_authorized", "Recovery target or evidence is outside this Hub's frozen grant", "recovery");
  }
  return parsed.data;
}

async function assertTargetBinding(db: typeof sql, job: Job) {
  if (!job.canvas_id) throw new ControlInputError("recovery_not_authorized", "Recovery requires a Canvas", "recovery");
  const frozen = job.agent_snapshot_json as Record<string, unknown>;
  let checked: Record<string, unknown>;
  try { checked = await freezeAgentSnapshotNetworkPolicy(db, String(job.canvas_id), frozen); }
  catch { throw new ControlInputError("recovery_not_authorized", "Current target/network authorization is unavailable or invalid", "recovery"); }
  if (controlInputDigest(checked.task_contract) !== controlInputDigest(frozen.task_contract)
    || controlInputDigest(checked.network_policy) !== controlInputDigest(frozen.network_policy)
    || controlInputDigest(checked.target_authorization) !== controlInputDigest(frozen.target_authorization)) {
    throw new ControlInputError("recovery_not_authorized", "Frozen target authorization or network binding changed", "recovery");
  }
  const authorization = checked.target_authorization as { decision_expires_at?: string } | undefined;
  if (authorization && (!authorization.decision_expires_at || Date.parse(authorization.decision_expires_at) <= Date.now())) {
    throw new ControlInputError("recovery_not_authorized", "Frozen target authorization expired", "recovery");
  }
}

/** Pending Hubs have no Attempt or token yet. Only the exact persisted directed wake may ignore its target's busy gate. */
export async function pendingCompletionRecoveryClaimTarget(db: typeof sql, candidate: { id?: unknown }): Promise<string | null> {
  if (typeof candidate.id !== "string") return null;
  const [hub] = await db`SELECT * FROM jobs WHERE id=${candidate.id} AND type='hub_reason' AND status='pending'`;
  const trigger = hub?.payload_json?.trigger;
  if (trigger?.kind !== "completion_recovery" || !Array.isArray(trigger.recovery_refs) || trigger.recovery_refs.length !== 1) return null;
  const parsed = CompletionRecoveryGrant.safeParse(trigger.recovery_refs[0]);
  if (!parsed.success || typeof hub.canvas_id !== "string" || typeof hub.project_id !== "string") return null;
  // Target binding later freezes this Canvas FOR SHARE. Claim's preliminary
  // scan must skip a busy Canvas before that authoritative check can wait.
  const [canvas] = await db`SELECT id FROM canvases WHERE id=${hub.canvas_id} AND project_id=${hub.project_id} FOR SHARE SKIP LOCKED`;
  if (!canvas) return null;
  const grant = parsed.data;
  try {
    await validateCompletionRecoveryDecision(db, hub, { recovery_ref: grant.recovery_ref, target_job_id: grant.target_job_id,
      target_attempt_id: grant.target_attempt_id, expected_recovery_revision: grant.recovery_revision,
      expected_evidence_sha256: grant.evidence_sha256, action: "reconcile_effects", reason: "Scheduler pending claim validation" }, { pendingClaim: true });
    return grant.target_job_id;
  } catch (error) {
    if (error instanceof ControlInputError) return null;
    throw error;
  }
}

/** Read-only preflight or locked final validation; the caller must lock Canvas first when final=true. */
export async function validateCompletionRecoveryDecision(db: typeof sql, hub: Job, raw: unknown,
  options: { final?: boolean; lockTarget?: boolean; tokenId?: string; eventId?: string; pendingClaim?: boolean } = {}) {
  const decision = CompletionRecoveryDecision.parse(raw);
  const locked = options.final || options.lockTarget;
  const grant = recoveryGrantForHub(hub, decision);
  let tokenId = options.tokenId;
  if (options.final) {
    const [receipt] = await db`SELECT payload_json FROM events WHERE job_id=${String(hub.id)} AND type='control_receipt'
      AND payload_json->>'operation'='submit_hub_decision' AND payload_json->>'status'='persisted_deferred'
      AND payload_json->>'idempotency_key'=${options.eventId ?? ""} LIMIT 1`;
    if (!receipt || receipt.payload_json.snapshot_digest !== controlInputDigest(hub.agent_snapshot_json)
      || receipt.payload_json.settlement_digest !== controlInputDigest({ recovery: decision })) {
      throw new ControlInputError("recovery_not_authorized", "Recovery execution requires its matching durable proposal receipt", "recovery");
    }
    tokenId = receipt.payload_json.capability_token_id;
    if (!tokenId || !receipt.payload_json.attempt_id) throw new ControlInputError("recovery_not_authorized", "Recovery receipt has no capability/Attempt binding", "recovery");
    const [receiptAttempt] = await db`SELECT id FROM job_attempts WHERE job_id=${String(hub.id)}
      AND id=${receipt.payload_json.attempt_id} AND status='active' AND NOT cancel_requested FOR UPDATE`;
    if (!receiptAttempt) throw new ControlInputError("recovery_inactive", "The accepted recovery Hub Attempt is no longer current", "recovery");
  }
  if (tokenId) {
    const [token] = await db`SELECT id FROM job_capability_tokens WHERE id=${tokenId} AND job_id=${String(hub.id)}
      AND project_id=${grant.project_id} AND canvas_id=${grant.canvas_id} AND revoked_at IS NULL AND expires_at>clock_timestamp()
      AND snapshot_sha256=${controlInputDigest(hub.agent_snapshot_json)} AND 'submit_hub_decision'=ANY(operation_ids) FOR SHARE`;
    if (!token) throw new ControlInputError("recovery_not_authorized", "Current capability no longer grants this recovery operation", "recovery");
  } else if (options.final) throw new ControlInputError("recovery_not_authorized", "Recovery receipt has no capability binding", "recovery");
  const [canvas] = await db`SELECT status,target_json,target_json->'convergence' AS convergence_json FROM canvases WHERE id=${grant.canvas_id} AND project_id=${grant.project_id}`;
  if (!canvas || canvas.status === "archived" || canvasExecutionIsPaused(canvas.target_json) || canvas.convergence_json?.hub_paused || canvas.convergence_json?.auto_stopped) {
    throw new ControlInputError("recovery_paused", "Recovery cannot bypass Canvas pause or auto-stop", "recovery");
  }
  const targets = locked
    ? await db`SELECT * FROM jobs WHERE id=${grant.target_job_id} FOR UPDATE`
    : await db`SELECT * FROM jobs WHERE id=${grant.target_job_id}`;
  const target = targets[0];
  if (!target || target.project_id !== grant.project_id || target.canvas_id !== grant.canvas_id
    || controlInputDigest(target.agent_snapshot_json) !== grant.snapshot_sha256) {
    throw new ControlInputError("recovery_not_authorized", "Recovery target scope or frozen snapshot changed", "recovery");
  }
  const attempts = locked
    ? await db`SELECT * FROM job_attempts WHERE id=${grant.target_attempt_id} AND job_id=${grant.target_job_id} FOR UPDATE`
    : await db`SELECT * FROM job_attempts WHERE id=${grant.target_attempt_id} AND job_id=${grant.target_job_id}`;
  const attempt = attempts[0];
  const state = await readCompletionRecovery(db, grant.target_job_id, grant.target_attempt_id);
  if (state && (state.project_id !== grant.project_id || state.canvas_id !== grant.canvas_id || state.snapshot_sha256 !== grant.snapshot_sha256)) {
    throw new ControlInputError("recovery_not_authorized", "Durable recovery scope does not match the directed grant", "recovery");
  }
  if (!state || state.recovery_revision !== decision.expected_recovery_revision || state.evidence_sha256 !== decision.expected_evidence_sha256) {
    throw new ControlInputError("recovery_stale", "Recovery revision or evidence changed; read the current projection", "recovery");
  }
  if (state.status !== "needed" || !attempt || attempt.status !== "active" || attempt.cancel_requested
    || !["running", "waiting_human"].includes(String(target.status)) || Date.parse(state.deadline) <= Date.now()) {
    throw new ControlInputError("recovery_inactive", "Recovery cannot revive an exited, cancelled, terminal or expired execution", "recovery");
  }
  const [lease] = await db`SELECT id FROM jobs WHERE id=${grant.target_job_id} AND lease_expires_at>clock_timestamp()
    AND started_at+timeout_sec*interval '1 second'>clock_timestamp()`;
  if (!lease) throw new ControlInputError("recovery_inactive", "Original execution lease or deadline expired", "recovery");
  const [human] = await db`SELECT payload_json FROM events WHERE job_id=${grant.target_job_id} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
  if (target.status === "waiting_human" && human?.payload_json?.subject?.type !== "platform_blocker") {
    throw new ControlInputError("recovery_paused", "A real human decision remains authoritative", "recovery");
  }
  await assertTargetBinding(db, target);
  await assertTargetBinding(db, hub);
  const repairBudget = await readRepairTokenBudget(db, grant.target_job_id);
  if (repairBudget && repairBudget.attempt_id !== grant.target_attempt_id) {
    throw new ControlInputError("recovery_inactive", "Another Attempt cannot take over the frozen repair budget", "recovery");
  }
  const [root] = await db`SELECT e.event_id FROM events e JOIN event_dedup d ON d.event_id=e.event_id AND d.job_id=e.job_id
    WHERE e.job_id=${grant.target_job_id} AND e.attempt_id=${grant.target_attempt_id} AND e.event_id=${grant.recovery_ref}
      AND e.type='control_receipt' AND e.payload_json->>'authority'='scheduler' AND e.payload_json->>'subtype'=${subtype}
      AND e.payload_json->>'kind'='state' AND e.payload_json->>'project_id'=${grant.project_id}
      AND e.payload_json->>'canvas_id'=${grant.canvas_id} AND e.payload_json->>'snapshot_sha256'=${grant.snapshot_sha256}`;
  const [wake] = await db`SELECT e.event_id FROM events e JOIN event_dedup d ON d.event_id=e.event_id AND d.job_id=e.job_id
    WHERE e.job_id=${grant.target_job_id} AND e.attempt_id=${grant.target_attempt_id} AND e.type='control_receipt'
    AND e.event_id=${completionRecoveryIdentity(grant.target_job_id, grant.target_attempt_id, `wake:${grant.evidence_sha256}`)}
    AND e.payload_json->>'authority'='scheduler' AND e.payload_json->>'subtype'=${subtype} AND e.payload_json->>'kind'='wake'
    AND e.payload_json->>'recovery_ref'=${grant.recovery_ref} AND e.payload_json->>'hub_job_id'=${String(hub.id)}
    AND e.payload_json->>'project_id'=${grant.project_id} AND e.payload_json->>'canvas_id'=${grant.canvas_id}
    AND e.payload_json->>'snapshot_sha256'=${grant.snapshot_sha256}
    AND e.payload_json->>'target_job_id'=${grant.target_job_id} AND e.payload_json->>'target_attempt_id'=${grant.target_attempt_id}
    AND e.payload_json->>'evidence_sha256'=${grant.evidence_sha256} AND e.payload_json->>'recovery_revision'=${String(grant.recovery_revision)}`;
  if (!root || !wake || state.wakes_used < 1 || state.wakes_used > state.wake_limit) throw new ControlInputError("recovery_not_authorized", "Recovery root/wake is missing or its frozen budget is exhausted", "recovery");
  const pendingClaim = options.pendingClaim === true && !options.final && !options.lockTarget && !options.tokenId;
  const [hubGate] = await db`SELECT id FROM jobs j WHERE j.id=${String(hub.id)}
    AND ((${pendingClaim} AND j.status='pending' AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=j.id AND a.status='active'))
      OR (NOT ${pendingClaim} AND j.status='running' AND j.lease_expires_at>clock_timestamp()
        AND j.started_at+j.timeout_sec*interval '1 second'>clock_timestamp()
        AND EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=j.id AND a.status='active' AND NOT a.cancel_requested)))
    AND NOT EXISTS (SELECT 1 FROM job_attempt_effects e JOIN jobs owner ON owner.id=e.job_id
      WHERE owner.canvas_id=j.canvas_id AND owner.project_id=j.project_id
      AND NOT (e.job_id=${grant.target_job_id} AND e.attempt_id=${grant.target_attempt_id})
      AND (e.status='unknown' OR (e.status='effect_pending' AND NOT
        (owner.status='running' AND e.effect_kind IN ('agent_run','agent_resume') AND EXISTS (
          SELECT 1 FROM job_attempts active WHERE active.id=e.attempt_id AND active.job_id=e.job_id
          AND active.status='active' AND NOT active.cancel_requested)))))`;
  const [otherJob] = await db`SELECT id FROM jobs WHERE canvas_id=${grant.canvas_id} AND project_id=${grant.project_id}
    AND id NOT IN (${String(hub.id)},${grant.target_job_id}) AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
  if (!hubGate || otherJob || await completionRecoveryVerifyBlocked(db, grant.canvas_id, grant.target_job_id)) {
    throw new ControlInputError("recovery_inactive", "Recovery does not bypass this Hub, unrelated active Jobs/effects or Verify waits", "recovery");
  }
  const evidence = await readCompletionRecoveryEvidence(db, target, grant.target_attempt_id);
  if (evidence.sha256 !== state.evidence_sha256) throw new ControlInputError("recovery_stale", "Live evidence changed after the durable recovery observation", "recovery");
  return { decision, grant, target, attempt, state, evidence };
}

/** Only exact settled Gateway usage proves this effect. Pending, resource IDs and interrupted never do. */
export function recoveryUsageIsKnown(row: { effect_kind: string; status: string; ledger_id?: unknown; settlement_status?: unknown;
  input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown; adjustment_tokens?: unknown }): boolean {
  if (row.effect_kind !== "gateway_model_request" || row.status !== "unknown" || !row.ledger_id || row.settlement_status !== "settled") return false;
  const values = [row.input_tokens, row.output_tokens, row.total_tokens, row.cache_read_input_tokens, row.cache_creation_input_tokens, row.adjustment_tokens];
  if (values.some(value => !["number", "bigint", "string"].includes(typeof value)
    || (typeof value === "string" && !/^-?[0-9]+$/.test(value)))) return false;
  const counts = values.slice(0, 5).map(Number);
  const adjustment = Number(row.adjustment_tokens);
  return counts.every(value => Number.isSafeInteger(value) && value >= 0) && Number.isSafeInteger(adjustment)
    && counts[2] >= counts[0] + counts[1] && counts[2] + adjustment >= 0 && Number.isSafeInteger(counts[2] + adjustment);
}

/** Semantic ingestion is the ONLY executor. This has no runner/provider call and never marks either Job successful. */
export async function applyCompletionRecoveryDecision(db: typeof sql, hub: Job, raw: unknown, eventId: string) {
  const checked = await validateCompletionRecoveryDecision(db, hub, raw, { final: true, eventId });
  const { decision, target, state } = checked;
  if (decision.action === "stop") {
    const requested = await appendState(db, target, { ...state, status: "stop_requested", code: "platform_recovery_stop", stop_reason: "platform_recovery_stop" });
    await projectCompletionRecoveryToCanvas(db, requested);
    return requested;
  }
  const rows = await db`SELECT e.id,e.effect_id,e.effect_kind,e.status,e.updated_at::text AS observed_updated_at,l.id AS ledger_id,l.settlement_status,
    l.input_tokens,l.output_tokens,l.total_tokens,l.cache_read_input_tokens,l.cache_creation_input_tokens,l.adjustment_tokens
    FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.job_id=e.job_id AND l.project_id=${state.project_id}
      AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${state.target_job_id} AND e.attempt_id=${state.target_attempt_id} AND e.status='unknown'
    ORDER BY e.id LIMIT ${COMPLETION_RECOVERY_EFFECT_LIMIT} FOR UPDATE OF e`;
  for (const row of rows) {
    if (!recoveryUsageIsKnown(row as Parameters<typeof recoveryUsageIsKnown>[0])) continue;
    // Gateway settlement takes this same Job lock first. Lock its exact ledger proof as well.
    await db`SELECT id FROM job_usage_ledger WHERE id=${row.ledger_id} AND job_id=${state.target_job_id}
      AND project_id=${state.project_id} AND attempt_id=${state.target_attempt_id} AND effect_id=${row.effect_id} FOR UPDATE`;
  }
  if ((await readCompletionRecoveryEvidence(db, target, state.target_attempt_id)).sha256 !== checked.evidence.sha256) {
    throw new ControlInputError("recovery_stale", "Evidence changed before the locked reconciliation", "recovery");
  }
  for (const row of rows) {
    if (!recoveryUsageIsKnown(row as Parameters<typeof recoveryUsageIsKnown>[0])) continue;
    const operationId = completionRecoveryIdentity(state.target_job_id, state.target_attempt_id, `reconcile:${String(hub.id)}:${eventId}:${row.id}`);
    // Keep PostgreSQL microseconds as text: a JS Date truncates them and makes a valid CAS miss.
    // Status + observed evidence CAS. A real settlement/ledger change wins; never replace its result.
    await db`UPDATE job_attempt_effects e SET status='settled',settlement_json=e.settlement_json || ${db.json({
      outcome: "applied_with_usage", reconciled_by: "completion-recovery", reconcile_operation_id: operationId,
      recovery_ref: state.recovery_ref, hub_job_id: String(hub.id), decision_event_id: eventId, usage_ledger_id: String(row.ledger_id),
    })},settled_at=now(),updated_at=now() WHERE e.id=${row.id} AND e.status='unknown' AND e.updated_at::text=${row.observed_updated_at}
      AND EXISTS (SELECT 1 FROM job_usage_ledger l WHERE l.id=${row.ledger_id} AND l.job_id=e.job_id AND l.project_id=${state.project_id}
        AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id AND l.settlement_status='settled'
        AND l.input_tokens=${row.input_tokens} AND l.output_tokens=${row.output_tokens} AND l.total_tokens=${row.total_tokens}
        AND l.cache_read_input_tokens=${row.cache_read_input_tokens} AND l.cache_creation_input_tokens=${row.cache_creation_input_tokens}
        AND l.adjustment_tokens=${row.adjustment_tokens})`;
  }
  const evidence = await readCompletionRecoveryEvidence(db, target, state.target_attempt_id);
  const refreshed = await recordCompletionRecovery(db, target, state.target_attempt_id, state.receipt_ref, "COMPLETION_EFFECT_UNKNOWN", evidence);
  await projectCompletionRecoveryToCanvas(db, refreshed);
  return refreshed;
}

export async function recordCompletionRecoveryWake(db: typeof sql, state: CompletionRecoveryState, hubJobId: string) {
  const eventId = completionRecoveryIdentity(state.target_job_id, state.target_attempt_id, `wake:${state.evidence_sha256}`);
  const [{ next }] = await db`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${state.target_job_id}`;
  await db`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${state.target_job_id})`;
  await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json) VALUES(${state.target_job_id},${eventId},${next},
    ${state.target_attempt_id},'control_receipt',${db.json({ v: 1, authority: "scheduler", subtype, kind: "wake",
      recovery_ref: state.recovery_ref, evidence_sha256: state.evidence_sha256, recovery_revision: state.recovery_revision,
      project_id: state.project_id, canvas_id: state.canvas_id, snapshot_sha256: state.snapshot_sha256,
      target_job_id: state.target_job_id, target_attempt_id: state.target_attempt_id,
      hub_job_id: hubJobId, wake_number: state.wakes_used + 1 } as never)})`;
}

export async function completionRecoveryVerifyBlocked(db: typeof sql, canvasId: string, targetJobId: string): Promise<boolean> {
  const [row] = await db`SELECT EXISTS (SELECT 1 FROM jobs j WHERE j.canvas_id=${canvasId}
    AND j.id<>${targetJobId} AND j.type='verify_finding' AND j.status IN ('pending','claimed','provisioning','running','waiting_human'))
    OR EXISTS (SELECT 1 FROM finding_verification_rounds r JOIN findings f ON f.id=r.finding_id JOIN jobs origin ON origin.id=f.job_id
      WHERE origin.canvas_id=${canvasId} AND r.status='pending' AND r.verify_job_id IS NULL
      AND r.requirements_json->>'eligibility'='waiting_evidence') AS blocked`;
  return Boolean(row?.blocked);
}

/** Caller is already Canvas-first. Returns false without consuming anything when a Hub cannot be created. */
export async function completionRecoveryCanWake(db: typeof sql, job: Job, requested: CompletionRecoveryState) {
  const [canvas] = await db`SELECT status,target_json FROM canvases WHERE id=${requested.canvas_id} AND project_id=${requested.project_id}`;
  if (!canvas || canvas.status === "archived" || canvasExecutionIsPaused(canvas.target_json)
    || canvas.target_json?.convergence?.hub_paused || canvas.target_json?.convergence?.auto_stopped) return false;
  const [target] = await db`SELECT * FROM jobs WHERE id=${requested.target_job_id} FOR UPDATE`;
  const [attempt] = await db`SELECT id FROM job_attempts WHERE job_id=${requested.target_job_id} AND id=${requested.target_attempt_id}
    AND status='active' AND NOT cancel_requested FOR UPDATE`;
  const state = await readCompletionRecovery(db, requested.target_job_id, requested.target_attempt_id);
  if (!target || !attempt || target.id !== job.id || state?.status !== "needed" || state.wakes_used >= state.wake_limit
    || state.evidence_sha256 !== requested.evidence_sha256 || state.recovery_revision !== requested.recovery_revision
    || state.project_id !== target.project_id || state.canvas_id !== target.canvas_id
    || controlInputDigest(target.agent_snapshot_json) !== state.snapshot_sha256 || Date.parse(state.deadline) <= Date.now()
    || !["running", "waiting_human"].includes(String(target.status))) return false;
  const [lease] = await db`SELECT id FROM jobs WHERE id=${state.target_job_id} AND lease_expires_at>clock_timestamp()
    AND started_at+timeout_sec*interval '1 second'>clock_timestamp()`;
  if (!lease) return false;
  const [human] = await db`SELECT payload_json FROM events WHERE job_id=${state.target_job_id} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
  if (target.status === "waiting_human" && human?.payload_json?.subject?.type !== "platform_blocker") return false;
  const [prior] = await db`SELECT event_id FROM events WHERE job_id=${state.target_job_id}
    AND event_id=${completionRecoveryIdentity(state.target_job_id, state.target_attempt_id, `wake:${state.evidence_sha256}`)}`;
  if (prior) return false;
  await assertTargetBinding(db, target);
  return (await readCompletionRecoveryEvidence(db, target, state.target_attempt_id)).sha256 === state.evidence_sha256;
}

/** Canvas-first only. Retire stale host-directed work only when it has never acquired execution ownership. */
async function retireStalePendingRecoveryHub(db: typeof sql, state: CompletionRecoveryState, hubId: string, originalClosed = false): Promise<boolean> {
  const [hub] = await db`SELECT * FROM jobs WHERE id=${hubId} FOR UPDATE`;
  const trigger = hub?.payload_json?.trigger;
  if (!hub || hub.status !== "pending" || hub.type !== "hub_reason" || hub.claimed_at || hub.started_at || hub.sandbox_id
    || hub.lease_expires_at || hub.heartbeat_at || hub.finished_at || hub.transcript_uri
    || trigger?.kind !== "completion_recovery" || !Array.isArray(trigger.recovery_refs) || trigger.recovery_refs.length !== 1) return false;
  const parsed = CompletionRecoveryGrant.safeParse(trigger.recovery_refs[0]);
  if (!parsed.success) return false;
  const { recovery_revision, evidence_sha256, ...binding } = parsed.data;
  if (hub.project_id !== state.project_id || hub.canvas_id !== state.canvas_id
    || controlInputDigest(binding) !== controlInputDigest({ recovery_ref: state.recovery_ref, target_job_id: state.target_job_id,
      target_attempt_id: state.target_attempt_id, project_id: state.project_id, canvas_id: state.canvas_id, snapshot_sha256: state.snapshot_sha256 })
    || (!originalClosed && Date.parse(state.deadline) > Date.now()
      && recovery_revision === state.recovery_revision && evidence_sha256 === state.evidence_sha256)) return false;
  const [root] = await db`SELECT e.event_id FROM events e JOIN event_dedup d ON d.event_id=e.event_id AND d.job_id=e.job_id
    WHERE e.event_id=${state.recovery_ref} AND e.job_id=${state.target_job_id} AND e.attempt_id=${state.target_attempt_id}
      AND e.type='control_receipt' AND e.payload_json @> ${db.json({ ...binding, authority: "scheduler", subtype, kind: "state" })}`;
  const [wake] = await db`SELECT e.event_id FROM events e JOIN event_dedup d ON d.event_id=e.event_id AND d.job_id=e.job_id
    WHERE e.event_id=${completionRecoveryIdentity(state.target_job_id, state.target_attempt_id, `wake:${evidence_sha256}`)}
      AND e.job_id=${state.target_job_id} AND e.attempt_id=${state.target_attempt_id} AND e.type='control_receipt'
      AND e.payload_json @> ${db.json({ ...parsed.data, authority: "scheduler", subtype, kind: "wake", hub_job_id: hubId })}`;
  if (!root || !wake) return false;
  const [retired] = await db`UPDATE jobs j SET status='cancelled',finished_at=now(),error='completion_recovery_grant_stale'
    WHERE j.id=${hubId} AND j.status='pending' AND j.claimed_at IS NULL AND j.started_at IS NULL AND j.sandbox_id IS NULL
      AND j.lease_expires_at IS NULL AND j.heartbeat_at IS NULL AND j.finished_at IS NULL AND j.transcript_uri IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=j.id)
      AND NOT EXISTS (SELECT 1 FROM job_attempt_effects e WHERE e.job_id=j.id) RETURNING j.id`;
  if (!retired) return false;
  await db`UPDATE canvas_nodes SET status='cancelled',updated_at=now()
    WHERE canvas_id=${state.canvas_id} AND job_id=${hubId} AND node_type='job'`;
  return true;
}

/** Existing Reaper tick owns this pump: bounded keyset, no timer, automatic reconciliation or resurrection. */
export async function pumpCompletionRecoveries(input: {
  db?: typeof sql; cursor?: string | null; limit?: number;
  wake: (tx: typeof sql, job: Job, state: CompletionRecoveryState) => Promise<boolean>;
  stop: (tx: typeof sql, job: Job, request: CompletionRecoveryStopRequest) => Promise<Job | null>;
}): Promise<{ cursor: string | null; scanned: number; woken: number; failed: number; stoppedJobs: Job[] }> {
  const db = input.db ?? sql;
  const limit = input.limit ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (input.cursor &&
    (!/^[0-9]{1,19}$/.test(input.cursor) || BigInt(input.cursor) > 9223372036854775807n))) throw new Error("invalid recovery pump page");
  const candidates = await db`SELECT e.id::text AS cursor,e.job_id,e.attempt_id,j.canvas_id FROM events e JOIN jobs j ON j.id=e.job_id
    WHERE e.id>${input.cursor ?? "0"}::bigint AND e.type='control_receipt' AND e.payload_json->>'authority'='scheduler'
      AND e.payload_json->>'subtype'=${subtype} AND e.payload_json->>'kind'='state'
      AND e.event_id::text=e.payload_json->>'recovery_ref' ORDER BY e.id LIMIT ${limit}`;
  let woken = 0;
  let failed = 0;
  const stoppedJobs: Job[] = [];
  for (const candidate of candidates) {
    let outcome: { woken?: boolean; stopped?: Job | null };
    try {
      outcome = await db.begin(async raw => {
        const tx = raw as unknown as typeof sql;
        if (candidate.canvas_id) await tx`SELECT id FROM canvases WHERE id=${candidate.canvas_id} FOR UPDATE`;
        const [job] = await tx`SELECT * FROM jobs WHERE id=${candidate.job_id} FOR UPDATE`;
        const [attempt] = await tx`SELECT * FROM job_attempts WHERE job_id=${candidate.job_id} AND id=${candidate.attempt_id} FOR UPDATE`;
        let state = await readCompletionRecovery(tx, String(candidate.job_id), String(candidate.attempt_id));
        if (!job || !state) return {};
        if (job.canvas_id !== candidate.canvas_id || state.canvas_id !== job.canvas_id || state.project_id !== job.project_id
          || state.snapshot_sha256 !== controlInputDigest(job.agent_snapshot_json)) throw new Error("recovery binding changed");
        if (state.status === "closed" || !["claimed", "provisioning", "running", "waiting_human"].includes(String(job.status))
          || !attempt || attempt.status !== "active" || attempt.cancel_requested) {
          const [pendingHub] = await tx`SELECT id FROM jobs WHERE canvas_id=${String(job.canvas_id)} AND id<>${state.target_job_id}
            AND type='hub_reason' AND status='pending' LIMIT 1`;
          if (pendingHub) await retireStalePendingRecoveryHub(tx, state, String(pendingHub.id), true);
          if (state.status !== "closed") state = await appendState(tx, job, { ...state, status: "closed", code: "RECOVERY_ORIGINAL_EXECUTION_CLOSED" });
          await projectCompletionRecoveryToCanvas(tx, state); return {};
        }
        if (!["stop_requested", "completion_accepted"].includes(state.status)) {
          const evidence = await readCompletionRecoveryEvidence(tx, job, String(candidate.attempt_id));
          state = await recordCompletionRecovery(tx, job, String(candidate.attempt_id), state.receipt_ref, state.code, evidence);
        }
        await projectCompletionRecoveryToCanvas(tx, state);
        const [canvas] = job.canvas_id ? await tx`SELECT status,target_json,target_json->'convergence' AS convergence_json FROM canvases WHERE id=${String(job.canvas_id)}` : [];
        if (!canvas || canvas.status === "archived" || canvasExecutionIsPaused(canvas.target_json) || canvas.convergence_json?.hub_paused || canvas.convergence_json?.auto_stopped
          || await completionRecoveryVerifyBlocked(tx, String(job.canvas_id), state.target_job_id)) return {};
        let [hub] = await tx`SELECT id FROM jobs WHERE canvas_id=${String(job.canvas_id)} AND id<>${state.target_job_id}
          AND type='hub_reason' AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
        // A true human wait never consumes Stop. Platform waits may observe/wake, not close an execution here.
        if (job.status === "waiting_human") {
          const [human] = await tx`SELECT payload_json FROM events WHERE job_id=${state.target_job_id} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
          if (human?.payload_json?.subject?.type !== "platform_blocker") return {};
        }
        if (hub && await retireStalePendingRecoveryHub(tx, state, String(hub.id))) {
          [hub] = await tx`SELECT id FROM jobs WHERE canvas_id=${String(job.canvas_id)} AND id<>${state.target_job_id}
            AND type='hub_reason' AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
        }
        if (hub) return {}; // Started, unrelated or unproven Hubs retain ownership.
        const exhausted = state.status === "needed" && state.wakes_used >= state.wake_limit;
        const expired = Date.parse(state.deadline) <= Date.now();
        if (job.status !== "waiting_human" && (state.status === "stop_requested" || expired || exhausted)) {
          const reason = state.stop_reason ?? (expired ? "platform_recovery_deadline" : "platform_recovery_exhausted");
          state = await appendState(tx, job, { ...state, status: "stop_requested", code: reason, stop_reason: reason });
          const stopped = await input.stop(tx, job, { recoveryRef: state.recovery_ref, jobId: state.target_job_id, attemptId: state.target_attempt_id, reason });
          // Failed/null lifecycle CAS leaves the durable request for a later tick.
          if (stopped) state = await appendState(tx, stopped, { ...state, status: "closed", code: reason });
          await projectCompletionRecoveryToCanvas(tx, state);
          return { stopped };
        }
        const queued = !hub && state.status === "needed" && ["running", "waiting_human"].includes(String(job.status))
          ? await input.wake(tx, job, state) : false;
        if (queued) await projectCompletionRecoveryToCanvas(tx, (await readCompletionRecovery(tx, state.target_job_id, state.target_attempt_id))!);
        return { woken: queued };
      });
    } catch (error) {
      // A persistently bad head cannot starve later roots. Rollback retains the request; next sweep retries.
      failed++;
      console.warn("[completion-recovery] candidate transaction failed", { job_id: String(candidate.job_id),
        attempt_id: String(candidate.attempt_id), code: error instanceof ControlInputError ? error.code : "database_or_callback_failure" });
      continue;
    }
    if (outcome.woken) woken++;
    if (outcome.stopped) stoppedJobs.push(outcome.stopped);
  }
  return { cursor: candidates.length === limit ? String(candidates.at(-1)!.cursor) : null, scanned: candidates.length, woken, failed, stoppedJobs };
}
