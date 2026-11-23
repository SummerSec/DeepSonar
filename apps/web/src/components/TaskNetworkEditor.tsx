const OPTIONS = [
  { value: "project" as const, label: "继承项目设置" },
  { value: "allow" as const, label: "允许出网" },
  { value: "deny" as const, label: "禁止出网" },
];

export function TaskNetworkEditor({ value, onChange }: { value: "project" | "allow" | "deny"; onChange: (value: "project" | "allow" | "deny") => void }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1.5 block px-0 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">外部网络</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="外部网络">
        {OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`rounded-lg border px-3.5 py-2.5 text-left text-[13px] leading-6 transition-colors ${
              value === option.value
                ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100"
                : "theme-input-surface text-zinc-400 hover:border-white/[.12] hover:text-zinc-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
