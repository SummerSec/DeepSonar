import type { ProviderCredential } from "./api";
import {
  credentialCatalogHealthSummary,
  modelCatalogHealthBadgeClass,
  modelCatalogHealthLabel,
  modelDescriptorsForCredential,
} from "./model-catalog-health";

/** Credential account-flow catalog health section (#614 Web). */
export function ModelCatalogHealthPanel({ credential }: { credential: ProviderCredential }) {
  const descriptors = modelDescriptorsForCredential(credential);
  return (
    <>
      <div className="provider-flow-catalog-health" aria-label="模型目录健康">
        <div className="provider-flow-card-kicker">模型目录健康</div>
        <div className="provider-flow-catalog-health-summary">
          <span>{credentialCatalogHealthSummary(credential)}</span>
          {credential.health?.model_catalog_fetched_at && (
            <span>拉取于 {new Date(credential.health.model_catalog_fetched_at).toLocaleString()}</span>
          )}
        </div>
        {descriptors.length === 0 ? (
          <div className="provider-flow-empty">
            暂无模型描述符。
          </div>
        ) : (
          <ul className="provider-flow-catalog-model-list">
            {descriptors.slice(0, 40).map((model) => (
              <li key={model.model_id} className="provider-flow-catalog-model-row">
                <span className={modelCatalogHealthBadgeClass(model.health_status)}>
                  {modelCatalogHealthLabel(model.health_status)}
                </span>
                <span className="provider-flow-catalog-model-id">
                  <strong>{model.display_name || model.model_id}</strong>
                  <small>
                    {model.model_id}
                    {model.catalog_revision ? ` · rev ${String(model.catalog_revision).slice(0, 16)}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        {descriptors.length > 40 && (
          <div className="text-[10px] text-zinc-500">仅展示前 40 个；完整目录见刷新结果 / API。</div>
        )}
      </div>

    </>
  );
}
