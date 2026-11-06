import { ArrowsClockwise, FloppyDisk, Plus, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
  const canWrite = canAccessAnyScope(me, ["skills:write"]);
  const permissionHint = skillSourceWritePermissionHint(canWrite);
  const [sources, setSources] = useState<ProjectSkillSourceBinding[]>([]);
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newSource, setNewSource] = useState({ name: "", repo_url: "", branch: "main" });

  const reload = async () => {
    setLoading(true);
    try {
      const res = await api.projectSkillSources(projectId);
      setConfigured(res.configured);
      setSources(res.sources);
      const next: Record<string, boolean> = {};
      for (const source of res.sources) next[source.skill_source_id] = source.project_enabled;
      setDraft(next);
    } catch (error) {
      showToast(`加载 Skill 源可用性失败：${errorText(error)}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [projectId]);

  const dirty = sources.some((source) => draft[source.skill_source_id] !== source.project_enabled);

  const save = async () => {
    setBusy(true);
    try {
      for (const source of sources) {
        const enabled = draft[source.skill_source_id] === true;
        if (enabled === source.project_enabled) continue;
        await api.setProjectSkillSourceEnabled(projectId, source.skill_source_id, enabled);
      }
      showToast("Skill 源启用白名单已保存（仅影响之后创建的 Job）", "ok");
      await reload();
      onSaved?.();
    } catch (error) {
      showToast(`保存失败：${errorText(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  /** 项目上下文就地登记：复用平台同一套 URL 校验、默认隔离与审计。 */
  const addSource = async () => {
    const name = newSource.name.trim();
    const repoUrl = newSource.repo_url.trim();
    if (!name || !repoUrl) {
      showToast("名称与仓库地址必填", "error");
      return;
    }
    setAdding(true);
    try {
      await api.createSkillSource({ name, repo_url: repoUrl, branch: newSource.branch.trim() || "main" });
      setNewSource({ name: "", repo_url: "", branch: "main" });
      showToast(skillSourceRegisteredHint(name), "ok");
      await reload();
    } catch (error) {
      const status = (error as { status?: number }).status;
      showToast(
        status === 409
          ? `该名称已被占用：${errorText(error)}`
          : `登记失败：${errorText(error)}（仅支持 https Git 地址，host 需在平台允许列表内）`,
        "error",
      );
      await reload();
    } finally {
      setAdding(false);
    }
  };

  const syncSource = async (source: ProjectSkillSourceBinding) => {
    setRowBusy(source.skill_source_id);
    try {
      const result = await api.syncSkillSource(source.skill_source_id);
      showToast(
        result.changed
          ? `已同步「${source.name}」：${result.modules} 个模块（commit ${result.last_commit_sha?.slice(0, 10) ?? "?"}）`
          : `「${source.name}」目录未变化（${result.modules} 个模块）`,
        "ok",
      );
      await reload();
    } catch (error) {
      showToast(
        `同步失败：${errorText(error)}；请检查仓库地址/分支、Git host 白名单与网络可达性`,
        "error",
      );
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const trustSource = async (source: ProjectSkillSourceBinding) => {
    setRowBusy(source.skill_source_id);
    try {
      await api.trustSkillSource(source.skill_source_id, "trusted");
      showToast(`已批准「${source.name}」；它仍需要平台启用与本项目勾选才可用于下一 Job`, "ok");
      await reload();
    } catch (error) {
      showToast(`审批失败：${errorText(error)}`, "error");
    } finally {
      setRowBusy(null);
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
        {loading ? (
          <div className="text-[12px] text-zinc-500">加载中…</div>
        ) : sources.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
            平台还没有任何 Skill 源。在下方登记一个合规仓库（例如你自己的 skills 仓库），再按「同步 → 批准信任 → 平台启用 → 本项目启用」推进。
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const readiness = describeSkillSourceReadiness({
                source,
                projectEnabled: draft[source.skill_source_id] === true,
              });
              const on = draft[source.skill_source_id] === true;
              const rowWorking = rowBusy === source.skill_source_id;
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
                      onChange={() =>
                        setDraft((current) => ({
                          ...current,
                          [source.skill_source_id]: !on,
                        }))
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-100">
                        <span className="font-medium">{source.name}</span>
                        <span className={`rounded border px-1.5 py-px font-mono text-[10px] ${TONE_CLASS[readiness.tone]}`}>
                          {readiness.label}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-500">{source.trust_status}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                        {source.repo_url}@{source.branch} · {source.module_count} 模块 ·{" "}
                        {source.synced_at ? `同步于 ${new Date(source.synced_at).toLocaleString()}` : "未同步"}
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
                  {canWrite && (
                    <div className="mt-1.5 flex items-center gap-1.5 pl-6">
                      {source.trust_status !== "disabled" && (
                        <button
                          type="button"
                          disabled={rowWorking}
                          onClick={() => void syncSource(source)}
                          className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200 disabled:opacity-50"
                        >
                          <ArrowsClockwise size={11} className={rowWorking ? "animate-spin" : ""} />
                          {rowWorking ? "处理中…" : "同步"}
                        </button>
                      )}
                      {source.trust_status !== "trusted" && source.trust_status !== "disabled" && (
                        <button
                          type="button"
                          disabled={rowWorking}
                          onClick={() => void trustSource(source)}
                          className="flex items-center gap-1 rounded-md border border-emerald-900/60 px-2 py-0.5 font-mono text-[11px] text-emerald-300 transition-colors hover:bg-emerald-950/40 disabled:opacity-50"
                        >
                          <ShieldCheck size={11} />
                          批准信任
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
          <div className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            <span>添加 Skill 源</span>
            <HelpTip>
              在这里登记后仍需平台准入：新源默认隔离且未启用，要经过同步、批准信任、平台启用，再勾选本项目启用才会进入之后创建的 Job。官方源是预置选项，不是唯一选择。
            </HelpTip>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={newSource.name}
              disabled={!canWrite || adding}
              onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
              className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 text-[13px] text-zinc-100 disabled:opacity-50"
              placeholder="名称（如 team-agent-skills）"
            />
            <input
              value={newSource.repo_url}
              disabled={!canWrite || adding}
              onChange={(e) => setNewSource({ ...newSource, repo_url: e.target.value })}
              className="min-w-0 flex-[2] rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 font-mono text-[12px] text-zinc-100 disabled:opacity-50"
              placeholder="https://github.com/example/team-agent-skills"
            />
            <input
              value={newSource.branch}
              disabled={!canWrite || adding}
              onChange={(e) => setNewSource({ ...newSource, branch: e.target.value })}
              className="w-28 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 font-mono text-[12px] text-zinc-100 disabled:opacity-50"
              placeholder="分支 main"
            />
            <button
              type="button"
              disabled={!canWrite || adding}
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

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-zinc-500">
            {configured ? "已配置（fail-closed）" : "首次读取将种子化历史引用"}
          </div>
          <button
            type="button"
            disabled={busy || !dirty || !canWrite}
            onClick={() => void save()}
            className="inline-flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 disabled:opacity-50"
          >
            <FloppyDisk size={13} />
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </section>
  );
}