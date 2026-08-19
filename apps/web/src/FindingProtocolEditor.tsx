import type { EffectiveFindingProtocol, FindingProtocolConfig } from "./api";
import { HelpTip } from "./ui";

const MODE_META: Record<
  EffectiveFindingProtocol["mode"],
  { label: string; help: string }
> = {
  fixed: {
    label: "固定",
    help: "所有 Finding 必须使用默认 profile；Agent 不能自选其它 profile。",
  },
  hybrid: {
    label: "混合",
    help: "默认使用默认 profile；Agent 可在允许列表内改选其它 profile（推荐）。",
  },
  agent_choice: {
    label: "Agent 自选",
    help: "Agent 在允许列表内自由选择 profile；未指定时回落默认 profile。",
  },
};

export function FindingProtocolEditor({
  value,
  effective,
  onChange,
  allowInherit = false,
}: {
  value: FindingProtocolConfig | null;
  effective: EffectiveFindingProtocol;
  onChange: (value: FindingProtocolConfig | null) => void;
  allowInherit?: boolean;
}) {
  const current: FindingProtocolConfig = value ?? {};
  const inherited = allowInherit && value === null;
  const mode = current.mode ?? effective.mode;

  return (
    <section className="border-t border-white/[.06] pt-4" aria-label="Finding 协议">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center font-mono text-[10px] uppercase text-zinc-500">
            Finding 协议
            <HelpTip label="Finding 协议说明">
              控制 Finding 的 profile 选择方式与默认 CVSS 版本。平台默认 CVSS 3.1；高级 profiles / 强制评分等由系统默认维护，界面不再展开。
            </HelpTip>
          </div>
          <div className="mt-1 text-[12px] text-zinc-300">{effective.display_name}</div>
          <div className="mt-1 font-mono text-[9px] text-zinc-600">
            {effective.source} · {MODE_META[effective.mode]?.label ?? effective.mode}
            {" · "}
            {effective.scoring.default_standard} {effective.scoring.default_version}
          </div>
        </div>
        {allowInherit && (
          <label className="flex items-center gap-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={inherited}
              onChange={(event) => onChange(event.target.checked ? null : {})}
              className="accent-emerald-500"
            />
            继承上级
          </label>
        )}
      </div>

      {!inherited && (
        <div className="mt-3">
          <div className="mb-1.5 inline-flex items-center font-mono text-[9px] text-zinc-500">
            模式
            <HelpTip label="Finding 协议模式">
              <strong>固定</strong>：只用默认 profile。
              {" "}
              <strong>混合</strong>：默认 profile，Agent 可在允许列表内改选（推荐）。
              {" "}
              <strong>Agent 自选</strong>：Agent 在允许列表内自由选择。
            </HelpTip>
          </div>
          <div className="theme-surface grid grid-cols-3 gap-1 rounded-md p-1 ring-1">
            {(["hybrid", "fixed", "agent_choice"] as const).map((next) => {
              const meta = MODE_META[next];
              const active = mode === next;
              return (
                <button
                  key={next}
                  type="button"
                  title={meta.help}
                  onClick={() => onChange({ ...current, mode: next })}
                  className={`inline-flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1.5 font-mono text-[10px] ${
                    active ? "bg-white/[.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <span className="truncate">{meta.label}</span>
                  <HelpTip label={`${meta.label} 模式说明`}>{meta.help}</HelpTip>
                </button>
              );
            })}
          </div>
          <p className="mt-2 font-mono text-[9px] text-zinc-600">
            默认 CVSS {effective.scoring.default_version}
            {" · 接受 "}
            {effective.scoring.accepted_versions.join(" / ")}
            {" · profile "}
            {effective.default_profile}
          </p>
        </div>
      )}
    </section>
  );
}
