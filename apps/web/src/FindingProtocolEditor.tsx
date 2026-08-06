import type { EffectiveFindingProtocol, FindingProtocolConfig } from "./api";

const inputCls =
  "theme-input-surface w-full border px-3 py-2 text-[12px] text-zinc-200 outline-none transition-colors placeholder:text-zinc-600";

function csv(value: string[] | undefined): string {
  return (value ?? []).join(", ");
}

function list(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function optionalList(value: string): string[] | undefined {
  const values = list(value);
  return values.length ? values : undefined;
}

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
  const set = (patch: Partial<FindingProtocolConfig>) => onChange({ ...current, ...patch });
  const inherited = allowInherit && value === null;

  return (
    <section className="border-t border-white/[.06] pt-4" aria-label="Finding 协议">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase text-zinc-500">Finding 协议</div>
          <div className="mt-1 text-[12px] text-zinc-300">{effective.display_name}</div>
          <div className="mt-1 font-mono text-[9px] text-zinc-600">
            {effective.source} · {effective.mode} · {effective.scoring.default_standard} {effective.scoring.default_version}
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
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label>
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">显示名称</span>
            <input value={current.display_name ?? ""} onChange={(event) => set({ display_name: event.target.value || undefined })} className={inputCls} placeholder={effective.display_name} />
          </label>
          <label>
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">默认 profile</span>
            <input value={current.default_profile ?? ""} onChange={(event) => set({ default_profile: event.target.value || undefined })} className={inputCls} placeholder={effective.default_profile} />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 font-mono text-[9px] text-zinc-500">模式</legend>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-black/20 p-1 ring-1 ring-white/[.06]">
              {(["fixed", "hybrid", "agent_choice"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => set({ mode })}
                  className={`min-w-0 rounded px-2 py-1.5 font-mono text-[10px] ${
                    (current.mode ?? effective.mode) === mode ? "bg-white/[.08] text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="sm:col-span-2">
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">允许 profiles（逗号分隔，高层整表覆盖）</span>
            <input value={csv(current.allowed_profiles)} onChange={(event) => set({ allowed_profiles: optionalList(event.target.value) })} className={inputCls} placeholder={csv(effective.allowed_profiles)} />
          </label>
          <label>
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">默认 CVSS 版本</span>
            <input value={current.scoring?.default_version ?? ""} onChange={(event) => set({ scoring: { ...current.scoring, default_version: event.target.value || undefined } })} className={inputCls} placeholder={effective.scoring.default_version} />
          </label>
          <label>
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">接受版本</span>
            <input value={csv(current.scoring?.accepted_versions)} onChange={(event) => set({ scoring: { ...current.scoring, accepted_versions: optionalList(event.target.value) } })} className={inputCls} placeholder={csv(effective.scoring.accepted_versions)} />
          </label>
          <label className="sm:col-span-2">
            <span className="mb-1 block font-mono text-[9px] text-zinc-500">强制评分 profiles</span>
            <input value={csv(current.scoring?.require_scoring_for_profiles)} onChange={(event) => set({ scoring: { ...current.scoring, require_scoring_for_profiles: list(event.target.value) } })} className={inputCls} placeholder="留空表示不强制" />
          </label>
        </div>
      )}
    </section>
  );
}
