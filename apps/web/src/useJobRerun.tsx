import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useConfirmDialog } from "./components/ConfirmDialog";
import { ApiRequestError } from "./login-error";

export type CredentialRepairProjection = {
  kind: "stale_references" | "multiple_accounts";
  projectSettingsHref: string | null;
  credentialsHref: string;
};

type Feedback = { message: string; repair: CredentialRepairProjection | null };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

/** resolution_error contains human text, not a stable machine-code prefix. */
export function classifyJobRerunError(error: unknown, projectId: string | null): Feedback {
  const fallback = { message: error instanceof Error ? error.message : String(error), repair: null };
  if (!(error instanceof ApiRequestError) || error.status !== 409) return fallback;
  const budgetBody = record(error.taskContractFeedback);
  if (error.errorCode === "GATEWAY_REQUEST_BUDGET_INVALID" && Array.isArray(budgetBody?.missing_fields)) {
    const missing = budgetBody.missing_fields.filter((field): field is string => typeof field === "string");
    if (missing.length) return {
      message: `冻结快照预算字段缺失或非法（${missing.join(", ")}）。请先核对 Job 的历史策略和执行效果；当前配置不能证明旧预算，也不会自动补冻或重置额度。`,
      repair: null,
    };
  }
  if (error.errorCode !== "SNAPSHOT_STALE") return fallback;
  const body = record(error.taskContractFeedback);
  const unresolved = (typeof body?.resolution_error === "string" && body.resolution_error.trim().length > 0)
    || (Array.isArray(body?.stale_fields) && body.stale_fields.includes("current_snapshot_unresolvable"));
  if (unresolved) {
    const code = record(body?.repair)?.code;
    if (code === "provider_credential_allowlist_stale" || code === "provider_credential_multi_match") {
      return {
        message: code === "provider_credential_allowlist_stale"
          ? "当前项目账号引用失效，无法解析运行配置。请修复启用账号或默认账号，保存后再明确发起重跑。"
          : "当前项目有多个匹配账号，无法唯一选择。请明确设置默认账号或收窄启用范围，保存后再明确发起重跑。",
        repair: {
          kind: code === "provider_credential_allowlist_stale" ? "stale_references" : "multiple_accounts",
          projectSettingsHref: projectId ? `/projects/${encodeURIComponent(projectId)}/settings?tab=roles` : null,
          credentialsHref: "/settings/credentials",
        },
      };
    }
    return { message: "当前运行配置无法解析；请核查配置后再重跑。" + (fallback.message ? ` ${fallback.message}` : ""), repair: null };
  }
  if (body?.next_action === "rerun-current") {
    return { message: "旧冻结快照与当前运行身份不一致。可明确选择按当前配置重跑；这不表示当前项目账号配置失效。", repair: null };
  }
  return fallback;
}

export function CredentialRepairNotice({ message, repair }: { message: string | null; repair: CredentialRepairProjection | null }) {
  if (!message) return null;
  return <div role="status" className="space-y-1 text-[12px] text-amber-300">
    <p>{message}</p>
    {repair && <div className="flex flex-wrap gap-3">
      {repair.projectSettingsHref && <a href={repair.projectSettingsHref} className="underline">修复项目账号设置</a>}
      <a href={repair.credentialsHref} className="underline">配置 Provider 凭据</a>
    </div>}
  </div>;
}

type RerunInput = {
  jobId: string;
  projectId: string | null;
  mode: "resume" | "current";
  onSuccess?: (isCurrent: () => boolean) => void | Promise<void>;
};

export function useJobRerun(scopeKey: string) {
  const confirm = useConfirmDialog();
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const mounted = useRef(false);
  const pending = useRef<{ scope: typeof scope.current } | null>(null);
  const [state, setState] = useState<{ scope: typeof scope.current; busy: RerunInput["mode"] | null; message: string | null; repair: CredentialRepairProjection | null } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);

  const run = async ({ jobId, projectId, mode, onSuccess }: RerunInput) => {
    const owner = scope.current;
    if (!mounted.current || pending.current?.scope === owner) return;
    const request = { scope: owner };
    pending.current = request;
    const isCurrent = () => mounted.current && scope.current === owner && pending.current === request;
    const update = (feedback: { busy?: RerunInput["mode"] | null; message?: string | null; repair?: CredentialRepairProjection | null }) => {
      if (isCurrent()) setState((current) => ({ scope: owner, busy: null, message: null, repair: null,
        ...(current?.scope === owner ? current : {}), ...feedback }));
    };
    // An explicit new action clears prior feedback, including when its confirmation is cancelled.
    update({ busy: mode, message: null, repair: null });
    let queued = false;
    try {
      const confirmed = await confirm({
        title: mode === "current" ? "按当前配置重新执行？" : "使用旧冻结快照重新执行？",
        description: mode === "current"
          ? "保留同一 Job、画布与历史 Attempt/effect，按当前配置重新冻结快照并执行。"
          : "保留同一 Job、画布与历史 Attempt/effect，使用旧冻结快照执行；运行身份漂移时会拒绝。",
        confirmLabel: mode === "current" ? "当前配置重跑" : "旧快照重跑",
      });
      if (!confirmed || !isCurrent()) return;
      if (mode === "current") await api.rerunJobCurrent(jobId);
      else await api.resumeJob(jobId);
      if (!isCurrent()) return;
      queued = true;
      update({ message: mode === "current" ? "已按当前配置重新入队" : "已使用旧冻结快照重新入队" });
      if (onSuccess) await onSuccess(isCurrent);
    } catch (error) {
      update(queued
        ? { message: `已重新入队，但刷新失败：${error instanceof Error ? error.message : String(error)}`, repair: null }
        : classifyJobRerunError(error, projectId));
    } finally {
      if (isCurrent()) { update({ busy: null }); pending.current = null; }
    }
  };
  const visible = state?.scope === scope.current ? state : null;
  return { run, busy: visible?.busy ?? null, message: visible?.message ?? null, repair: visible?.repair ?? null };
}
