import type { ProjectTaskQueueYieldInput } from "@deepsonar/shared-types";
import { recordSystemAudit } from "../../audit.js";
import type { sql } from "../../db.js";
import { HumanCheckpointManifest } from "../job-control/human-checkpoint-files.js";
import { remainingHumanExecutionMs } from "../job-control/human-continuation-clock.js";
import { humanSnapshotDigest } from "../job-control/human-continuation-store.js";
import { readRepairRequeueAdmission } from "../job-control/repair-admission.js";
import { TaskQueueError } from "./task-queue-store.js";

/** Caller holds the claim advisory lock, before taking Canvas -> Job -> Attempt -> request. */
export async function yieldProjectTaskQueue(db: typeof sql, projectId: string, input: ProjectTaskQueueYieldInput) {
  const [previous] = await db`SELECT * FROM project_task_queue_yields WHERE mutation_id=${input.mutation_id}`;
  if (previous) {
    if (previous.project_id !== projectId || previous.canvas_id !== input.canvas_id
      || String(previous.source_item_id) !== input.expected_item_id || previous.request_id !== input.request_id
      || Number(previous.request_revision) !== input.expected_revision) {
      throw new TaskQueueError("QUEUE_MUTATION_CONFLICT", "本次操作编号已经用于另一项让位决定");
    }
    return;
  }
  const [canvas] = await db`SELECT c.*,p.status AS project_status,p.archived_at AS project_archived_at
    FROM canvases c JOIN projects p ON p.id=c.project_id
    WHERE c.id=${input.canvas_id} AND c.project_id=${projectId} FOR UPDATE OF c`;
  if (!canvas) throw new TaskQueueError("QUEUE_PROJECT_MISMATCH", "任务不属于指定项目");
  if (canvas.status !== "active" || canvas.archived_at || canvas.project_status !== "active" || canvas.project_archived_at) {
    throw new TaskQueueError("QUEUE_TASK_CLOSED", "归档任务或项目不能让位");
  }
  const [locator] = await db`SELECT job_id FROM human_requests WHERE id=${input.request_id}
    AND project_id=${projectId} AND canvas_id=${input.canvas_id}`;
  if (!locator) throw new TaskQueueError("QUEUE_HUMAN_REQUEST_CHANGED", "人工请求不属于当前任务");
  const [job] = await db`SELECT * FROM jobs WHERE id=${locator.job_id} FOR UPDATE`;
  const attempts = await db`SELECT id,status,cancel_requested FROM job_attempts WHERE job_id=${locator.job_id}
    ORDER BY attempt_no FOR UPDATE`;
  const [request] = await db`SELECT * FROM human_requests WHERE id=${input.request_id} FOR UPDATE`;
  const [item] = await db`SELECT id::text,state FROM project_task_queue_items WHERE canvas_id=${input.canvas_id} FOR UPDATE`;
  if (!item || item.id !== input.expected_item_id || item.state !== "active") {
    throw new TaskQueueError("QUEUE_HEAD_CHANGED", "占位任务已变化，请刷新队列");
  }
  if (!job || job.status !== "waiting_human" || !request || request.status !== "open" || request.resumed_at
    || request.reply_message_id || Number(request.revision) !== input.expected_revision
    || attempts.at(-1)?.id !== request.attempt_id || attempts.at(-1)?.cancel_requested
    || attempts.at(-1)?.status !== "interrupted") {
    throw new TaskQueueError("QUEUE_HUMAN_REQUEST_CHANGED", "人工等待已变化，不能按旧请求让位");
  }
  const [other] = await db`SELECT id FROM jobs WHERE canvas_id=${input.canvas_id} AND id<>${job.id}
    AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
  if (other) throw new TaskQueueError("QUEUE_OTHER_WORK_PENDING", "任务还有其他待执行、运行或人工等待工作，暂不能让位");
  if (request.checkpoint_status !== "ready" || !request.process_exited_at || !request.resources_released_at) {
    throw new TaskQueueError("QUEUE_CHECKPOINT_NOT_READY", "进度保存和资源回收尚未完成");
  }
  if (new Date(request.checkpoint_expires_at).getTime() <= Date.now()) {
    throw new TaskQueueError("HUMAN_CHECKPOINT_EXPIRED", "保存的进度已过期");
  }
  const manifest = HumanCheckpointManifest.safeParse(request.manifest_json);
  if (!manifest.success || manifest.data.job_id !== job.id || manifest.data.request_id !== request.id
    || manifest.data.attempt_id !== request.attempt_id || manifest.data.snapshot_sha256 !== humanSnapshotDigest(job.agent_snapshot_json)) {
    throw new TaskQueueError("QUEUE_CHECKPOINT_IDENTITY_CHANGED", "保存进度的执行身份不匹配");
  }
  const [lease] = await db`SELECT id FROM device_leases WHERE job_id=${job.id} AND state IN ('pending','active') LIMIT 1`;
  if (lease) throw new TaskQueueError("QUEUE_RESOURCES_PENDING", "设备资源尚未释放");
  const [unresolved] = await db`SELECT e.id FROM job_attempt_effects e JOIN jobs j ON j.id=e.job_id
    WHERE j.canvas_id=${input.canvas_id} AND e.status<>'settled' LIMIT 1`;
  if (unresolved) throw new TaskQueueError("QUEUE_UNKNOWN_EFFECT", "任务仍有未结清外部效果，不能让位");
  const [usage] = await db`SELECT e.id FROM job_attempt_effects e LEFT JOIN job_usage_ledger l
    ON l.job_id=e.job_id AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${job.id} AND e.effect_kind='gateway_model_request'
      AND (l.id IS NULL OR l.settlement_status<>'settled') LIMIT 1`;
  if (usage) throw new TaskQueueError("HUMAN_CONTINUATION_USAGE_UNKNOWN", "原模型调用的费用尚未确认");
  const admission = await readRepairRequeueAdmission(db, String(job.id));
  if (admission.blocker) throw new TaskQueueError(admission.blocker.code, admission.blocker.reason);
  const remaining = await remainingHumanExecutionMs(db, String(job.id));
  if (remaining === null || remaining <= 0) throw new TaskQueueError("EXECUTION_TIME_EXHAUSTED", "原执行时间额度已耗尽或无法确认");
  await db`INSERT INTO project_task_queue_yields(mutation_id,project_id,canvas_id,source_item_id,request_id,request_revision)
    VALUES(${input.mutation_id},${projectId},${input.canvas_id},${input.expected_item_id},${input.request_id},${input.expected_revision})`;
  await db`UPDATE project_task_queue_items SET state='yielded' WHERE id=${item.id} AND state='active'`;
  await recordSystemAudit({ action: "task_queue.human_yield", projectId,
    resourceType: "project_task_queue_item", resourceId: item.id,
    before: { state: "active", request_id: input.request_id, revision: input.expected_revision },
    after: { state: "yielded", mutation_id: input.mutation_id, canvas_id: input.canvas_id },
  }, db);
}

/** Same transaction as saving the reply. No execution or budget is created here. */
export async function requeueYieldedHumanReply(db: typeof sql, requestId: string): Promise<void> {
  const [decision] = await db`SELECT y.*,r.status,r.revision,r.reply_message_id AS saved_reply,r.resumed_at,j.status AS job_status
    FROM project_task_queue_yields y JOIN human_requests r ON r.id=y.request_id JOIN jobs j ON j.id=r.job_id
    WHERE y.request_id=${requestId} FOR UPDATE OF y`;
  if (!decision || decision.requeued_at || decision.status !== "answered" || decision.resumed_at
    || decision.job_status !== "waiting_human" || !decision.saved_reply
    || Number(decision.revision) !== Number(decision.request_revision) + 1) return;
  const [next] = await db`UPDATE project_task_queue_items
    SET id=nextval(pg_get_serial_sequence('project_task_queue_items','id')),state='queued'
    WHERE canvas_id=${decision.canvas_id} AND project_id=${decision.project_id}
      AND id=${decision.source_item_id} AND state='yielded' RETURNING id::text`;
  if (!next) throw new TaskQueueError("QUEUE_HEAD_CHANGED", "已让位任务的队列身份已变化");
  await db`UPDATE project_task_queue_yields SET reply_message_id=${decision.saved_reply},requeued_item_id=${next.id},
    requeued_at=clock_timestamp() WHERE mutation_id=${decision.mutation_id}`;
  await recordSystemAudit({ action: "task_queue.human_reply_requeued", projectId: String(decision.project_id),
    resourceType: "project_task_queue_item", resourceId: next.id,
    before: { state: "yielded", item_id: String(decision.source_item_id) },
    after: { state: "queued", request_id: requestId, reply_message_id: String(decision.saved_reply) },
  }, db);
  await db`SELECT pg_notify('deepsonar_jobs', ${String(decision.project_id)})`;
}
