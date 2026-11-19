import { DISPATCH_CLAIM_ADVISORY_KEY } from "../../core.js";
import { requeueYieldedHumanReply } from "../project-task/task-queue-yield.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { maybeTriggerHub } from "../../core.js";
import { sql } from "../../db.js";
import { beginEffect, markEffectUnknown, settleEffect } from "../job-attempt/index.js";
import { readSharedAssetBlob } from "../shared-assets/index.js";
import { pumpHumanContinuations } from "../job-control/human-continuation-pump.js";

export type HumanMessageStatus = "planned" | "injected" | "acknowledged" | "unknown" | "failed";

export interface HumanMessageAttachment {
  version_id: string;
  filename: string;
  workspace_path: string;
  content_sha256: string;
  bytes: number;
  blob_uri: string;
}

export interface HumanMessageRuntimeControl {
  sendMessage(content: string): Promise<void>;
  writeWorkspaceFile(filePath: string, bytes: Buffer): Promise<void>;
}

const ACTIVE_STATUSES = ["pending", "claimed", "provisioning", "running", "waiting_human"];
const runtimeControls = new Map<string, {control:HumanMessageRuntimeControl;attemptId:string}>();

export function safeHumanMessageFilename(value: string): string {
  const base = path.posix.basename(value.replaceAll("\\", "/"));
  const safe = base.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 180);
  return safe || "attachment";
}

