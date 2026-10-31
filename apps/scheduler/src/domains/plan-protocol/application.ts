import { taskInputSha256 } from "./task-input.js";
import { preparePlanRouteRevision } from "./revision.js";
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
  eventId?: string,
): Promise<PlanAuditRecord> {
  const parsed = SubmitPlanPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ControlInputError("invalid_payload", "submit_plan 参数不符合 Plan 协议。", "plan");
  }
  const raw: Plan = parsed.data.plan;
  if (parsed.data.revision) {
    const prepared = await preparePlanRouteRevision(tx, jobId, job, parsed.data, maxTasks, eventId);
    return persistPlanAudit(tx, parsed.data.revision.plan_job_id, prepared.ownerPayload, {
      source: "submit_plan", raw, trimmed: prepared.trimmed, trim_reasons: [],
    });
  }
  if (readPlanAudit(job.payload_json)?.raw) {
    throw new ControlInputError("plan_stale_revision", "替换已有 Plan 必须提交显式路线修订及当前版本。", "revision");
  }
  if (job.canvas_id && job.type !== "report") {
    const [canvas] = await tx`SELECT title,target_json FROM canvases WHERE id=${String(job.canvas_id)}`;
    if (!canvas) throw new ControlInputError("invalid_payload", "Plan requires a current Canvas");
    await tx`UPDATE jobs SET payload_json=payload_json || ${tx.json({plan_input_sha256:taskInputSha256(canvas.title,canvas.target_json)} as never)} WHERE id=${jobId}`;
  }
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
  const knownTasks = new Set(existing?.raw?.tasks.map((task) => task.id) ?? []);
  const executionIds = result.execution.map((entry) => entry.task_id);
  if (new Set(executionIds).size !== executionIds.length || executionIds.some((id) => !knownTasks.has(id))) {
    throw new ControlInputError("invalid_payload", "PlanResult execution 必须唯一引用本 Job 当前计划中的 task_id。", "execution");
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
