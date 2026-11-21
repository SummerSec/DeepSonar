import { recordDurableSystemAudit } from "../../audit.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "../../db.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "../../core.js";
import { lockContinuationBudget } from "./continuation-budget.js";
import { HumanCheckpointManifest, readCheckpointFile } from "./human-checkpoint-files.js";
import { humanSnapshotDigest } from "./human-continuation-store.js";
import { pauseHumanExecutionClock, remainingHumanExecutionMs } from "./human-continuation-clock.js";
import { readRepairRequeueAdmission } from "./repair-admission.js";
import { frozenSnapshotStaleDetail, requeueTargetAuthorizationBlockers, revokeOldRuntimeGrants } from "./rerun.js";
import { inspectGatewayRequestBudget } from "../../gateway-request-policy.js";
import { readHistoricalRequestBudget } from "../../gateway-request-budget.js";
import { readAcknowledgedHumanAttachments } from "./human-continuation-inbox.js";
import { reserveHistoricalPlanContinuation } from "../plan-protocol/historical-continuation.js";
import { recordJobSharedAssets } from "../shared-assets/index.js";
import type { AgentRuntimeSnapshot } from "../role-runtime-snapshot/index.js";
import { canvasExecutionIsPaused } from "../../task-execution-control.js";

export const HistoricalContinuationInput = z.object({
  mutation_id: z.string().uuid(),
  request_id: z.string().uuid(),
  expected_revision: z.number().int().min(0),
  reply_message_id: z.string().uuid(),
}).strict();

export class HistoricalContinuationBlocked extends Error {
  constructor(readonly code: string) { super(code); }
}
const deny = (code: string): never => { throw new HistoricalContinuationBlocked(code); };

