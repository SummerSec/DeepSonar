import { FloppyDisk, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectSkillSourceBinding } from "../api";
import { useAuth } from "../auth";
import { canAccessAnyScope } from "../permissions";
import {
  describeSkillSourceReadiness,
  skillSourceRegisteredHint,
  skillSourceWritePermissionHint,
} from "../skill-source-readiness";
import { showToast } from "../toast";
import { HelpTip } from "../ui";
import { SkillSourceCatalogActions } from "./SkillSourceCatalogActions";

type ProjectOwner = { projectId: string; active: boolean; request: number };
type DraftOverride = { enabled: boolean; name: string };
type PanelState = {
  owner: ProjectOwner;
  sources: ProjectSkillSourceBinding[];
  configured: boolean;
  overrides: Record<string, DraftOverride>;
  busy: boolean;
  loading: boolean;
  adding: boolean;
  newSource: { name: string; repo_url: string; branch: string };
};

function initialState(owner: ProjectOwner): PanelState {
  return {
    owner, sources: [], configured: false, overrides: {}, busy: false, loading: true,
    adding: false, newSource: { name: "", repo_url: "", branch: "main" },
  };
}

const TONE_CLASS: Record<string, string> = {
  ready: "border-emerald-800/60 text-emerald-300",
  pending: "border-amber-800/60 text-amber-300",
  blocked: "border-red-900/60 text-red-300",
  off: "border-ink-700 text-zinc-400",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectSkillSourceAllowlistPanel({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved?: () => void;
}) {
  const { me } = useAuth();
  const canProjectWrite = canAccessAnyScope(me, ["skills:write"]);
  const canManagePlatform = canProjectWrite && !me?.actor?.project_id;
  const permissionHint = skillSourceWritePermissionHint(canProjectWrite, canManagePlatform);
  const ownerRef = useRef<ProjectOwner>({ projectId, active: true, request: 0 });
  // Render-time identity fence: A → B → A creates three distinct owners, before effects run.
  if (ownerRef.current.projectId !== projectId) {
    ownerRef.current.active = false;
    ownerRef.current = { projectId, active: true, request: 0 };
  }
  const owner = ownerRef.current;
  const [state, setState] = useState(() => initialState(owner));
  if (state.owner !== owner) setState(initialState(owner));
  const view = state.owner === owner ? state : initialState(owner);
  const { sources, configured, overrides, busy, loading, adding, newSource } = view;
  const isCurrent = () => owner.active && ownerRef.current === owner;
  const update = (change: (current: PanelState) => PanelState) => {
    if (!isCurrent()) return;
    setState((current) => isCurrent() && current.owner === owner ? change(current) : current);
  };
  const setNewSource = (value: PanelState["newSource"]) => update((current) => ({ ...current, newSource: value }));

  const reload = async () => {
    if (!isCurrent()) return;
    const request = ++owner.request;
    update((current) => ({ ...current, loading: true }));
    try {
      const res = await api.projectSkillSources(owner.projectId);
      if (!isCurrent() || request !== owner.request) return;
      // Metadata refreshes never acknowledge or discard unsaved project flag overrides.
      update((current) => ({ ...current, configured: res.configured, sources: res.sources }));
    } catch (error) {
      if (isCurrent() && request === owner.request) showToast(`加载 Skill 源可用性失败：${errorText(error)}`, "error");
    } finally {
      if (isCurrent() && request === owner.request) update((current) => ({ ...current, loading: false }));
    }
  };

  useEffect(() => {
    if (ownerRef.current !== owner) return;
    owner.active = true;
    void reload();
    return () => { owner.active = false; };
  }, [owner]);

  const dirty = Object.keys(overrides).length > 0;
  const missingOverrides = Object.entries(overrides).filter(([id]) => !sources.some((source) => source.skill_source_id === id));

  const save = async () => {
    if (!isCurrent() || !canProjectWrite || busy || loading || !dirty) return;
    update((current) => ({ ...current, busy: true }));
    let confirmed = 0;
    try {
      for (const [id, override] of Object.entries(overrides)) {
        if (!isCurrent()) return;
        if (!sources.some((source) => source.skill_source_id === id)) throw new Error(`源「${override.name}」已不存在，请取消该项未保存更改`);
        const result = await api.setProjectSkillSourceEnabled(owner.projectId, id, override.enabled);
        if (!isCurrent()) return;
        if (result.skill_source_id !== id || result.project_enabled !== override.enabled) {
          throw new Error(`服务器未确认「${override.name}」的启停值`);
        }
        confirmed += 1;
        update((current) => {
          const next = { ...current.overrides };
          delete next[id];
          return { ...current, overrides: next, sources: current.sources.map((source) => source.skill_source_id === id ? result : source) };
        });
      }
      if (isCurrent()) showToast("Skill 源启用白名单已保存（仅影响之后创建的 Job）", "ok");
    } catch (error) {
      if (isCurrent()) showToast(`保存未完成（已确认 ${confirmed} 项，其余更改仍未保存）：${errorText(error)}`, "error");
    } finally {
      if (isCurrent()) {
        await reload();
        if (isCurrent()) {
          update((current) => ({ ...current, busy: false }));
          if (confirmed > 0) onSaved?.();
        }
      }
    }
  };

  /** 项目上下文就地登记：复用平台同一套 URL 校验、默认隔离与审计。 */
  const addSource = async () => {
    if (!isCurrent() || !canManagePlatform || adding || busy) return;
    const name = newSource.name.trim();
    const repoUrl = newSource.repo_url.trim();
    if (!name || !repoUrl) {
      showToast("名称与仓库地址必填", "error");
      return;
    }
    update((current) => ({ ...current, adding: true }));
    try {
      const result = await api.createSkillSource({ name, repo_url: repoUrl, branch: newSource.branch.trim() || "main" });
      if (!isCurrent()) return;
      setNewSource({ name: "", repo_url: "", branch: "main" });
      showToast(result.existing
        ? `已复用「${result.name}」（${result.trust_status ?? "信任状态未知"}，平台${result.enabled === true ? "已启用" : result.enabled === false ? "未启用" : "启用状态未知"}）；未改变原有信任或任何项目启停设置。`
        : skillSourceRegisteredHint(result), "ok");
    } catch (error) {
      if (!isCurrent()) return;
      showToast(`登记失败：${errorText(error)}（仅支持 https Git 地址，host 需在平台允许列表内；名称冲突不代表仓库相同）`, "error");
    } finally {
      if (isCurrent()) {
        await reload();
        if (isCurrent()) update((current) => ({ ...current, adding: false }));
      }
    }
  };

  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>Skill 源启用白名单</span>
          <HelpTip>
            平台只划定项目可启用的 Skill/模块源；Hub 运行时从已启用集合选型（#603）。
            RoleConfig modules_json 仅为过渡缺省建议，候选必须 ⊆ 本白名单。平台控制能力始终由 Scheduler 强制注入，不受本白名单影响。Job 冻结 selector/digest；创建后 sync 不影响当次执行。首次打开会把历史 RoleConfig 已引用的源自动种子为启用，避免静默丢失。
            「模块源」里的官方源只是预置项，不限制你登记其它合规仓库；登记、同步、信任沿用平台同一套准入，登记本身不改变其它项目的授权。
          </HelpTip>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        {permissionHint && (
          <div className="rounded-md border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[12px] text-amber-200/90">
            {permissionHint}
          </div>
        )}
        {loading && <div role="status" className="text-[12px] text-zinc-500">刷新中…</div>}
        {sources.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
            平台还没有任何 Skill 源。有平台级 skills:write 权限的账号可在下方登记合规仓库，再同步候选并批准启用。
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const readiness = describeSkillSourceReadiness({
                source,
                projectEnabled: overrides[source.skill_source_id]?.enabled ?? source.project_enabled,
              });
              const on = overrides[source.skill_source_id]?.enabled ?? source.project_enabled;
              const pending = overrides[source.skill_source_id];
              return (
                <div
                  key={source.skill_source_id}
                  className={`rounded-md border px-3 py-2 ${
                    on ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"
                  }`}
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-emerald-500"
                      checked={on}
                      aria-label={`${source.name} 本项目启用`}
                      disabled={!canProjectWrite || busy || loading}
                      onChange={() => update((current) => {
                        const next = { ...current.overrides };
                        if (!on === source.project_enabled) delete next[source.skill_source_id];
                        else next[source.skill_source_id] = { enabled: !on, name: source.name };
                        return { ...current, overrides: next };
                      })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-100">
                        <span className="font-medium">{source.name}</span>
                        <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${TONE_CLASS[readiness.tone]}`}>
                          {readiness.label}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-500">{source.trust_status}</span>
                        {pending && <span className="text-[11px] text-amber-300">{pending.enabled ? "启用待保存" : "停用待保存"}</span>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                        {source.repo_url}@{source.branch} · {source.module_count} 模块 ·{" "}
                        {source.synced_at ? `同步于 ${new Date(source.synced_at).toLocaleString()}` : "同步时间未知"}
                      </div>
                      {readiness.blockers.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-amber-300/80">
                          {readiness.blockers.map((blocker) => (
                            <li key={blocker}>· {blocker}</li>
                          ))}
                        </ul>
                      )}
                      {readiness.nextStep && (
                        <div className="mt-1 font-mono text-[11px] text-zinc-400">下一步：{readiness.nextStep}</div>
                      )}
                    </div>
                  </label>
                  <div className="mt-1.5 pl-6">
                    <SkillSourceCatalogActions
                      key={`${projectId}:${source.skill_source_id}`}
                      scopeKey={projectId}
                      source={{
                        id: source.skill_source_id,
                        name: source.name,
                        trust_status: source.trust_status,
                        enabled: source.source_enabled,
                        source_instance_id: source.source_instance_id,
                        revocation_epoch: source.revocation_epoch,
                        candidate_hash: source.candidate_hash,
                        candidate_json: source.candidate_json,
                      }}
                      disabled={!canManagePlatform || busy || adding || loading}
                      onChanged={reload}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <div className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            <span>添加 Skill 源</span>
            <HelpTip>
              新源默认隔离且未启用；同步候选后，平台批准并启用会使所有未显式停用该源的项目未来新 Job 可见。复用已有源不会改变原有信任或项目启停设置。官方源是预置选项，不是唯一选择。
            </HelpTip>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={newSource.name}
              disabled={!canManagePlatform || adding || busy}
              onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
              className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 text-[13px] text-zinc-100 disabled:opacity-50"
              placeholder="名称（如 team-agent-skills）"
            />
            <input
              value={newSource.repo_url}
              disabled={!canManagePlatform || adding || busy}
              onChange={(e) => setNewSource({ ...newSource, repo_url: e.target.value })}
              className="min-w-0 flex-[2] rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 font-mono text-[12px] text-zinc-100 disabled:opacity-50"
              placeholder="https://github.com/example/team-agent-skills"
            />
            <input
              value={newSource.branch}
              disabled={!canManagePlatform || adding || busy}
              onChange={(e) => setNewSource({ ...newSource, branch: e.target.value })}
              className="w-28 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 font-mono text-[12px] text-zinc-100 disabled:opacity-50"
              placeholder="分支 main"
            />
            <button
              type="button"
              disabled={!canManagePlatform || adding || busy}
              onClick={() => void addSource()}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-acc-500 px-3 py-1 text-[13px] font-medium text-ink-950 disabled:opacity-50"
            >
              <Plus size={13} weight="bold" />
              {adding ? "登记中…" : "登记"}
            </button>
          </div>
          <div className="text-[11px] text-zinc-500">
            仅支持 https Git 地址（不允许内嵌凭据，host 需在平台允许列表内）。登记成功不等于已可运行，也不自动信任。
          </div>
        </div>

        {missingOverrides.map(([id, override]) => (
          <div key={id} role="alert" className="text-[12px] text-amber-300">
            源「{override.name}」已不存在；该项未保存更改不会转移到其它源。
            <button type="button" disabled={busy} onClick={() => update((current) => {
              const next = { ...current.overrides };
              delete next[id];
              return { ...current, overrides: next };
            })}>取消该项更改</button>
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-zinc-500">
            {configured ? "已配置（fail-closed）" : "首次读取将种子化历史引用"}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !dirty} onClick={() => update((current) => ({ ...current, overrides: {} }))}
              className="text-[12px] text-zinc-400 disabled:opacity-50">取消未保存更改</button>
            <button
              type="button"
              disabled={busy || loading || adding || !dirty || !canProjectWrite || missingOverrides.length > 0}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 disabled:opacity-50"
            >
              <FloppyDisk size={13} />
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}