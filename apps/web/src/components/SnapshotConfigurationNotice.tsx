import type { TaskContractFeedback } from "../task-contract-editor";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

/** Only project-authorized model identifiers are projected, never raw error/cause text. */
function modelId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && !/[\s\u0000-\u001f\u007f]/u.test(value) && !value.includes("://") ? value : null;
}

export function snapshotConfigurationFeedback(value: unknown) {
  const body = record(value);
  if (body?.error_code !== "SNAPSHOT_STALE" || !Array.isArray(body.stale_fields)
    || !body.stale_fields.includes("current_snapshot_unresolvable")) return null;
  const repair = record(body.repair), expected = record(repair?.expected);
  const modelConflict = repair?.path === "model_ref" && (
    (repair.code === "provider_credential_no_match" && expected?.kind === "project_authorized_model")
    || ((repair.code === "model_not_in_catalog" || repair.code === "model_passthrough_disabled") && expected?.kind === "account_configured_model_id")
  );
  const requestedModel = modelConflict ? modelId(expected?.model_ref) : null;
  const candidates = modelConflict && Array.isArray(expected?.sample)
    ? [...new Set(expected.sample.map(modelId).filter((id): id is string => id !== null))].slice(0, 12) : [];
  return { modelConflict, requestedModel, candidates };
}

/** Durable feedback beside task submission; configuration navigation never retries a task. */
export function SnapshotConfigurationNotice({ feedback, projectId }: { feedback: TaskContractFeedback; projectId: string | null }) {
  const detail = snapshotConfigurationFeedback(feedback);
  if (!detail) return null;
  return <div role="alert" className="theme-input-surface mt-3 space-y-2 rounded-lg border p-3 text-sm leading-6 text-zinc-200">
    <p className="font-medium">任务未创建：当前运行配置无法解析</p>
    {detail.modelConflict ? <>
      <p>{detail.requestedModel ? <>请求的模型：<code>{detail.requestedModel}</code>。</> : "请求的模型不在当前项目授权账号的配置名单内。"}
        启用 Pi 等 CLI 只限定可用范围，不会自动替换全局角色的默认模型。</p>
      <p>当前候选{detail.candidates.length ? <>（可能不是完整列表）：{detail.candidates.map((id, index) => <span key={id}>{index > 0 && "、"}<code>{id}</code></span>)}</> : "未提供；请检查账号配置名单、启用范围与健康状态"}。</p>
      <p>请在项目设置中显式选择默认账号和模型，或修复全局角色模型；保存后再提交，不会自动重试或放宽准入。</p>
    </> : <p>请检查项目启用范围、默认账号与模型，以及全局角色和运行镜像配置；保存后再提交。</p>}
    <div className="flex flex-wrap gap-3">
      {projectId && <a className="underline" href={`/projects/${encodeURIComponent(projectId)}/settings?tab=roles`}>配置项目默认账号与模型</a>}
      <a className="underline" href="/settings/credentials">配置 Provider 账号</a>
      <a className="underline" href="/agents?tab=roles">检查全局角色模型</a>
    </div>
  </div>;
}
