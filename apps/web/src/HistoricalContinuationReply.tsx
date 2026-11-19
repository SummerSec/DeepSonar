import { useRef, useState } from "react";
import { api, type HumanContinuation } from "./api";
import { ApiRequestError } from "./login-error";

function submissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function HistoricalContinuationReply({ jobId, continuation }: {
  jobId: string; continuation: HumanContinuation;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(Boolean(continuation.reply_message_id));
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const submission = useRef<Parameters<typeof api.createHistoricalContinuation>[1] | null>(null);
  const sending = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || target || (!saved && !body.trim())) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      // Keep the exact IDs, revision and input through a lost response or a saved-reply blocker.
      submission.current ??= {
        mutation_id: submissionId(), request_id: continuation.id, expected_revision: continuation.revision,
        ...(continuation.reply_message_id ? { saved_reply_message_id: continuation.reply_message_id }
          : { reply: { message_id: submissionId(), body: body.trim(), attachment_version_ids: [] } }),
      };
      const result = await api.createHistoricalContinuation(jobId, submission.current);
      setSaved(true);
      setTarget(result.job_id);
    } catch (cause) {
      const replyState = cause instanceof ApiRequestError
        ? (cause.taskContractFeedback as Record<string, unknown>).reply_state : null;
      if (replyState === "reply_saved") setSaved(true);
      else if (!submission.current || replyState === "reply_not_saved" || (cause instanceof ApiRequestError && cause.status === 400)) {
        submission.current = null;
        setUncertain(false);
      } else setUncertain(true);
      setError(cause instanceof Error ? cause.message : "续做结果尚未确认，请重试查询。");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return <div className="mt-3 text-[12px] leading-5 text-zinc-400">
    <p>平台会核对保存的进度、当前权限和原剩余额度，并创建新的运行继续处理。属于 Plan 的续做会占用一个剩余任务名额。</p>
    {target ? <p role="status">续做已排队。<a className="human-message-inline-action" href={`/jobs?job=${encodeURIComponent(target)}`}>查看续做运行</a></p>
      : <form onSubmit={submit}>
        {saved ? <p role="status">回复已保存，可重试核验续做条件。</p>
          : <label className="mt-3 block">回复历史人工请求
            <textarea value={body} maxLength={8000} disabled={busy || uncertain}
              onChange={event => setBody(event.target.value)}
              className="mt-1 block min-h-24 w-full rounded-lg bg-zinc-950 p-3 text-zinc-200 ring-1 ring-zinc-700"
              placeholder="说明核对结果或配置引用，请勿粘贴密钥。" />
          </label>}
        <button type="submit" disabled={busy || (!saved && !body.trim())}
          className="human-message-inline-action mt-2 min-h-11 disabled:opacity-50">
          {busy ? "正在核验续做…" : "基于保存进度继续"}
        </button>
      </form>}
    {error && <p role="alert">{error}</p>}
    {uncertain && !saved && <p role="status">回复保存结果尚未确认，请用原内容重试。</p>}
  </div>;
}
