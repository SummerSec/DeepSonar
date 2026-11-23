import type { HumanRequestGuidance } from "@deepsonar/shared-types";
import { humanInterventionSafetyMessage } from "./human-messages";

export function HumanRequestDetails({
  reason,
  guidance,
  guidanceStatus,
  detailStatus,
  detailVersionMatches,
  detailError,
  subjectKind,
  onRetry,
}: {
  reason: string;
  guidance: HumanRequestGuidance | null;
  guidanceStatus: "loading" | "error" | "available" | "missing";
  detailStatus: "loading" | "error" | "loaded";
  detailVersionMatches: boolean;
  detailError?: string;
  subjectKind?: string | null;
  onRetry?: () => void;
}) {
  const fullReasonLoaded = detailStatus === "loaded";
  const safetyMessage = humanInterventionSafetyMessage(subjectKind ?? null);

  return (
    <div className="mt-2 space-y-2 text-[11px] leading-5 text-zinc-400">
      {detailStatus === "loading" && <p role="status">正在读取完整请求内容；当前仅显示最多 500 字的原因摘要。</p>}
      {detailStatus === "error" && (
        <p role="alert" className="text-amber-300">
          完整请求读取失败{detailError ? `：${detailError}` : ""}；当前仅显示最多 500 字的原因摘要。
          {onRetry && <button type="button" className="ml-2 underline underline-offset-2" onClick={onRetry}>重试读取</button>}
        </p>
      )}
      {fullReasonLoaded && !detailVersionMatches && (
        <p role="status" className="text-amber-300">请求详情版本与画布摘要不同，暂不允许按旧关联回复；等待列表同步最新状态。</p>
      )}
      {guidanceStatus === "missing" && <p>此请求未提供完整操作指引。</p>}
      {guidanceStatus === "error" && <p>尚未读取到完整操作指引。</p>}
      {guidanceStatus === "loading" && <p>正在读取完整操作指引。</p>}
      <p>请核对请求来源，只回复核对结果或配置引用。请勿在回复或附件中提供密码、令牌或密钥。</p>
      {safetyMessage && <p className="text-amber-200">{safetyMessage}</p>}
      <details>
        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
          {fullReasonLoaded ? "查看请求原文（未经核验）" : "查看请求摘要（未经核验，最多 500 字）"}
        </summary>
        <blockquote className="mt-1 space-y-2 whitespace-pre-wrap break-words border-l-2 border-zinc-600 pl-3 [overflow-wrap:anywhere]">
          {guidance && <>
            <p>原问题 · {guidance.question}</p>
            <p>请求方建议 · {guidance.required_action}</p>
            <p>请求方建议的回复方式 · {guidance.reply_instructions}</p>
            <p>请求方计划 · {guidance.after_reply}</p>
          </>}
          <p>请求原因 · {reason || "此请求没有提供原因正文。"}</p>
        </blockquote>
      </details>
    </div>
  );
}
