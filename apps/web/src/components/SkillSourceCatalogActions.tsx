import { useEffect, useRef, useState } from "react";
import { api, type SkillSource, type SkillTrustStatus } from "../api";
import { useAuth } from "../auth";
import { canAccessAnyScope } from "../permissions";
import { formatSkillSourceSyncFlash } from "../skill-source-sync-flash";
import { useConfirmDialog } from "./ConfirmDialog";

const actionClass = "rounded-md border border-ink-700 px-2 py-1 font-mono text-zinc-300 transition-colors hover:border-ink-600 disabled:cursor-not-allowed disabled:opacity-50";

type CatalogSource = Pick<SkillSource, "id" | "name" | "trust_status" | "enabled" | "source_instance_id" | "revocation_epoch" | "candidate_hash" | "candidate_json">;

export interface SkillSourceCatalogActionsProps {
  source: CatalogSource;
  disabled?: boolean;
  onChanged: () => Promise<void> | void;
  scopeKey?: string;
}

export function SkillSourceCatalogActions({ source, disabled = false, onChanged, scopeKey }: SkillSourceCatalogActionsProps) {
  const { me } = useAuth();
  const confirm = useConfirmDialog();
  const canManage = canAccessAnyScope(me, ["skills:write"]) && !me?.actor?.project_id;
  // A new object is a generation, not just a value: A → B → A must fence A's late work.
  const key = JSON.stringify([scopeKey, source.id, source.name, source.trust_status, source.enabled,
    source.source_instance_id, source.revocation_epoch, source.candidate_hash, source.candidate_json, canManage, disabled]);
  const fence = useRef({ key, mounted: true });
  if (fence.current.key !== key) fence.current = { key, mounted: true };
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const [busy, setBusy] = useState<object | null>(null);
  const inFlight = useRef<object | null>(null);
  const [notice, setNotice] = useState<{ token: object; text: string } | null>(null);
  useEffect(() => {
    fence.current.mounted = true;
    return () => { fence.current.mounted = false; };
  }, []);
  const token = fence.current;
  const current = () => token === fence.current && token.mounted;
  const nonceReady = Boolean(source.source_instance_id?.trim() && source.revocation_epoch?.trim() && source.trust_status && typeof source.enabled === "boolean");
  const candidate = source.candidate_json;
  const candidateReady = Boolean(source.candidate_hash?.trim() && candidate
    && candidate.schema === "deepsonar.skill-source-candidate/v1"
    && candidate.source_instance_id === source.source_instance_id
    && candidate.revocation_epoch === source.revocation_epoch);
  const blocked = disabled || busy === token || !nonceReady;

  async function run(action: "sync" | SkillTrustStatus) {
    if (!canManage || blocked || inFlight.current === token) return;
    if (action === "trusted" && (!candidateReady || source.trust_status === "disabled")) return;
    if (action === "sync" && source.trust_status === "disabled") return;
    // Capture every approval precondition before the confirmation await.
    const id = source.id;
    const options = {
      expected_epoch: source.revocation_epoch!, expected_instance_id: source.source_instance_id!,
      ...(action === "trusted" ? { candidate_hash: source.candidate_hash!, enabled: true } : { enabled: false }),
    };
    const refresh = () => changedRef.current();
    inFlight.current = token;
    setBusy(token);
    setNotice(null);
    try {
      const description = action === "trusted"
        ? `批准「${source.name}」候选 ${source.candidate_hash}（commit ${candidate?.commit_sha ?? "未知"}，${candidate?.module_count} 个模块）。这是平台全局操作：trusted + enabled 后，所有未显式停用此源的项目后续 Job 默认可用，无需各项目勾选。发布会更新当前目录并清理失效 RoleConfig 引用，不改已创建 Job 快照。`
        : `这是平台全局操作，不是单项目操作。${action === "quarantined" ? "移至隔离" : "禁用"}会沿撤销 epoch 阻止后续 pull；重新启用须先隔离、同步新候选再审批，不能恢复旧 live 授权。`;
      if (action !== "sync" && !await confirm({ title: action === "trusted" ? "批准并启用平台源" : "撤销平台源授权", description, confirmLabel: action === "trusted" ? "确认批准并启用" : "确认撤销", tone: action === "trusted" ? "default" : "danger" })) return;
      if (!current()) return;
      let result: string;
      try {
        if (action === "sync") result = formatSkillSourceSyncFlash(await api.syncSkillSource(id));
        else {
          await api.trustSkillSource(id, action, options);
          result = action === "trusted" ? "已批准并启用平台源" : action === "quarantined" ? "已移至隔离；请同步新候选后审批" : "已禁用平台源";
        }
      } catch (error) {
        if (!current()) return;
        setNotice({ token, text: `${action === "sync" ? "同步" : "操作"}失败：${error instanceof Error ? error.message : String(error)}` });
        try { if (current()) await refresh(); } catch { /* Keep the write error; metadata refresh is best effort. */ }
        return;
      }
      if (!current()) return;
      setNotice({ token, text: result });
      try { await refresh(); }
      catch (error) {
        if (current()) setNotice({ token, text: `${result}；刷新失败，请重新加载元数据：${error instanceof Error ? error.message : String(error)}` });
      }
    } finally {
      if (inFlight.current === token) inFlight.current = null;
      if (current()) setBusy(null);
    }
  }

  return <div className="flex flex-col gap-1 text-[12px]">
    <div className="break-all font-mono text-zinc-500">
      {source.candidate_hash === undefined ? "候选状态未知，请刷新元数据" : source.candidate_hash === null ? "无待批候选（不代表 live 已健康核验）" : `待批候选 ${source.candidate_hash}`}
      {candidate && <span>{` · commit ${candidate.commit_sha ?? "未知"} · ${candidate.module_count} 模块 · ${candidate.synced_at}`}</span>}
      <span>{` · instance ${source.source_instance_id ?? "未知"} · epoch ${source.revocation_epoch ?? "未知"}`}</span>
    </div>
    {canManage && source.trust_status === "disabled" && <p className="text-amber-300">先移至隔离，再同步新候选并审批；不能恢复旧 live 授权。</p>}
    {canManage && <div className="flex flex-wrap gap-1.5">
      <button type="button" className={actionClass} disabled={blocked || source.trust_status === "disabled"} onClick={() => void run("sync")}>同步候选</button>
      <button type="button" className={actionClass} disabled={blocked || !candidateReady || source.trust_status === "disabled"} onClick={() => void run("trusted")}>批准并启用</button>
      {source.trust_status !== "quarantined" && <button type="button" className={actionClass} disabled={blocked} onClick={() => void run("quarantined")}>移至隔离</button>}
      {source.trust_status !== "disabled" && <button type="button" className={actionClass} disabled={blocked} onClick={() => void run("disabled")}>禁用</button>}
    </div>}
    {notice?.token === token && <p role="status">{notice.text}</p>}
  </div>;
}
