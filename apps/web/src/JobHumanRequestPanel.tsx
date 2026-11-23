import type { JobDetail, JobHumanRequest, HumanContinuation } from "./api";
import { HumanRequestDetails } from "./HumanRequestDetails";
import { HumanContinuationReply } from "./HumanContinuationReply";
import { HistoricalContinuationReply } from "./HistoricalContinuationReply";

const SUBJECT_LABELS = {
  credential: "凭据配置",
  authorization: "授权确认",
  high_risk_action: "高风险操作确认",
  business_decision: "业务决定",
};

export function JobHumanRequestPanel({ request, status, onSendMessage, continuation, canvasId, jobId, canControl = false }: {
  request: JobHumanRequest | null;
  status: string;
  onSendMessage?: () => void;
  continuation?: HumanContinuation | null;
  canvasId?: string | null;
  jobId?: string;
  canControl?: boolean;
}) {
  if (request === null) {
    return <section aria-label="人工请求" className="theme-surface rounded-2xl p-4 ring-1">
      <h3 className="text-[13px] font-medium text-zinc-200">人工请求</h3>
      <p className="mt-2 text-[12px] text-zinc-500">无持久人工请求。</p>
    </section>;
  }

  const current = request.current && (status === "running" || status === "waiting_human");
  const terminal = ["succeeded", "failed", "timeout", "cancelled", "orphan"].includes(status);
  const historical = status === "failed" && continuation?.status === "closed" && jobId && canControl;
  const { reason, subject, guidance } = request.payload;
  const subjectLabel = subject?.type === "finding" ? "证据判断"
    : subject?.type === "platform_blocker" ? SUBJECT_LABELS[subject.kind] : "人工请求";

  return (
    <section aria-label={current ? "当前人工请求" : "历史人工请求"} className="theme-surface rounded-2xl p-4 ring-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-medium text-zinc-200">{current ? "当前人工请求" : "历史人工请求"}</h3>
        <span className="text-[11px] text-zinc-500">{subjectLabel}</span>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-zinc-400">
        {current
          ? "以下是本次运行的人工请求。"
          : historical ? "本次运行已失败。可在下方基于保存的进度申请续做。"
          : terminal
            ? "本次运行已结束；以下为已保存的人工请求，仅供查看，不再等待此请求的回复。"
            : "此请求属于历史执行，当前运行不再等待此请求的回复，仅供查看。"}
      </p>
      <HumanRequestDetails
        reason={reason ?? ""}
        guidance={guidance ?? null}
        guidanceStatus={guidance ? "available" : "missing"}
        detailStatus="loaded"
        detailVersionMatches={true}
        subjectKind={subject?.type === "platform_blocker" ? subject.kind : null}
      />
      {current && continuation && canvasId && <HumanContinuationReply key={continuation.id}
        continuation={continuation} canvasId={canvasId} canReply={!!onSendMessage} />}
      {historical && <HistoricalContinuationReply key={continuation.id} jobId={jobId} continuation={continuation} />}
      {current && !continuation && onSendMessage && <button type="button" onClick={onSendMessage}
        className="human-message-inline-action mt-3 min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300">
        打开任务人工消息
      </button>}
    </section>
  );
}

export function JobHumanRequestSection({ detail, onSendMessage, canControl = false }: {
  detail: Pick<JobDetail, "job" | "human_request" | "human_continuation">;
  onSendMessage?: () => void;
  canControl?: boolean;
}) {
  if (detail.human_request === null && detail.job.execution_state?.accepted_terminal !== "human" && detail.job.status !== "waiting_human") return null;
  return <div className="m-4">
    <JobHumanRequestPanel request={detail.human_request} status={detail.job.status} onSendMessage={onSendMessage}
      continuation={detail.human_continuation} canvasId={detail.job.canvas_id} jobId={detail.job.id} canControl={canControl} />
  </div>;
}