export function humanMessageWorkspacePath(messageId: string, filename: string): string {
  return `/workspace/.deepsonar/inbox/${messageId}/${safeHumanMessageFilename(filename)}`;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

function deliveryText(message: Record<string, unknown>, attachments: HumanMessageAttachment[]): string {
  const attachmentLines = attachments.length === 0
    ? "无"
    : attachments.map((item) => `- ${item.workspace_path} (sha256=${item.content_sha256}, bytes=${item.bytes})`).join("\n");
  return `[DeepSonar 人工消息]\nmessage_id: ${String(message.id)}\n\n${String(message.body)}\n\n不可变附件：\n${attachmentLines}\n\n请明确处理这条人工消息；完成阅读与纳入工作后，必须调用 ack_human_message({ message_id: \"${String(message.id)}\" })。普通文本回复不会被视为确认。`;
}

async function loadAttachments(messageId: string): Promise<HumanMessageAttachment[]> {
  const rows = await sql`
    SELECT a.version_id, a.filename, a.workspace_path, a.content_sha256, a.bytes, b.blob_uri
    FROM human_message_attachments a
    JOIN shared_asset_versions v ON v.id = a.version_id
    JOIN shared_asset_blobs b ON b.content_sha256 = v.content_sha256
    WHERE a.message_id = ${messageId}
    ORDER BY a.workspace_path`;
  return rows.map((row) => ({ ...row, bytes: Number(row.bytes) })) as unknown as HumanMessageAttachment[];
}

export async function deliverHumanMessage(messageId: string, control?: HumanMessageRuntimeControl): Promise<HumanMessageStatus> {
  let message: Record<string, unknown> | undefined;
  let attemptId: string | undefined;
  let effectId: string | undefined;
  let sendAttempted = false;
  try {
    [message] = await sql`
      SELECT m.*, a.id AS attempt_id,a.attempt_no,r.target_attempt_no,r.resumed_at
      FROM human_messages m
      JOIN jobs j ON j.id = m.target_job_id
      LEFT JOIN job_attempts a ON a.job_id = j.id AND a.status = 'active'
      LEFT JOIN human_requests r ON r.id=m.request_id
      WHERE m.id = ${messageId}`;
    if (!message || message.delivery_status !== "planned") return (message?.delivery_status ?? "failed") as HumanMessageStatus;
    if (message.delivery_started_at) {
      await sql`UPDATE human_messages SET delivery_status='unknown', error='delivery settlement missing; never replayed', updated_at=now() WHERE id=${messageId} AND delivery_status='planned'`;
      return "unknown";
    }
    const registered=runtimeControls.get(String(message.target_job_id));
    const activeControl = control ?? registered?.control;
    if (!activeControl || !message.attempt_id || ((!control || message.request_id) && registered?.attemptId!==String(message.attempt_id))) return "planned";
    if(message.request_id&&(!message.resumed_at||message.attempt_no!==message.target_attempt_no)) return "planned";
    attemptId = String(message.attempt_id);
    effectId = `human_message:${messageId}`;
    const attachments = await loadAttachments(messageId);
    const inputDigest = createHash("sha256")
      .update(JSON.stringify({ id: messageId, body: message.body, attachments: attachments.map(({ version_id, content_sha256, bytes }) => ({ version_id, content_sha256, bytes })) }))
      .digest("hex");

    const attachmentBytes: Array<{ attachment: HumanMessageAttachment; bytes: Buffer }> = [];
    for (const attachment of attachments) {
      const bytes = await readSharedAssetBlob(attachment.blob_uri);
      if (bytes.byteLength !== attachment.bytes || createHash("sha256").update(bytes).digest("hex") !== attachment.content_sha256) {
        throw new Error("human_message_attachment_integrity_failed");
      }
      attachmentBytes.push({ attachment, bytes });
    }

    for (const { attachment, bytes } of attachmentBytes) {
      await activeControl.writeWorkspaceFile(attachment.workspace_path, bytes);
    }

    const started = await sql.begin(async (tx) => {
      const claimed = await tx`
        UPDATE human_messages SET delivery_started_at=now(), updated_at=now()
        WHERE id=${messageId} AND delivery_status='planned' AND delivery_started_at IS NULL
        RETURNING id`;
      if (claimed.length === 0) return false;
      const attempt = await beginEffect(tx as unknown as typeof sql, attemptId!, {
        effectId: effectId!,
        kind: "canvas_delivery",
        replayPolicy: "never",
        inputDigest,
        resourceIdentity: { canvas_id: String(message!.canvas_id), message_id: messageId, target_job_id: String(message!.target_job_id) },
        intent: { kind: "human_message", attachment_count: attachments.length },
      });
      if (!attempt) throw new Error("目标 Job 的活动 Attempt 已结束");
      return true;
    });
    if (!started) return "planned";

    sendAttempted = true;
    await activeControl.sendMessage(deliveryText(message, attachments));
    await sql.begin(async (tx) => {
      await tx`UPDATE human_messages SET delivery_status='injected', delivered_at=now(), updated_at=now() WHERE id=${messageId} AND delivery_status='planned'`;
      await tx`UPDATE canvas_nodes SET status='injected', updated_at=now() WHERE id=${String(message!.human_node_id)}`;
      await settleEffect(tx as unknown as typeof sql, attemptId!, effectId!, { status: "settled", outcome: { delivery_status: "injected" } });
    });
    return "injected";
  } catch (error) {
    const safeError = boundedError(error);
    const status: HumanMessageStatus = sendAttempted ? "unknown" : "failed";
    try {
      await sql.begin(async (tx) => {
        const [current] = await tx`SELECT human_node_id FROM human_messages WHERE id=${messageId} AND delivery_status='planned' FOR UPDATE`;
        if (!current) return;
        await tx`UPDATE human_messages SET delivery_status=${status}, error=${safeError}, updated_at=now() WHERE id=${messageId} AND delivery_status='planned'`;
        await tx`UPDATE canvas_nodes SET status=${status}, updated_at=now() WHERE id=${String(current.human_node_id)}`;
        if (sendAttempted && attemptId && effectId) await markEffectUnknown(tx as unknown as typeof sql, attemptId, effectId, safeError);
      });
    } catch (settlementError) {
      console.error(`[human-message] delivery settlement failed message=${messageId}:`, boundedError(settlementError));
    }
    console.error(`[human-message] delivery failed message=${messageId} status=${status}:`, safeError);
    return status;
  }
}

export async function registerHumanMessageRuntime(jobId: string, control: HumanMessageRuntimeControl, expectedAttemptId?:string): Promise<() => void> {
  const [attempt]=await sql`SELECT id FROM job_attempts WHERE job_id=${jobId} AND status='active'`;
  if(!attempt||(expectedAttemptId&&attempt.id!==expectedAttemptId)) throw new Error("HUMAN_MESSAGE_ATTEMPT_NOT_ACTIVE");
  const registration={control,attemptId:String(attempt.id)};
  runtimeControls.set(jobId, registration);
  const planned = await sql`
    SELECT id FROM human_messages
    WHERE target_job_id=${jobId} AND delivery_status='planned'
    ORDER BY planned_at, id`;
  for (const message of planned) await deliverHumanMessage(String(message.id), control);
  return () => {
    if (runtimeControls.get(jobId) === registration) runtimeControls.delete(jobId);
  };
}

export async function createHumanMessage(input: {
  id: string;
  canvasId: string;
  target: { kind: "hub" } | { kind: "job"; node_id: string }
    | {kind:"request";request_id:string;expected_revision:number};
  body: string;
  attachmentVersionIds: string[];
}): Promise<Record<string, unknown>> {
  const attachmentVersionIds = [...new Set(input.attachmentVersionIds)].sort();
  const result = await sql.begin(async (tx) => {
    if (input.target.kind === "request") await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
    const [canvas] = await tx`SELECT id, project_id FROM canvases WHERE id=${input.canvasId} FOR UPDATE`;
    if (!canvas) throw Object.assign(new Error("canvas not found"), { statusCode: 404 });
    const [existing] = await tx`SELECT * FROM human_messages WHERE id=${input.id}`;
    if (existing) {
      const sameTarget = input.target.kind==='request'
        ? existing.request_id===input.target.request_id&&Number(existing.request_revision)===input.target.expected_revision
        : !existing.request_id && existing.target_kind === input.target.kind &&
          (input.target.kind === "hub" || String(existing.target_node_id ?? "") === input.target.node_id);
      if (String(existing.canvas_id) !== input.canvasId || String(existing.body) !== input.body || !sameTarget) {
        throw Object.assign(new Error("message_id 已用于不同消息"), { statusCode: 409 });
      }
      const attached = await tx`SELECT version_id FROM human_message_attachments WHERE message_id=${input.id} ORDER BY version_id`;
      const existingVersionIds = attached.map((row) => String(row.version_id)).sort();
      if (existingVersionIds.length !== attachmentVersionIds.length || existingVersionIds.some((id, index) => id !== attachmentVersionIds[index])) {
        throw Object.assign(new Error("message_id 已用于不同附件集合"), { statusCode: 409 });
      }
      return { message: existing, created: false };
    }
    let targetNode: Record<string, unknown> | undefined;
    let targetJob: Record<string, unknown> | undefined;
    let request:Record<string,unknown>|undefined;
    if(input.target.kind==='request') {
      const [locator]=await tx`SELECT job_id FROM human_requests WHERE id=${input.target.request_id} AND canvas_id=${input.canvasId}`;
      if(!locator) throw new HumanInterventionError(404,"HUMAN_REQUEST_NOT_FOUND","人工请求不存在或不属于当前任务。");
      [targetJob]=await tx`SELECT id,status FROM jobs WHERE id=${locator.job_id} AND canvas_id=${input.canvasId} FOR UPDATE`;
      const attempts=await tx`SELECT id,cancel_requested FROM job_attempts WHERE job_id=${locator.job_id} ORDER BY attempt_no FOR UPDATE`;
      [request]=await tx`SELECT * FROM human_requests WHERE id=${input.target.request_id} FOR UPDATE`;
      const historical = targetJob?.status === 'failed' && request?.status === 'closed' && request.close_reason === 'failed';
      if(!targetJob||(!historical && targetJob.status!=='waiting_human')||!request||(!historical && request.status!=='open')
        ||Number(request.revision)!==input.target.expected_revision||request.resumed_at
        ||(historical && request.reply_message_id)
        ||attempts.at(-1)?.id!==request.attempt_id||attempts.at(-1)?.cancel_requested)
        throw new HumanInterventionError(409,"HUMAN_REQUEST_CHANGED","请求已处理或状态已变化，请读取最新请求后再回复。");
      [targetNode]=await tx`SELECT id FROM canvas_nodes WHERE job_id=${locator.job_id} AND node_type='job' ORDER BY created_at DESC LIMIT 1`;
    } else if (input.target.kind === "job") {
      [targetNode] = await tx`
        SELECT n.id, n.job_id, n.title, n.node_type
        FROM canvas_nodes n JOIN jobs j ON j.id=n.job_id
        WHERE n.id=${input.target.node_id} AND n.canvas_id=${input.canvasId}
          AND n.node_type IN ('intent','job','report') AND j.status=ANY(${ACTIVE_STATUSES})
        FOR UPDATE OF j`;
      if (!targetNode?.job_id) throw Object.assign(new Error("目标节点不是该画布的活动运行节点"), { statusCode: 409 });
      [targetJob] = await tx`SELECT id, status FROM jobs WHERE id=${String(targetNode.job_id)}`;
    } else {
      [targetJob] = await tx`
        SELECT id, status FROM jobs WHERE canvas_id=${input.canvasId} AND type='hub_reason'
          AND status=ANY(${ACTIVE_STATUSES}) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
    }

    const humanNodeId = randomUUID();
    const [humanNode] = await tx`
      INSERT INTO canvas_nodes ${tx({
        id: humanNodeId,
        canvas_id: input.canvasId,
        node_type: "human",
        title: input.body.slice(0, 120),
        body_json: { message_id: input.id, target_kind: input.target.kind } as never,
        status: "planned",
      })} RETURNING id`;

    if (!targetJob && input.target.kind === "hub") {
      await maybeTriggerHub(tx as unknown as typeof sql, {
        id: null,
        project_id: canvas.project_id,
        canvas_id: input.canvasId,
        type: "human_message",
      }, { force: true, manual: true, sourceNodeIds: [humanNodeId], trigger: { kind: "human_message", message_id: input.id } });
      [targetJob] = await tx`
        SELECT id, status FROM jobs WHERE canvas_id=${input.canvasId} AND type='hub_reason'
          AND status IN ('pending','claimed','provisioning','running') ORDER BY created_at DESC LIMIT 1`;
    }
    if (!targetJob) throw new Error("无法建立人类消息目标 Job");

    const versions = attachmentVersionIds.length === 0 ? [] : await tx`
      SELECT v.id, v.content_sha256, v.bytes, a.logical_key
      FROM shared_asset_versions v JOIN shared_assets a ON a.id=v.asset_id
      WHERE v.id=ANY(${attachmentVersionIds}::uuid[]) AND a.project_id=${canvas.project_id}
        AND a.scope_type='project' AND a.status='active'`;
    if (versions.length !== attachmentVersionIds.length) {
      throw Object.assign(new Error("attachment_version_ids 仅允许本项目 active project 资产版本"), { statusCode: 400 });
    }

    const [message] = await tx`
      INSERT INTO human_messages
        (id, canvas_id, human_node_id, target_kind, target_node_id, target_job_id, body,request_id,request_revision)
      VALUES
        (${input.id}, ${input.canvasId}, ${String(humanNode.id)}, ${input.target.kind==='request'?'job':input.target.kind},
         ${targetNode?.id ? String(targetNode.id) : null}, ${String(targetJob.id)}, ${input.body},
         ${request?String(request.id):null},${input.target.kind==='request'?input.target.expected_revision:null})
      RETURNING *`;
    for (const version of versions) {
      const filename = safeHumanMessageFilename(String(version.logical_key));
      const workspaceFilename = `${String(version.id).slice(0, 8)}-${filename}`;
      await tx`
        INSERT INTO human_message_attachments
          (message_id, version_id, filename, workspace_path, content_sha256, bytes)
        VALUES
          (${input.id}, ${String(version.id)}, ${filename}, ${humanMessageWorkspacePath(input.id, workspaceFilename)},
           ${String(version.content_sha256)}, ${Number(version.bytes)})`;
    }
    if(request) {
      if (request.status !== "closed") await requeueYieldedHumanReply(tx as unknown as typeof sql, String(request.id));
