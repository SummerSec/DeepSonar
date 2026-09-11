import { REPAIR_CATEGORY_META, type RepairFeedback } from "./repair-feedback";

export function RepairFeedbackPanel({ feedback }: { feedback: RepairFeedback }) {
  const meta = REPAIR_CATEGORY_META[feedback.category];
  return (
    <section
      aria-label="修复反馈"
      className="rounded-2xl px-4 py-3 ring-1"
      style={{
        color: meta.tone,
        background: `color-mix(in srgb, ${meta.tone} 7%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${meta.tone} 18%, transparent)`,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium">{meta.label}</span>
        {feedback.stage && <span className="font-mono text-[10px] text-zinc-500">阶段 {feedback.stage}</span>}
      </div>
      <dl className="mt-3 grid gap-2 text-[12px] text-zinc-300 sm:grid-cols-2">
        <Datum label="字段路径" value={feedback.field_path ?? "未从当前错误解析到字段"} />
        <Datum label="期望" value={feedback.expected ?? "当前没有结构化期望形状"} />
        <Datum label="当前观测" value={feedback.observed ?? "没有可展示的观测值"} wide />
        <Datum label="已接受效果" value={feedback.accepted_effects.join("；") || "无"} />
        <Datum label="可用替代" value={feedback.alternatives.join("；") || "无"} />
        <Datum label="剩余修复预算" value={feedback.remaining_budget ?? "账本未提供剩余预算"} />
      </dl>
      <p className="mt-3 text-[12px] leading-5 text-zinc-400">{feedback.next_step}</p>
      {!meta.allowUnconditionalRetry && (
        <p className="mt-2 text-[11px] leading-5 text-zinc-500">
          {feedback.category === "unknown_external_effect"
            ? "这不是普通失败。未确认外部效果前，界面不会提供无条件重试。"
            : "不要无上下文重放这次运行。"}
        </p>
      )}
    </section>
  );
}

function Datum({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">{label}</dt>
      <dd className="mt-1 break-words text-zinc-300">{value}</dd>
    </div>
  );
}
