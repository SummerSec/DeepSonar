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
      <div className="provider-flow-catalog-health" aria-label="上游模型目录探测（诊断）">
        <div className="provider-flow-card-kicker">上游目录探测（诊断，非选模依据）</div>
        <div className="provider-flow-catalog-health-summary">
          <span>{credentialCatalogHealthSummary(credential)}</span>
          {credential.health?.model_catalog_fetched_at && (
            <span>拉取于 {new Date(credential.health.model_catalog_fetched_at).toLocaleString()}</span>
          )}
        </div>
        {descriptors.length === 0 ? (
          <div className="provider-flow-empty">
            暂无上游探测描述符（不影响使用账号已填写的模型 id 选模）。
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
          <div className="text-[10px] text-zinc-500">仅展示前 40 个探测项（诊断）；选模请用账号已填写的模型 id。</div>
        )}
      </div>

    </>
  );
}
