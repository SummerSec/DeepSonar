/**
 * 导入/导出面板
 * - project：项目数据包
 * - platform：平台配置（全局规则、角色、Skill 源、全局 RoleConfig、凭据元数据）
 */
import { DownloadSimple, UploadSimple, ArrowsClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, type DataExportRow, type ImportPreview } from "./api";
import { HelpTip } from "./ui";
import { inferToastKind, showToast } from "./toast";

const PROJECT_PRESETS = [
  { id: "configuration" as const, label: "配置模板", hint: "规则 / 角色 / Skill / 环境（无任务历史）" },
  { id: "project_full" as const, label: "完整项目", hint: "含任务、Finding、事件；默认要求无活动 Job" },
  { id: "evidence_archive" as const, label: "证据归档", hint: "任务结果与审计归档" },
];

const PLATFORM_MODULES = [
  { id: "global_rules", label: "全局规则", hint: "调度并发、网络边界、关注策略、Finding 协议等" },
  { id: "agent_roles", label: "角色注册表", hint: "agent_roles：名称、标题、kind、内置标记" },
  { id: "global_role_configs", label: "全局 RoleConfig", hint: "全局缺省运行配置（指令 / 工具 / 模块）" },
  { id: "skill_sources", label: "模块源", hint: "Skill / 插件 Git 源登记与同步元数据" },
  { id: "credentials", label: "凭据元数据", hint: "仅名称 / provider / 指纹等，不含 Secret 明文" },
] as const;

type PlatformModuleId = (typeof PLATFORM_MODULES)[number]["id"];

type Scope = "project" | "platform";

