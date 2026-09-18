import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type ProjectSkillSourceBinding } from "../api";
import { HelpTip } from "../ui";
import { showToast } from "../toast";

export function ProjectSkillSourceAllowlistPanel({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved?: () => void;
}) {
  const [sources, setSources] = useState<ProjectSkillSourceBinding[]>([]);
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

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
      showToast(`加载 Skill 源白名单失败：${error instanceof Error ? error.message : error}`, "error");
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
      showToast("Skill 源启用白名单已保存（下一 Job 生效）", "ok");
      await reload();
      onSaved?.();
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>Skill 源启用白名单</span>
          <HelpTip>
            平台只划定项目可启用的 Skill/模块源；Hub 运行时从已启用集合选型（#603）。
            RoleConfig modules_json 仅为过渡绑定，候选必须 ⊆ 本白名单。首次打开会把历史 RoleConfig 已引用的源自动种子为启用，避免静默丢失。
          </HelpTip>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        {loading ? (
          <div className="text-[12px] text-zinc-500">加载中…</div>
        ) : sources.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
            尚无 Skill 源。请先在「模块源」登记并信任同步，再回到此处启用。
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => {
              const on = draft[source.skill_source_id] === true;
              return (
                <label
                  key={source.skill_source_id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
                    on ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"
                  }`}
                >
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
                      <span className="font-mono text-[10px] text-zinc-500">{source.trust_status}</span>
                      {!source.source_enabled && (
                        <span className="font-mono text-[10px] text-amber-400/90">平台未启用</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                      {source.repo_url}@{source.branch} · {source.module_count} 模块
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-zinc-500">
            {configured ? "已配置（fail-closed）" : "首次读取将种子化历史引用"}
          </div>
          <button
            type="button"
            disabled={busy || !dirty}
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
