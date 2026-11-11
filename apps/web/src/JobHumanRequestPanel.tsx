import type { JobDetail, JobHumanRequest } from "./api";
import { HumanRequestDetails } from "./HumanRequestDetails";

const SUBJECT_LABELS = {
  credential: "凭据配置",
  authorization: "授权确认",
  high_risk_action: "高风险操作确认",
  business_decision: "业务决定",
};

export function JobHumanRequestPanel({ request, status, onSendMessage }: {
  request: JobHumanRequest | null;
  status: string;
  onSendMessage?: () => void;
}) {
  if (request === null) {
    return <section aria-label="人工请求" className="theme-surface rounded-2xl p-4 ring-1">
      <h3 className="text-[13px] font-medium text-zinc-200">人工请求</h3>
      <p className="mt-2 text-[12px] text-zinc-500">无持久人工请求。</p>
    </section>;
  }

  const current = request.current && (status === "running" || status === "waiting_human");
  const terminal = ["succeeded", "failed", "timeout", "cancelled", "orphan"].includes(status);
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
          ? "请按以下指引处理，可通过任务中的人工消息入口回复。回复是否被接受及后续执行以平台核验结果为准。"
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
      />
      {current && onSendMessage && <button type="button" onClick={onSendMessage}
        className="human-message-inline-action mt-3 min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300">
        打开任务人工消息
      </button>}
    </section>
  );
}

export function JobHumanRequestSection({ detail, onSendMessage }: {
  detail: Pick<JobDetail, "job" | "human_request">;
  onSendMessage?: () => void;
}) {
  if (detail.human_request === null && detail.job.execution_state?.accepted_terminal !== "human" && detail.job.status !== "waiting_human") return null;
  return <div className="m-4">
    <JobHumanRequestPanel request={detail.human_request} status={detail.job.status} onSendMessage={onSendMessage} />
  </div>;
}
