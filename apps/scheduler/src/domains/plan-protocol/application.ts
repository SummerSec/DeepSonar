import {
  Plan,
  PlanAuditRecord,
  PlanResult,
  SubmitPlanPayload,
  SubmitPlanResultPayload,
  adaptHubCompleteToPlanResult,
  adaptHubIntentsToPlan,
  mergePlanAudit,
  trimPlan,
  type HubCompleteLike,
  type HubIntentLike,
} from "@deepsonar/shared-types";
import { ControlInputError } from "../../control-input.js";
import type { EventIngestionTransaction } from "../event-ingestion/application.js";

export function readPlanAudit(payloadJson: unknown): PlanAuditRecord | null {
  if (!payloadJson || typeof payloadJson !== "object" || Array.isArray(payloadJson)) return null;
  const raw = (payloadJson as Record<string, unknown>).plan_protocol;
  const parsed = PlanAuditRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function persistPlanAudit(
  tx: EventIngestionTransaction,
  jobId: string,
  currentPayload: unknown,
  patch: Parameters<typeof mergePlanAudit>[1],
): Promise<PlanAuditRecord> {
  const record = mergePlanAudit(readPlanAudit(currentPayload), patch);
  await tx`
    UPDATE jobs
    SET payload_json = payload_json || ${tx.json({ plan_protocol: record } as never)}
    WHERE id = ${jobId}`;
  return record;
}

export async function applySubmitPlan(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  payload: unknown,
  maxTasks: number,
): Promise<PlanAuditRecord> {
  const parsed = SubmitPlanPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ControlInputError("invalid_payload", "submit_plan 参数不符合 Plan 协议。", "plan");
  }
  const raw: Plan = parsed.data.plan;
  const { trimmed, reasons } = trimPlan(raw, { maxTasks });
  return persistPlanAudit(tx, jobId, job.payload_json, {
    source: "submit_plan",
    raw,
    trimmed,
    trim_reasons: reasons,
  });
}

export async function applySubmitPlanResult(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  payload: unknown,
): Promise<PlanAuditRecord> {
  const parsed = SubmitPlanResultPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ControlInputError("invalid_payload", "submit_plan_result 参数不符合 PlanResult 协议。");
  }
  const result: PlanResult = parsed.data;
  const existing = readPlanAudit(job.payload_json);
  if (!existing?.raw && !existing?.result) {
    throw new ControlInputError(
      "invalid_payload",
      "submit_plan_result 需要本 Job 已有计划原文或 Hub Intent 适配记录。",
      "result",
    );
  }
  return persistPlanAudit(tx, jobId, job.payload_json, {
    source: existing?.source ?? "submit_plan",
    result,
    termination_reason: result.termination_reason ?? result.outcome,
  });
}

export async function applyHubPlanAdapter(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  decision: { complete?: HubCompleteLike; intents?: readonly HubIntentLike[] },
  maxTasks: number,
): Promise<PlanAuditRecord> {
  if (decision.complete) {
    const result = adaptHubCompleteToPlanResult(decision.complete);
    return persistPlanAudit(tx, jobId, job.payload_json, {
      source: "hub_intent_adapter",
      result,
      termination_reason: result.termination_reason ?? "hub_complete",
    });
  }
  const intents = decision.intents ?? [];
  const raw = adaptHubIntentsToPlan(intents);
  const { trimmed, reasons } = trimPlan(raw, { maxTasks });
  return persistPlanAudit(tx, jobId, job.payload_json, {
    source: "hub_intent_adapter",
    raw,
    trimmed,
    trim_reasons: reasons,
  });
}
