import { createHash } from "node:crypto";
import type { sql } from "./db.js";
import { observationalMemoryConfig, parseFrozenPiExtensions } from "./pi-extensions.js";
import { resolveObservationalMemoryBudget } from "./gateway-om-budget.js";
import { frozenRuntimeKnobsFromSnapshot, missingFrozenKnobFields } from "./runtime-knobs.js";
import { consumeEventRateLimit } from "./domains/event-ingestion/rate-limit.js";

type Database = typeof sql;
export type GatewayRequestBudget = {
  version: 1; total_requests: number; main_requests: number; background_requests: number;
};
export class GatewayRequestBudgetError extends Error {
  constructor(readonly code: "GATEWAY_REQUEST_BUDGET_INVALID" | "GATEWAY_REQUEST_BUDGET_HISTORY_MISSING",
    readonly missing_fields: string[] = []) {
    super(missing_fields.length
      ? `${code}: field ${missing_fields.join(", ")} 缺失或非法；预算无法从冻结快照解析，须先核对历史策略与执行效果，不能按当前配置猜测或重置额度`
      : code);
  }
}
const invalid = () => new GatewayRequestBudgetError("GATEWAY_REQUEST_BUDGET_INVALID");
const fields = ["total_requests", "main_requests", "background_requests"] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function cap(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw invalid();
  return value;
}
export function finiteRequestCap(values: readonly (number | null | undefined)[]): number {
  const positive = values.filter((value): value is number => value != null && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}
function intersect(a: GatewayRequestBudget, b: GatewayRequestBudget): GatewayRequestBudget {
  return { version: 1, total_requests: finiteRequestCap([a.total_requests, b.total_requests]),
    main_requests: finiteRequestCap([a.main_requests, b.main_requests]),
    background_requests: finiteRequestCap([a.background_requests, b.background_requests]) };
}
function parsePolicy(value: unknown): GatewayRequestBudget {
  const row = record(value);
  if (row.version !== 1 || Object.keys(row).some(key => key !== "version" && !fields.includes(key as typeof fields[number]))) throw invalid();
  return { version: 1, total_requests: cap(row.total_requests), main_requests: cap(row.main_requests),
    background_requests: cap(row.background_requests) };
}
function snapshotPolicy(snapshot: unknown): GatewayRequestBudget {
  try {
    // Inspect the root too: record() would discard its actionable field path.
    // Missing or damaged knobs do not prove the original policy was unlimited.
    const knobs = frozenRuntimeKnobsFromSnapshot(snapshot);
    if (!knobs) throw new GatewayRequestBudgetError("GATEWAY_REQUEST_BUDGET_INVALID", missingFrozenKnobFields(snapshot));
    const row = record(snapshot);
    const main = cap(knobs.job_token_max_requests);
    if (!["pi", "claude-code", "dsh"].includes(String(row.agent_cli))) throw invalid();
    if ((row.agent_cli === "pi" || row.pi_extensions !== undefined) && !Array.isArray(row.pi_extensions)) throw invalid();
    // A valid OM configuration may omit request_budget only with explicit
    // total=0: freezeObservationalMemoryQuota and its shared schema define this
    // shape. Missing OM extension metadata still fails parseFrozenPiExtensions.
    const om = observationalMemoryConfig(parseFrozenPiExtensions(row.pi_extensions));
    // This frozen knob is a Job request ceiling, including when the Job has
    // only main today. Enabling OM in a later generation cannot erase it.
    if (!om) return { version: 1, total_requests: main, main_requests: main, background_requests: 0 };
    const plan = resolveObservationalMemoryBudget({ config: om, jobTokenMaxRequests: main });
    return { version: 1, total_requests: plan.total_requests, main_requests: plan.main_requests,
      background_requests: plan.background_requests };
  } catch (error) {
    if (error instanceof GatewayRequestBudgetError) throw error;
    throw invalid();
  }
}
function eventIdentity(jobId: string, policy: GatewayRequestBudget): string {
  return `gateway-request-budget:${createHash("sha256").update(JSON.stringify([jobId, policy])).digest("hex")}`;
}

/** Caller owns Canvas (if relevant) -> Job locks. Read-only, including failures:
 * suitable for whole-batch recovery preflight before any worker is changed.
 * No policy receipt plus multiple historical Attempts cannot prove the original
 * unminted workload policy; never reconstruct it from the current configuration. */
export async function inspectGatewayRequestBudget(db: Database, jobId: string, previousSnapshot: unknown): Promise<GatewayRequestBudget> {
  let policy = snapshotPolicy(previousSnapshot);
  const receipts = await db`SELECT event_id,payload_json FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'operation'='gateway_request_budget' ORDER BY job_seq`;
  if (receipts.length === 0) {
    const [attempts] = await db`SELECT count(*)::int AS count FROM job_attempts WHERE job_id=${jobId}`;
    if (Number(attempts.count) > 1) throw new GatewayRequestBudgetError("GATEWAY_REQUEST_BUDGET_HISTORY_MISSING");
  }
  for (const receipt of receipts) {
    const payload = record(receipt.payload_json);
    if (payload.v !== 1 || payload.authority !== "kernel") throw invalid();
    const stored = parsePolicy(payload.policy);
    if (receipt.event_id !== eventIdentity(jobId, stored)) throw invalid();
    policy = intersect(policy, stored);
  }
  // Tokens are immutable historical constraints, even when revoked or expired.
  // Job lock serializes mint/admission/recovery; this read does not acquire a
  // token lock before the recovery owner's Attempt locks.
  const tokens = await db`SELECT workload,max_requests,request_total_limit FROM job_tokens WHERE job_id=${jobId}`;
  for (const token of tokens) {
    if (token.workload !== "main" && token.workload !== "observational_memory") throw invalid();
    // PostgreSQL int4 NOT NULL columns are numbers; never coerce damaged
    // null/string input to an unlimited policy.
    const limit = cap(token.max_requests), total = cap(token.request_total_limit);
    policy = intersect(policy, { version: 1, total_requests: total,
      main_requests: token.workload === "main" ? limit : 0,
      background_requests: token.workload === "observational_memory" ? limit : 0 });
  }
  return policy;
}

/** Append a kernel-only, Job-scoped policy receipt in the caller's transaction.
 * First mint freezes ALL workloads, including ones never minted. Recovery calls
 * this with the OLD snapshot before grant revocation/Attempt changes/replacement.
 * Later calls can only tighten. No snapshot, counter, Attempt or grant is changed. */
export async function ensureGatewayRequestBudget(db: Database, jobId: string, previousSnapshot: unknown): Promise<GatewayRequestBudget> {
  const policy = await inspectGatewayRequestBudget(db, jobId, previousSnapshot);
  const eventId = eventIdentity(jobId, policy);
  const [existing] = await db`SELECT id FROM events WHERE job_id=${jobId} AND event_id=${eventId}`;
  if (existing) return policy;
  await consumeEventRateLimit(db, jobId, "control_receipt", new Date());
  const [{ next }] = await db`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${jobId}`;
  await db`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${jobId})`;
  await db`INSERT INTO events(job_id,event_id,job_seq,type,payload_json)
    VALUES(${jobId},${eventId},${next},'control_receipt',${db.json({ v: 1, authority: "kernel",
      operation: "gateway_request_budget", policy,
      snapshot_sha256: createHash("sha256").update(JSON.stringify(previousSnapshot)).digest("hex") })})`;
  return policy;
}
