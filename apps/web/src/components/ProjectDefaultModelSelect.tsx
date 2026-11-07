import { SearchableSelect } from "../SearchableSelect";

export function ProjectDefaultModelSelect({ value, models, hasDefaultCredential, loaded, busy, unavailable, onChange }: {
  value: string | null;
  models: string[];
  hasDefaultCredential: boolean;
  loaded: boolean;
  busy: boolean;
  unavailable: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <fieldset disabled={busy || !loaded} className="space-y-2 disabled:opacity-60">
      <legend className="mb-2 text-[12px] text-zinc-400">项目默认模型</legend>
      <p className="text-[12px] text-zinc-400">模型优先级：任务显式 modelRef → 项目默认模型 → 全局角色模型。CLI 启用范围不等于默认运行模型。</p>
      <p role="status" className="text-[12px] text-zinc-300">{value ? `当前选择的项目默认模型（保存后生效）：${value}` : "未设置项目默认模型：沿用全局角色模型，不自动选择账号中的模型。"}</p>
      <fieldset disabled={!hasDefaultCredential}>
        <SearchableSelect
          key={`${loaded}:${busy}:${hasDefaultCredential}`}
          value={value ?? ""}
          onChange={(model) => { if (loaded && !busy && hasDefaultCredential) onChange(model || null); }}
          options={models.map((model) => ({ value: model, label: model }))}
          placeholder={!loaded ? "账号尚未加载，保留原模型引用" : unavailable ? `${value}（当前默认模型不可用）` : !hasDefaultCredential ? "请先选择可用的项目默认账号" : "未设置，沿用全局角色模型"}
          ariaLabel="项目默认模型"
          emptyText="默认账号尚未配置可选模型，请前往凭据页配置"
        />
      </fieldset>
      {loaded && hasDefaultCredential && models.length === 0 && <p className="text-[12px] text-amber-400/90">默认账号的配置中没有模型；不会使用上游探测结果或自动选择模型。</p>}
      {unavailable && <div role="alert" className="text-[12px] text-amber-400/90">
        默认模型 {value} 不在默认账号当前配置的模型名单中；原引用已保留，请显式清除或更换。
        <button type="button" onClick={() => onChange(null)} className="ml-2 underline">清除失效默认模型</button>
      </div>}
    </fieldset>
  );
}
