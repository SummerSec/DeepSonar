import { Plus, Trash } from "@phosphor-icons/react";
import { SearchableSelect } from "./SearchableSelect";
import { CREDENTIAL_CONCURRENCY_MAX, parseCredentialConcurrency } from "./credential-config-settings";
import type { ModelConcurrencyDraftRow } from "./provider-account-concurrency";

export function ModelConcurrencyFields({
  rows,
  modelOptions,
  onChange,
}: {
  rows: ModelConcurrencyDraftRow[];
  modelOptions: string[];
  onChange: (next: ModelConcurrencyDraftRow[]) => void;
}) {
  const used = new Set(rows.map((row) => row.model).filter(Boolean));
  const setRow = (index: number, patch: Partial<ModelConcurrencyDraftRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="rounded-md border border-white/[.08] bg-white/[.02] px-3 py-3" aria-label="模型并发">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">模型并发（model_concurrency）</div>
      <p className="mb-2 text-[11px] leading-5 text-zinc-500">
        键必须选自该账号已配置模型；留空整表表示不按模型限额。校验与账号并发相同（0–{CREDENTIAL_CONCURRENCY_MAX} 整数）。
      </p>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const limitOk = (() => { try { return parseCredentialConcurrency(row.limit) != null; } catch { return false; } })();
          const options = modelOptions
            .filter((model) => model === row.model || !used.has(model))
            .map((model) => ({ value: model, label: model }));
          return (
            <div key={index} className="grid grid-cols-[1fr_7rem_auto] items-start gap-2">
              <SearchableSelect
                value={row.model}
                onChange={(next) => setRow(index, { model: next })}
                options={options}
                placeholder={modelOptions.length ? "选择模型…" : "账号尚未配置模型"}
                ariaLabel={`模型并发键 ${index + 1}`}
                clearable={false}
              />
              <input
                type="number"
                min={0}
                max={CREDENTIAL_CONCURRENCY_MAX}
                value={row.limit}
                onChange={(e) => setRow(index, { limit: e.target.value })}
                className="theme-input-surface cc-switch-input"
                placeholder="上限"
                aria-label={`模型 ${row.model || index + 1} 并发上限`}
                aria-invalid={!limitOk}
              />
              <button
                type="button"
                className="secondary-button !min-h-8 !px-2"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                aria-label="删除该模型并发"
              >
                <Trash size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="secondary-button mt-2 !min-h-7 !px-2 !text-[10px]"
        disabled={modelOptions.length === 0 || used.size >= modelOptions.length}
        onClick={() => {
          const nextModel = modelOptions.find((model) => !used.has(model)) ?? "";
          onChange([...rows, { model: nextModel, limit: "1" }]);
        }}
      >
        <Plus size={12} /> 添加模型并发
      </button>
    </div>
  );
}