/** Explicit management admission. Every rejection rolls back before a new Job becomes visible. */
export async function createHistoricalContinuation(sourceId: string, input: z.infer<typeof HistoricalContinuationInput>, actorId = "scheduler") {
  return sql.begin(async raw => {
    const db = raw as unknown as typeof sql;
    await db`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
    const [locator] = await db`SELECT canvas_id FROM jobs WHERE id=${sourceId}`;
    if (!locator?.canvas_id) return deny("CONTINUATION_SOURCE_NOT_FOUND");
    const [canvas] = await db`SELECT * FROM canvases WHERE id=${locator.canvas_id} FOR UPDATE`;
    const digest = humanSnapshotDigest({ source_job_id: sourceId, ...input });
    // Retry lookup precedes owner and revision checks. A successful handoff changes both.
    const [prior] = await db`SELECT * FROM job_continuations WHERE mutation_id=${input.mutation_id}`;
    if (prior) {
      if (prior.source_job_id !== sourceId || prior.input_sha256 !== digest) return deny("CONTINUATION_IDEMPOTENCY_CONFLICT");
      return prior;
    }
    if (!canvas || canvas.status !== "active" || canvasExecutionIsPaused(canvas.target_json)) return deny("CONTINUATION_CANVAS_INACTIVE");
    const { rootId, jobIds } = await lockContinuationBudget(db, sourceId);
    const [source] = await db`SELECT * FROM jobs WHERE id=${sourceId} FOR UPDATE`;
    if (source.status !== "failed") return deny("CONTINUATION_SOURCE_NOT_FAILED");
    const payload = source.payload_json as Record<string, unknown>;
    const snapshot = source.agent_snapshot_json as Record<string, unknown>;
    // These assignments have their own immutable Job owner and settlement protocol.
    // Reusing their payload under another identity would replay or misattribute downstream work.
    if (["hub_reason", "verify", "verify_finding", "report"].includes(String(source.type)) || payload.verification_followup
      || payload.hub_followup || payload.goal_review || snapshot.task_goal_review || snapshot.knowledge_assignment)
      return deny("CONTINUATION_ASSIGNMENT_OWNER_UNSUPPORTED");
    const attempts = await db`SELECT * FROM job_attempts WHERE job_id=${sourceId} ORDER BY attempt_no FOR UPDATE`;
    const latest = attempts.at(-1);
    if (!latest || latest.status === "active" || latest.cancel_requested) return deny("CONTINUATION_SOURCE_OWNER_UNRESOLVED");
    const [request] = await db`SELECT * FROM human_requests WHERE id=${input.request_id} AND job_id=${sourceId} FOR UPDATE`;
    if (!request || request.project_id !== source.project_id || request.canvas_id !== source.canvas_id
      || Number(request.revision) !== input.expected_revision || request.reply_message_id !== input.reply_message_id
      || request.attempt_id !== latest.id || request.resumed_at || request.status !== "closed" || request.close_reason !== "failed") return deny("CONTINUATION_REQUEST_CHANGED");
    if (request.checkpoint_status !== "ready" || !request.process_exited_at || !request.resources_released_at)
      return deny("CONTINUATION_CHECKPOINT_NOT_READY");
    if (Date.parse(String(request.checkpoint_expires_at)) <= Date.now()) return deny("HUMAN_CHECKPOINT_EXPIRED");
    const manifest = HumanCheckpointManifest.safeParse(request.manifest_json);
    if (!manifest.success || manifest.data.job_id !== sourceId || manifest.data.attempt_id !== latest.id
      || manifest.data.request_id !== request.id || manifest.data.snapshot_sha256 !== humanSnapshotDigest(source.agent_snapshot_json))
      return deny("CONTINUATION_CHECKPOINT_IDENTITY_CHANGED");
    const [message] = await db`SELECT * FROM human_messages WHERE id=${input.reply_message_id}
      AND request_id=${request.id} AND target_job_id=${sourceId} FOR UPDATE`;
    if (!message || !["planned", "acknowledged"].includes(message.delivery_status)
      || (message.delivery_status === "planned" && message.delivery_started_at)) return deny("CONTINUATION_REPLY_UNRESOLVED");
    const [resources] = await db`SELECT id FROM device_leases WHERE job_id=ANY(${jobIds}::uuid[]) AND state IN ('pending','active') LIMIT 1`;
    if (resources) return deny("CONTINUATION_RESOURCES_PENDING");
    const [lease] = await db`SELECT sandbox_id FROM worker_sandbox_leases WHERE job_id=ANY(${jobIds}::text[]) LIMIT 1`;
    if (lease) return deny("CONTINUATION_RESOURCES_PENDING");
    const [unresolved] = await db`SELECT e.id FROM job_attempt_effects e LEFT JOIN job_usage_ledger l
      ON l.job_id=e.job_id AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
      WHERE e.job_id=ANY(${jobIds}::uuid[]) AND (e.status<>'settled' OR e.settled_at IS NULL
        OR (e.effect_kind='gateway_model_request' AND l.settlement_status IS DISTINCT FROM 'settled')) LIMIT 1`;
    if (unresolved) return deny("CONTINUATION_LEDGER_UNRESOLVED");
    const [missingUsage] = await db`SELECT t.id FROM job_tokens t
      LEFT JOIN LATERAL (SELECT count(*)::int AS count,COALESCE(sum(l.total_tokens),0) AS tokens
        FROM job_usage_ledger l WHERE l.job_token_id=t.id AND l.settlement_status='settled') ledger ON true
      WHERE t.job_id=ANY(${jobIds}::uuid[]) AND (t.used_requests<>ledger.count OR t.used_tokens<>ledger.tokens) LIMIT 1`;
    if (missingUsage) return deny("CONTINUATION_BUDGET_EVIDENCE_MISSING");
    const [clock] = await db`SELECT * FROM job_execution_clocks WHERE job_id=${rootId} FOR UPDATE`;
    const knobs = snapshot.runtime_knobs as Record<string, unknown> | undefined;
    if (!knobs || Number(knobs.timeout_sec) !== Number(source.timeout_sec)
      || Number(clock?.budget_ms) !== Number(source.timeout_sec) * 1000) return deny("CONTINUATION_CLOCK_EVIDENCE_MISSING");
    if (!clock || clock.attempt_id !== latest.id) return deny("CONTINUATION_CLOCK_EVIDENCE_MISSING");
    if (clock.active_since) await pauseHumanExecutionClock(db, sourceId, String(latest.id));
    const remaining = await remainingHumanExecutionMs(db, sourceId);
    if (remaining === null || remaining <= 0) return deny("EXECUTION_TIME_EXHAUSTED");
    const policy = await inspectGatewayRequestBudget(db, sourceId, source.agent_snapshot_json);
    const [receipt] = await db`SELECT id FROM events WHERE job_id=${rootId} AND type='control_receipt'
      AND payload_json->>'authority'='kernel' AND payload_json->>'operation'='gateway_request_budget' LIMIT 1`;
    if (!receipt) return deny("CONTINUATION_BUDGET_EVIDENCE_MISSING");
    if ((await readHistoricalRequestBudget(db, sourceId, "main", policy)).exhausted) return deny("REPAIR_REQUESTS_EXHAUSTED");
    const repair = await readRepairRequeueAdmission(db, sourceId);
    if (repair.blocker) return deny(repair.blocker.code);
    if (await frozenSnapshotStaleDetail(db, source)) return deny("CONTINUATION_SNAPSHOT_CHANGED");
    if ((await requeueTargetAuthorizationBlockers(db, source, source.agent_snapshot_json, "resume-frozen")).length)
      return deny("TARGET_AUTHORIZATION_BLOCKED");
    for (const file of manifest.data.files) await readCheckpointFile(String(request.id), file);
    await readAcknowledgedHumanAttachments(sourceId, db);
    const targetId = randomUUID(), replyId = randomUUID(), nodeId = randomUUID();
    await reserveHistoricalPlanContinuation(db, source, canvas);
    await db`INSERT INTO jobs(id,project_id,canvas_id,parent_job_id,finding_id,type,status,priority,payload_json,
      agent_snapshot_json,timeout_sec,followup_depth,budget_owner_job_id)
      VALUES(${targetId},${source.project_id},${source.canvas_id},${source.parent_job_id},${source.finding_id},${source.type},
        'pending',${source.priority},${db.json(source.payload_json)},${db.json(source.agent_snapshot_json)},
        ${source.timeout_sec},${source.followup_depth},${rootId})`;
    await recordJobSharedAssets(db, targetId, (source.agent_snapshot_json as AgentRuntimeSnapshot).shared_assets ?? []);
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${nodeId},${source.canvas_id},${targetId},'job','历史断点续做','pending',${db.json({ source_job_id: sourceId })})`;
    // The historical message keeps its target and delivery record. The new inbox gets an explicit receiver.
    const humanNode = randomUUID();
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,body_json)
      VALUES(${humanNode},${source.canvas_id},'human','续做回复','planned',${db.json({ message_id: replyId, source_message_id: message.id })})`;
    await db`INSERT INTO human_messages(id,canvas_id,human_node_id,target_kind,target_node_id,target_job_id,body,
      delivery_status,acknowledged_at,ack_summary)
      VALUES(${replyId},${source.canvas_id},${humanNode},'job',${nodeId},${targetId},${message.body},
        ${message.delivery_status},${message.acknowledged_at},${message.ack_summary})`;
    await db`INSERT INTO human_message_attachments(message_id,version_id,filename,workspace_path,content_sha256,bytes)
      SELECT ${replyId},version_id,filename,replace(workspace_path,${`/inbox/${String(message.id)}/`},${`/inbox/${replyId}/`}),content_sha256,bytes
      FROM human_message_attachments WHERE message_id=${message.id}`;
    const checkpointDigest = humanSnapshotDigest(manifest.data);
    // execution_deadline_at is an active-time projection. Repair receipts hold absolute hard deadlines.
    const hardDeadline = repair.deadline;
    const [binding] = await db`INSERT INTO job_continuations(target_job_id,source_job_id,source_attempt_id,budget_owner_job_id,
      request_id,request_revision,mutation_id,input_sha256,checkpoint_sha256,reply_message_id,execution_reply_id,hard_deadline_at)
      VALUES(${targetId},${sourceId},${latest.id},${rootId},${request.id},${request.revision},${input.mutation_id},${digest},
        ${checkpointDigest},${message.id},${replyId},${hardDeadline}) RETURNING *`;
    await revokeOldRuntimeGrants(db, sourceId, "historical_continuation");
    await db`UPDATE jobs SET budget_execution_job_id=${targetId} WHERE id=${rootId}`;
    if (repair.budget) {
      const eventId = randomUUID();
      await db`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${targetId})`;
      await db`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES(${targetId},${eventId},1,'control_receipt',${db.json({
        v: 1, authority: "scheduler", subtype: "repair_generation", root_receipt_ref: repair.budget.receipt_ref,
        supersedes_attempt_id: String(latest.id), target_job_id: targetId, target_attempt_no: 1,
        deadline: hardDeadline, mode: "historical-continuation",
      })})`;
    }
    await recordDurableSystemAudit({ action: "job.historical_continuation", actorId,
      projectId: String(source.project_id), resourceType: "job", resourceId: targetId,
      after: { source_job_id: sourceId, target_job_id: targetId, budget_owner_job_id: rootId,
        request_id: String(request.id), mutation_id: input.mutation_id, checkpoint_sha256: checkpointDigest } }, db);
    await db`SELECT pg_notify('deepsonar_jobs','historical_continuation')`;
    return binding;
  });
}
