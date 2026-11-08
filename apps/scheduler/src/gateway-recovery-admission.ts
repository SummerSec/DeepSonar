import type { sql } from "./db.js";
import { readNoEffectReceipt } from "./gateway-admission-receipt.js";
import { GatewayWorkloadPolicyError } from "./gateway-om-budget.js";
import { GATEWAY_MODEL_RECOVERY_LIMIT } from "./runtime-knobs.js";

type Database = typeof sql;

/** A new, linked model request in the original live Job/session, never replay of an effect. */
export async function assertGatewayRecoveryAllowed(db: Database, input: {
  jobId: string; attemptId: string; tokenId: string; requestId: string;
  retryOf: string; provider: string; model: string; method: string; upstreamPath: string; inputDigest: string;
}, snapshot: Record<string, unknown>): Promise<void> {
  const reject: (code: string) => never = (code) => {
    throw new GatewayWorkloadPolicyError(code, "Model recovery requires a live original owner, durable no-start proof and remaining frozen Job budget");
  };
  const knobs = snapshot.runtime_knobs as Record<string, unknown> | undefined;
  const limit = knobs?.gateway_model_retries;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > GATEWAY_MODEL_RECOVERY_LIMIT) {
    reject("gateway_recovery_budget_missing");
  }
  const [job] = await db`SELECT status, project_id, lease_expires_at>clock_timestamp() AS leased,
    started_at + timeout_sec * interval '1 second'>clock_timestamp() AS timely
    FROM jobs WHERE id=${input.jobId}`;
  const attempts = await db`SELECT id,status,cancel_requested FROM job_attempts
    WHERE job_id=${input.jobId} ORDER BY attempt_no DESC FOR UPDATE`;
  if (!job || job.status !== "running" || !job.leased || !job.timely
    || String(attempts[0]?.id) !== input.attemptId || attempts[0]?.status !== "active"
    || attempts[0]?.cancel_requested || attempts.filter(a => a.status === "active").length !== 1) {
    reject("gateway_recovery_owner_inactive");
  }
  // Counts span token generations and Attempts. A different key/owner cannot reset them.
  const [history] = await db`SELECT count(*) FILTER (WHERE intent_json ? 'gateway_retry_of') AS spent,
    count(*) FILTER (WHERE intent_json->>'recovery_policy_version' IS DISTINCT FROM '1') AS unversioned
    FROM job_attempt_effects WHERE job_id=${input.jobId} AND effect_kind='gateway_model_request'`;
  if (Number(history?.unversioned) !== 0) reject("gateway_recovery_history_unproven");
  if (!Number.isSafeInteger(Number(history?.spent)) || Number(history?.spent) < 0) reject("gateway_recovery_budget_missing");
  if (Number(history?.spent) >= (limit as number)) reject("gateway_recovery_budget_exhausted");
  const [used] = await db`SELECT effect_id FROM job_attempt_effects WHERE job_id=${input.jobId}
    AND intent_json->>'gateway_retry_of'=${input.retryOf}`;
  if (used || input.requestId === input.retryOf) reject("gateway_recovery_already_consumed");
  const [unresolved] = await db`SELECT effect_id FROM job_attempt_effects WHERE job_id=${input.jobId}
    AND (status='unknown' OR (status='effect_pending' AND NOT (effect_kind='agent_run' AND attempt_id=${input.attemptId}))) LIMIT 1`;
  if (unresolved) reject("gateway_recovery_effect_unresolved");
  const rows = await db`SELECT e.*, l.settlement_status AS ledger_status, l.source AS ledger_source,
    l.total_tokens,l.input_tokens,l.output_tokens,l.cache_read_input_tokens,l.cache_creation_input_tokens,l.adjustment_tokens,
    l.job_id AS ledger_job,l.project_id AS ledger_project,l.job_token_id AS ledger_token,l.workload AS ledger_workload
    FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${input.jobId} AND e.attempt_id=${input.attemptId}
    AND e.resource_identity_json->>'job_token_id'=${input.tokenId}
    AND e.intent_json->>'gateway_request_id'=${input.retryOf}`;
  if (rows.length === 0) {
    const receipt = await readNoEffectReceipt(db, { ...input, workload: "main", requestId: input.retryOf });
    if (receipt?.status === "not_started" && receipt.reason === "gateway_transient") return;
    reject("gateway_recovery_no_start_unproven");
  }
  const e = rows[0]!;
  const zero = [e.total_tokens,e.input_tokens,e.output_tokens,e.cache_read_input_tokens,
    e.cache_creation_input_tokens,e.adjustment_tokens].every(v => v !== null && v !== undefined && Number(v) === 0);
  if (rows.length !== 1 || e.effect_kind !== "gateway_model_request" || e.status !== "settled"
    || e.settlement_json?.external_effect !== false || e.settlement_json?.result !== "never_started"
    || e.input_digest !== input.inputDigest || e.intent_json?.provider !== input.provider
    || e.intent_json?.model !== input.model.slice(0,200) || e.intent_json?.method !== input.method
    || e.intent_json?.upstream_path !== input.upstreamPath || e.intent_json?.workload !== "main"
    || String(e.ledger_job) !== input.jobId || String(e.ledger_project) !== String(job.project_id)
    || String(e.ledger_token) !== input.tokenId || e.ledger_workload !== "main"
    || e.ledger_status !== "settled" || e.ledger_source !== "gateway_error" || !zero) {
    reject("gateway_recovery_no_start_unproven");
  }
}
