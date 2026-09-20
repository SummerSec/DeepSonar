import { Warning } from "@phosphor-icons/react";
import type { ProviderCredential } from "./api";
import {
  catalogHasPassthrough,
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
        <div className="provider-flow-card-kicker">模型目录健康（health_status）</div>
        <div className="provider-flow-catalog-health-summary">
          <span>{credentialCatalogHealthSummary(credential)}</span>
          {credential.health?.model_catalog_fetched_at && (
            <span>拉取于 {new Date(credential.health.model_catalog_fetched_at).toLocaleString()}</span>
          )}
        </div>
        {catalogHasPassthrough(credential) && (
          <div className="provider-flow-passthrough-callout">
            <Warning size={13} /> 目录中含「应急透传」模型：非已验证目录项，默认不应作为常规选型；仅 alias 网关应急时使用。
          </div>
        )}
        {descriptors.length === 0 ? (
          <div className="provider-flow-empty">
            暂无模型描述符。可点「刷新模型目录」探测；空目录时运行时软降级，非空目录则 fail-closed。
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
      <div className="provider-flow-warning">
        <Warning size={13} /> 模型目录和连接测试不代表当前 Key 有调用该模型的权限；以具体调用或任务返回的上游 403 为准。发现不等于授权。连接健康（上方绿/红点）与模型目录 health_status 是两套状态。
      </div>
    </>
  );
}
