import {
  formatFrozenProviderModelHealth,
  modelCatalogHealthBadgeClass,
  modelCatalogHealthLabel,
  readFrozenProviderModel,
} from "./model-catalog-health";

function ConfigField({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="theme-surface rounded-xl px-3 py-2 ring-1" title={title}>
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-1 break-all text-[12px] text-zinc-200">{value || "—"}</div>
    </div>
  );
}

/** Job 运行配置：冻结 provider_model 健康 / 透传 (#614). */
export function FrozenProviderModelHealthSection({
  snapshot,
}: {
  snapshot: Record<string, unknown> | null | undefined;
}) {
  const health = formatFrozenProviderModelHealth(readFrozenProviderModel(snapshot));
  return (
    <>
      <ConfigField
        label="目录健康 (provider_model)"
        value={health.healthLabel}
        title={health.warning ?? undefined}
      />
      <ConfigField
        label="应急透传"
        value={health.passthrough ? "已启用（非默认）" : "关闭"}
        title={health.passthrough ? "Gateway 不强制冻结目录内模型" : "fail-closed：仅允许目录内模型"}
      />
      {health.revision && <ConfigField label="catalog_revision" value={health.revision} />}
      {health.warning && (
        <div className="provider-flow-passthrough-callout mt-2 sm:col-span-2" role="status">
          {health.passthrough ? (
            <span className={modelCatalogHealthBadgeClass("passthrough_allowed")}>
              {modelCatalogHealthLabel("passthrough_allowed")}
            </span>
          ) : health.healthStatus ? (
            <span className={modelCatalogHealthBadgeClass(health.healthStatus)}>
              {modelCatalogHealthLabel(health.healthStatus)}
            </span>
          ) : null}
          <span>{health.warning}</span>
        </div>
      )}
    </>
  );
}
