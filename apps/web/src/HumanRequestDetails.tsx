import type { HumanRequestGuidance } from "@deepsonar/shared-types";

export function HumanRequestDetails({
  reason,
  guidance,
  guidanceStatus,
  detailStatus,
  detailVersionMatches,
  detailError,
  safetyMessage,
  onRetry,
  showQuestion = true,
}: {
  reason: string;
  guidance: HumanRequestGuidance | null;
  guidanceStatus: "loading" | "error" | "available" | "missing";
  detailStatus: "loading" | "error" | "loaded";
  detailVersionMatches: boolean;
  detailError?: string;
  safetyMessage?: string | null;
  onRetry?: () => void;
  showQuestion?: boolean;
}) {
  const fullReasonLoaded = detailStatus === "loaded";
  const rows = guidance ? [
    ["需要你做什么", guidance.required_action],
    ["怎样回复", guidance.reply_instructions],
    ["回复后的处理计划", guidance.after_reply],
  ] as const : [];

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
      {guidanceStatus === "missing" && <p>此请求未提供完整操作指引；请根据完整原因和关联证据处理，不要猜测缺失步骤。</p>}
      {guidanceStatus === "error" && <p>尚未读取到完整操作指引。</p>}
      {guidanceStatus === "loading" && <p>正在读取完整操作指引。</p>}
      {guidance && (
        <div className="space-y-2">
          {showQuestion && <div><strong className="text-zinc-300">问题：</strong><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{guidance.question}</p></div>}
          {rows.map(([label, value]) => (
            <div key={label}>
              <strong className="text-zinc-300">{label}：</strong>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</p>
            </div>
          ))}
        </div>
      )}
      {safetyMessage && <p className="text-amber-200">权限与配置边界：{safetyMessage}</p>}
      <details>
        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
          {fullReasonLoaded ? "查看完整请求原因" : "查看当前原因摘要（最多 500 字）"}
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-zinc-400 [overflow-wrap:anywhere]">{reason || "此请求没有提供原因正文。"}</p>
      </details>
    </div>
  );
}
