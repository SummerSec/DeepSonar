import { useRef, useState } from "react";
import { api, type HumanContinuation } from "./api";

const checkpointReasons = new Map<string, string>([
  ["HUMAN_CHECKPOINT_SECRET_DETECTED", "保存现场时检出受保护的凭据，平台已停止保存。"],
  ["HUMAN_CHECKPOINT_EXPIRED", "保存的现场已过期。"],
  ["HUMAN_CHECKPOINT_SIZE_LIMIT", "现场文件超过保存上限。"],
  ["HUMAN_CHECKPOINT_TIMEOUT", "保存现场超时。"],
  ["HUMAN_CHECKPOINT_CAPTURE_FAILED", "平台未能保存现场。"],
  ["HUMAN_CHECKPOINT_SCAN_FAILED", "平台未能完成现场文件检查。"],
  ["HUMAN_CHECKPOINT_FILE_CHANGED", "现场文件在保存期间发生了变化。"],
  ["HUMAN_CHECKPOINT_WORKSPACE_CHANGED", "工作区在保存期间发生了变化。"],
  ["HUMAN_CHECKPOINT_HASH_MISMATCH", "现场文件未通过完整性校验。"],
  ["HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE", "平台无法核对保存前的进程状态。"],
  ["HUMAN_CHECKPOINT_GUARD_UNAVAILABLE", "平台无法确认工作区在保存期间保持稳定。"],
  ["HUMAN_CHECKPOINT_GUARD_TIMEOUT", "等待工作区稳定时超时。"],
  ["HUMAN_CHECKPOINT_NOT_READY", "现场尚未准备好，稍后可再查看运行详情。"],
  ["HUMAN_CHECKPOINT_OWNER_CHANGED", "当前运行与断点记录的执行轮次不一致。"],
  ["HUMAN_CHECKPOINT_IDENTITY_CHANGED", "当前运行与断点记录的身份不一致。"],
  ["HUMAN_CONTINUATION_RESOURCES_PENDING", "原运行的资源仍在回收，稍后可再查看运行详情。"],
  ["HUMAN_CONTINUATION_USAGE_UNKNOWN", "原运行的用量尚未结清，请联系管理员核对用量记录。"],
  ["HUMAN_CONTINUATION_DELIVERY_UNRESOLVED", "上次回复的投递结果待核对，请联系管理员查看消息记录。"],
  ["EXECUTION_TIME_EXHAUSTED", "原运行的可用时间已耗尽或无法确认，请联系管理员核对。"],
  ["REPAIR_PAUSED", "任务已暂停，可到任务工作台核对暂停状态。"],
  ["SNAPSHOT_STALE", "原运行的配置已失效，请联系管理员核对。"],
]);

export function HumanContinuationReply({ continuation, canvasId, canReply }: {
  continuation: HumanContinuation; canvasId?: string | null; canReply: boolean;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<{ id: string; body: string } | null>(null);
  const sendingRef = useRef(false);
  const answered = continuation.status === "answered" || saved;
  const blocked = continuation.checkpoint_status === "blocked";
  const blocker = blocked ? continuation.checkpoint_error_code : continuation.resume_error_code;
  const reason = checkpointReasons.get(blocker ?? "");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canvasId || sendingRef.current || answered || !body.trim()) return;
    // A transport retry retains its exact payload and ID. Editing creates a new proposal.
    if (!submission.current || submission.current.body !== body.trim()) {
      submission.current = { id: crypto.randomUUID(), body: body.trim() };
    }
    sendingRef.current = true;
    setSending(true); setError(null);
    try {
      await api.createCanvasMessage(canvasId, { message_id: submission.current.id,
        target: { kind: "request", request_id: continuation.id, expected_revision: continuation.revision },
        body: submission.current.body, attachment_version_ids: [] });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回复未确认保存，请重试读取当前请求。");
    } finally { sendingRef.current = false; setSending(false); }
  }
  return <div className="mt-3 text-[12px] leading-5 text-zinc-400">
    {continuation.overdue_at && !answered && !blocked && continuation.status === "open" && <p>回复时间已超过提醒阈值，仍可回复此请求。</p>}
    {answered && <p role="status">回复已保存，无需再次回复。</p>}
    {blocked ? <div role="status" className="text-amber-300">
      <p>断点不可用。{reason ?? "当前运行无法从这个现场继续。"}
        {reason && <>（{blocker}）</>}</p>
      <p>要结束本次运行，有操作权限的人可在运行详情选择「强制退出」并确认。要从头开始，可到项目的「任务工作台」选择「下达任务」，新任务不会继承这个现场。</p>
    </div> : <>
      <p>{continuation.checkpoint_status === "preparing" ? "正在保存进度和释放运行资源。"
        : "进度已保存。平台核验通过后可在新会话继续。"}</p>
      {blocker && <p role="status">续做暂受阻。{reason ? <>{reason}（{blocker}）</> : "请联系管理员核对本次运行记录。"}</p>}
    </>}
    {!answered && canvasId && canReply && continuation.status === "open" && <form onSubmit={submit}>
        <label className="mt-3 block">回复人工请求
          <textarea value={body} maxLength={8000} disabled={sending} onChange={event => setBody(event.target.value)}
            className="mt-1 block min-h-24 w-full rounded-lg bg-zinc-950 p-3 text-zinc-200 ring-1 ring-zinc-700"
            placeholder="说明核对结果或配置引用，请勿粘贴密钥。" />
        </label>
        <button type="submit" disabled={sending || !body.trim()} className="human-message-inline-action mt-2 min-h-11 disabled:opacity-50">
          {sending ? "正在保存回复…" : blocked ? "仅保存回复" : "回复并继续"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>}
  </div>;
}
