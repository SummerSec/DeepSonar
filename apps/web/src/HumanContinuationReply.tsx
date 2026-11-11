import { useRef, useState } from "react";
import { api, type HumanContinuation } from "./api";

export function HumanContinuationReply({ continuation, canvasId, canReply }: {
  continuation: HumanContinuation; canvasId: string; canReply: boolean;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<{ id: string; body: string } | null>(null);
  const sendingRef = useRef(false);
  const answered = continuation.status === "answered" || saved;
  const blocker = continuation.checkpoint_error_code ?? continuation.resume_error_code;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sendingRef.current || answered || !body.trim()) return;
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
    {continuation.overdue_at && <p>回复时间已超过提醒阈值，仍可回复此请求。</p>}
    <p>{continuation.checkpoint_status === "preparing" ? "正在保存进度和释放运行资源。"
      : continuation.checkpoint_status === "ready" ? "进度已保存，将依据保存的进度在新会话继续。"
      : "进度保存未完成，续做已阻塞。"}</p>
    {blocker && <p role="status">{answered ? "回复已保存，续做等待处理：" : "续做等待处理："}{blocker}</p>}
    {answered ? <p role="status">回复已保存。平台核验断点、权限和剩余额度后继续；任务尚未完成。</p>
      : canReply && continuation.status === "open" && <form onSubmit={submit}>
        <label className="mt-3 block">回复人工请求
          <textarea value={body} maxLength={8000} disabled={sending} onChange={event => setBody(event.target.value)}
            className="mt-1 block min-h-24 w-full rounded-lg bg-zinc-950 p-3 text-zinc-200 ring-1 ring-zinc-700"
            placeholder="说明核对结果或配置引用，请勿粘贴密钥。" />
        </label>
        <button type="submit" disabled={sending || !body.trim()} className="human-message-inline-action mt-2 min-h-11 disabled:opacity-50">
          {sending ? "正在保存回复…" : "回复并继续"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>}
  </div>;
}