export function TransferPanel({
  projectId,
  scope = "project",
}: {
  /** 项目导出必填；平台导出传 null */
  projectId: string | null;
  scope?: Scope;
}) {
  const isPlatform = scope === "platform" || !projectId;
  const [preset, setPreset] = useState<(typeof PROJECT_PRESETS)[number]["id"]>("configuration");
  const [platformModules, setPlatformModules] = useState<Set<PlatformModuleId>>(
    () => new Set(PLATFORM_MODULES.map((m) => m.id)),
  );
  const [exports, setExports] = useState<DataExportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [importName, setImportName] = useState("");

  const flash = (m: string) => {
    setMsg(m);
    showToast(m, inferToastKind(m));
    setTimeout(() => setMsg(null), 4000);
  };

  const reload = useCallback(() => {
    const p = isPlatform ? api.listPlatformExports() : api.listExports(projectId!);
    p.then(setExports).catch(() => setExports([]));
  }, [isPlatform, projectId]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [reload]);

  const togglePlatformModule = (id: PlatformModuleId) => {
    setPlatformModules((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllPlatformModules = () => {
    setPlatformModules(new Set(PLATFORM_MODULES.map((m) => m.id)));
  };

  const clearPlatformModules = () => {
    setPlatformModules(new Set());
  };

  const createExport = async () => {
    setBusy(true);
    try {
      if (isPlatform) {
        const modules = PLATFORM_MODULES.map((m) => m.id).filter((id) => platformModules.has(id));
        if (modules.length === 0) {
          flash("请至少选择一个导出模块");
          return;
        }
        const allSelected = modules.length === PLATFORM_MODULES.length;
        await api.createPlatformExport({
          preset: allSelected ? "platform_full" : "custom",
          modules,
          credentials: { mode: modules.includes("credentials") ? "metadata" : "excluded" },
        });
      } else {
        await api.createExport(projectId!, {
          preset,
          credentials: { mode: "metadata" },
          allow_active_jobs: preset !== "project_full",
        });
      }
      flash("导出已开始");
      reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async (id: string) => {
    try {
      const blob = await api.downloadExport(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = isPlatform
        ? `platform-${id.slice(0, 8)}.deepsonarpack`
        : `project-${projectId!.slice(0, 8)}.deepsonarpack`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  const onUpload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setPreview(null);
    setImportId(null);
    try {
      const row = await api.uploadImport(file);
      const p = await api.previewImport(row.id);
      const packIsPlatform = p.kind === "platform";

      // 入口与包类型必须一致：项目数据只在项目模块，平台配置只在平台数据页
      if (isPlatform && !packIsPlatform) {
        await api.deleteImport(row.id).catch(() => {});
        flash("这是项目数据包。请到对应项目 → 数据 页面导入。");
        return;
      }
      if (!isPlatform && packIsPlatform) {
        await api.deleteImport(row.id).catch(() => {});
        flash("这是平台配置包。请到平台数据与调度。");
        return;
      }

      setImportId(row.id);
      setPreview(p);
      if (packIsPlatform) {
        setImportName("");
      } else {
        setImportName(p.source?.project_name ? `${p.source.project_name}-imported` : "Imported Project");
      }
      flash("预览就绪");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyCreate = async () => {
    if (!importId) return;
    setBusy(true);
    try {
      const r = await api.applyImport(importId, {
        mode: "create_new",
        project_name: importName || undefined,
      });
      flash(`已创建项目 ${r.project_id?.slice(0, 8) ?? ""}…`);
      setPreview(null);
      setImportId(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyMergeProject = async () => {
    if (!importId || !projectId) return;
    setBusy(true);
    try {
      await api.applyImport(importId, {
        mode: "merge_configuration",
        target_project_id: projectId,
        conflict_policy: "use_source",
      });
      flash("配置已合并到当前项目");
      setPreview(null);
      setImportId(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyPlatform = async () => {
    if (!importId) return;
    setBusy(true);
    try {
      await api.applyImport(importId, {
        mode: "merge_platform",
        conflict_policy: "use_source",
      });
      flash("平台配置已合并到本实例");
      setPreview(null);
      setImportId(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isPlatformPreview = preview?.kind === "platform";

  return (
    <div className="flex flex-col gap-6">
      {msg && <div className="font-mono text-[12px] text-acc-400">{msg}</div>}

      <section>
        <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
          {isPlatform ? "导出平台配置" : "导出项目"}
          <HelpTip>
            {isPlatform ? (
              <>
                导出全局规则、角色注册表、全局 RoleConfig、Skill 源与凭据<strong>元数据</strong>
                。不含项目任务、API Token、主密钥与 Secret 明文。
              </>
            ) : (
              <>
                生成 <code>.deepsonarpack</code>。默认不含 Secret 明文、API Token 与 Job Token。
              </>
            )}
          </HelpTip>
        </div>

        {!isPlatform && (
          <div className="flex flex-col gap-2">
            {PROJECT_PRESETS.map((p) => (
              <label
                key={p.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 ring-1 transition-colors ${
                  preset === p.id ? "bg-white/[.04] ring-white/[.12]" : "ring-white/[.05] hover:bg-white/[.02]"
                }`}
              >
                <input
                  type="radio"
                  name="preset"
                  checked={preset === p.id}
                  onChange={() => setPreset(p.id)}
                  className="mt-1 accent-zinc-300"
                />
                <span>
                  <span className="block text-[13px] text-zinc-200">{p.label}</span>
                  <span className="block text-[11px] text-zinc-600">{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {isPlatform && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">导出模块</span>
              <button
                type="button"
                onClick={selectAllPlatformModules}
                className="font-mono text-[10px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
              >
                全选
              </button>
              <button
                type="button"
                onClick={clearPlatformModules}
                className="font-mono text-[10px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
              >
                清空
              </button>
              <span className="font-mono text-[10px] text-zinc-600">
                已选 {platformModules.size}/{PLATFORM_MODULES.length}
              </span>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {PLATFORM_MODULES.map((mod) => {
                const checked = platformModules.has(mod.id);
                return (
                  <label
                    key={mod.id}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5 ring-1 transition-colors ${
                      checked ? "bg-white/[.04] ring-white/[.12]" : "ring-white/[.05] hover:bg-white/[.02]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePlatformModule(mod.id)}
                      className="mt-1 accent-zinc-300"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] text-zinc-200">{mod.label}</span>
                      <span className="block font-mono text-[10px] text-zinc-600">{mod.id}</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-zinc-600">{mod.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          disabled={busy || (isPlatform && platformModules.size === 0)}
          onClick={createExport}
          className="mt-3 flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 hover:bg-acc-400 disabled:opacity-50"
        >
          <DownloadSimple size={14} /> {isPlatform ? "导出平台配置" : "开始导出"}
        </button>

        <div className="mt-4 space-y-2">
          {exports.length === 0 && <div className="text-[12px] text-zinc-600">暂无导出记录</div>}
          {exports.map((ex) => (
            <div
              key={ex.id}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.02] px-3 py-2 ring-1 ring-white/[.05]"
            >
              <span className="font-mono text-[11px] text-zinc-500">{ex.preset}</span>
              <span className="font-mono text-[11px] text-zinc-400">{ex.status}</span>
              {ex.error && <span className="text-[11px] text-red-300/80">{ex.error}</span>}
              {ex.status === "succeeded" && (
                <button
                  type="button"
                  onClick={() => download(ex.id)}
                  className="ml-auto text-[11px] text-zinc-300 underline-offset-2 hover:underline"
                >
                  下载
                </button>
              )}
              {(ex.status === "pending" || ex.status === "collecting" || ex.status === "packaging") && (
                <ArrowsClockwise size={12} className="animate-spin text-zinc-600" />
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-ink-800 pt-4">
        <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
          导入
          <HelpTip>
            {isPlatform
              ? "仅接受平台配置包（deepsonar-platform-export）。项目包请到项目 → 数据。"
              : "仅接受本项目数据包（deepsonar-project-export）。平台包请到平台数据与调度。"}
          </HelpTip>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-white/[.04] px-3 py-1.5 text-[13px] text-zinc-300 ring-1 ring-white/[.08] hover:bg-white/[.07]">
          <UploadSimple size={14} />
          选择 .deepsonarpack
          <input
            type="file"
            accept=".deepsonarpack,application/zip,application/octet-stream"
            className="hidden"
            disabled={busy}
            onChange={(e) => onUpload(e.target.files?.[0] ?? null)}
          />
        </label>

        {preview && (
          <div className="mt-4 space-y-3 rounded-xl bg-white/[.02] p-3 ring-1 ring-white/[.06]">
            <div className="text-[13px] text-zinc-200">
              {isPlatformPreview ? "平台配置包" : `来源：${preview.source?.project_name ?? "—"}`}{" "}
              <span className="font-mono text-[10px] text-zinc-600">
                {preview.source?.project_id?.slice(0, 12)}
              </span>
            </div>
            <div className="font-mono text-[11px] text-zinc-500">
              模块：{preview.selected_modules.join(", ")}
            </div>
            {Object.keys(preview.counts ?? {}).length > 0 && (
              <div className="font-mono text-[11px] text-zinc-600">
                计数：{JSON.stringify(preview.counts)}
              </div>
            )}
            {preview.warnings?.map((w) => (
              <div key={w} className="text-[11px] text-amber-200/70">
                · {w}
              </div>
            ))}
            {preview.conflicts?.map((c) => (
              <div key={`${c.module}-${c.key}`} className="text-[11px] text-zinc-500">
                冲突 [{c.module}] {c.message}
              </div>
            ))}
            {preview.credential_mappings_required?.length > 0 && (
              <div className="text-[11px] text-zinc-500">
                Credential 待映射：{preview.credential_mappings_required.map((c) => c.name).join(", ")}
              </div>
            )}

            {isPlatformPreview ? (
              <button
                type="button"
                disabled={busy}
                onClick={applyPlatform}
                className="rounded-md bg-acc-500 px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-50"
              >
                合并到本实例平台配置
              </button>
            ) : (
              <>
                <div>
                  <label className="mb-1 block font-mono text-[10px] text-zinc-600">新项目名称</label>
                  <input
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    className="w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[13px] text-zinc-200"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={applyCreate}
                    className="rounded-md bg-acc-500 px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-50"
                  >
                    创建为新项目
                  </button>
                  {projectId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={applyMergeProject}
                      className="rounded-md bg-white/[.06] px-3 py-1.5 text-[12px] text-zinc-300 ring-1 ring-white/[.08] disabled:opacity-50"
                    >
                      合并配置到当前项目
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
