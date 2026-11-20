import { REPAIR_CATEGORY_META, type RepairFeedback } from "./repair-feedback";

export type RepairRecoveryAction = {
  id: string;
  label: string;
  title?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function RepairFeedbackPanel({
  feedback,
  recoveryActions,
}: {
  feedback: RepairFeedback;
  recoveryActions?: readonly RepairRecoveryAction[];
}) {
  const meta = REPAIR_CATEGORY_META[feedback.category];
  const showObserved = Boolean(feedback.observed);
  const showAccepted = feedback.accepted_effects.length > 0;
  const showAlternatives = feedback.alternatives.length > 0;
  const showBudget = Boolean(feedback.remaining_budget);
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
      <p className="text-sm leading-6 text-zinc-200">{feedback.summary}</p>
      <details className="mt-2 text-[12px] text-zinc-400">
        <summary className="cursor-pointer py-2 focus-visible:outline focus-visible:outline-2">技术诊断（维护者）</summary>
        <p>{meta.label}{feedback.stage && ` · ${feedback.stage}`}</p>
      <dl className="mt-3 grid gap-2 text-[12px] text-zinc-300 sm:grid-cols-2">
        {feedback.field_path && <Datum label="字段路径" value={feedback.field_path} />}
        {feedback.expected && <Datum label="期望" value={feedback.expected} />}
        {showObserved && <Datum label="当前观测" value={feedback.observed!} wide />}
        {showAccepted && <Datum label="已接受效果" value={feedback.accepted_effects.join(" · ")} />}
        {showAlternatives && <Datum label="可用替代" value={feedback.alternatives.join("；")} />}
        {showBudget && <Datum label="剩余修复预算" value={feedback.remaining_budget!} />}
      </dl>
      {feedback.unknown_effects.length > 0 && (
        <ol className="mt-3 space-y-1.5" aria-label="未决效果">
          {feedback.unknown_effects.map((effect, index) => (
            <li
              key={effect.effect_id ?? `${effect.effect_kind ?? "effect"}:${index}`}
              className="border-l border-amber-400/30 pl-3 text-[12px] leading-5 text-zinc-300"
            >
              <span className="font-mono text-[11px] text-amber-200">
                {effect.effect_kind ?? "effect"} · {effect.status ?? "unknown"}
              </span>
              <span className="ml-2 text-zinc-400">{effect.summary}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[12px] leading-5 text-zinc-400">{feedback.next_step}</p>
      </details>
      {recoveryActions && recoveryActions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="确认后继续">
          <p className="w-full text-[12px] text-zinc-300">可以选择重新执行，提交时系统会再次检查条件。</p>
          {recoveryActions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled || action.busy}
              title={action.title}
              onClick={action.onClick}
              className="inline-flex items-center gap-1.5 rounded-full bg-acc-500/[.08] px-3 py-1.5 font-mono text-[11px] text-acc-300 ring-1 ring-acc-400/20 transition-colors hover:bg-acc-500/[.14] disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>
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
