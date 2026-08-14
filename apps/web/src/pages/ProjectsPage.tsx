import {
  AirplaneTakeoff,
  Archive,
  ArrowCounterClockwise,
  ArrowUpRight,
  Folder,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project } from "../api";
import { SearchableMultiSelect } from "../SearchableSelect";
import { IntentLaunchRail } from "../components/IntentLaunchRail";
import {
  hasNewProjectIntent,
  newProjectIntentSearch,
  shouldShowQuickStartRail,
} from "../dashboard-quick-start";
import {
  EmptyState,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  formatTime,
} from "../ui";

const inputCls =
  "w-full border bg-transparent px-3 py-2.5 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-700";

type StatusFilter = "active" | "archived";
type SourceFilter = "local" | "plane";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter[]>(["active"]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });

  const reload = () =>
    api
      .projects()
      .then((list) => {
        setProjects(list);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });

  useEffect(() => {
    reload();
  }, []);

  const flash = (message: string) => {
    setMsg(message);
    setTimeout(() => setMsg(null), 3200);
  };

  const archivedCount = projects.filter((p) => p.status === "archived").length;
  const activeCount = projects.filter((p) => p.status === "active").length;
  const planeCount = projects.filter((p) => p.plane_project_id).length;
  const explicitNewProject = hasNewProjectIntent(searchParams);
  const showIntentRail = shouldShowQuickStartRail({
    projects,
    loaded: !loading,
    loadError: error,
    forced: explicitNewProject,
  });

  // Promote a successful cold-start into the same URL-backed intent used by
  // the explicit button. This keeps the rail mounted after its first project
  // is created, including readiness/task failures, without persisting drafts.
  useEffect(() => {
    if (loading || error || explicitNewProject || activeCount > 0) return;
    setSearchParams(newProjectIntentSearch(searchParams, true), { replace: true });
  }, [activeCount, error, explicitNewProject, loading, searchParams, setSearchParams]);

  const openNewProjectIntent = () => {
    setSearchParams(newProjectIntentSearch(searchParams, true));
  };

  const cancelNewProjectIntent = () => {
    if (!activeCount) return;
    setSearchParams(newProjectIntentSearch(searchParams, false), { replace: true });
  };

  const handleProjectCreated = (project: Project) => {
    setProjects((before) => before.some((item) => item.id === project.id)
      ? before.map((item) => item.id === project.id ? project : item)
      : [project, ...before]);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (statusFilter.length > 0 && !statusFilter.includes(project.status)) return false;
      const source: SourceFilter = project.plane_project_id ? "plane" : "local";
      if (sourceFilter.length > 0 && !sourceFilter.includes(source)) return false;
      if (!needle) return true;
      const haystack = `${project.name} ${project.description ?? ""} ${project.plane_project_id ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [projects, query, statusFilter, sourceFilter]);

  if (loading) return <PageSkeleton rows={3} />;

  return (
    <div className="page-scroll">
      <PageHeader
        title="项目空间"
        eyebrow="WORKSPACES"
        subtitle="一个项目承载稳定的代码边界、Agent 配置和长期证据；每次具体目标则作为独立任务进入同一条闭环。"
        actions={
          <PrimaryButton onClick={openNewProjectIntent}>
            <Plus size={15} weight="bold" />
            新建项目
          </PrimaryButton>
        }
      />

      {showIntentRail && (
        <IntentLaunchRail
          projects={projects}
          forcedNewProject
          canCancel={activeCount > 0}
          onCancel={cancelNewProjectIntent}
          onProjectCreated={handleProjectCreated}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { label: "进行中", value: activeCount },
          { label: "Plane", value: planeCount },
          { label: "已归档", value: archivedCount },
          { label: "全部", value: projects.length },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-full bg-white/[.025] px-3 py-1.5 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.045]"
          >
            <strong className="mr-1.5 tabular-nums text-zinc-300">{item.value}</strong>
            {item.label}
          </div>
        ))}
      </div>

      {/* 搜索 / 筛选 */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="selector-search min-w-0 flex-1">
          <MagnifyingGlass size={14} weight="light" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目名称、说明或 Plane ID"
            aria-label="搜索项目"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mr-1 rounded p-1 text-zinc-600 hover:text-zinc-300"
              aria-label="清除搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchableMultiSelect
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter[])}
            placeholder="全部状态"
            options={[
              { value: "active", label: "进行中" },
              { value: "archived", label: "已归档" },
            ]}
          />
          <SearchableMultiSelect
            value={sourceFilter}
            onChange={(value) => setSourceFilter(value as SourceFilter[])}
            placeholder="全部来源"
            options={[
              { value: "local", label: "本地" },
              { value: "plane", label: "Plane" },
            ]}
          />
          <span className="font-mono text-[10px] text-zinc-600">
            {filtered.length}/{projects.length}
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">
          {error}
        </div>
      )}
      {msg && (
        <div
          role="status"
          className="mb-4 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[12px] text-acc-300 ring-1 ring-acc-400/15"
        >
          {msg}
        </div>
      )}

      {filtered.length === 0 && !error ? (
        <EmptyState
          title={
            projects.length
              ? query || statusFilter.length !== 1 || statusFilter[0] !== "active" || sourceFilter.length > 0
                ? "没有匹配的项目"
                : "没有进行中的项目"
              : "创建你的第一个项目空间"
          }
          hint={
            projects.length
              ? "试试调整搜索关键词或筛选条件。"
              : "项目只定义长期边界；创建后你可以立即用自然语言下达第一项任务。"
          }
          action={
            showIntentRail ? undefined : query || statusFilter.length > 0 || sourceFilter.length > 0 ? (
              <SecondaryButton
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatusFilter([]);
                  setSourceFilter([]);
                }}
              >
                清除筛选
              </SecondaryButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project, index) => (
            <article
              key={project.id}
              className={`surface-shell deepsonar-reveal ${
                project.status === "archived" ? "opacity-60" : ""
              }`}
              style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
            >
              <div className="surface-core flex h-full flex-col p-3.5">
                {editing === project.id ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await api.updateProject(project.id, {
                          name: editForm.name.trim() || undefined,
                          description: editForm.description,
                        });
                        setEditing(null);
                        flash("项目资料已保存");
                        reload();
                      } catch (err) {
                        flash(`保存失败：${err instanceof Error ? err.message : err}`);
                      }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9px] tracking-[.14em] text-acc-300">
                        EDIT
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded p-1 text-zinc-600 hover:text-zinc-200"
                        aria-label="取消编辑"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <input
                      autoFocus
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className={inputCls}
                    />
                    <textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      className={`${inputCls} min-h-16 resize-y`}
                      placeholder="项目说明"
                    />
                    <div className="flex justify-end gap-2">
                      <SecondaryButton type="button" onClick={() => setEditing(null)}>
                        取消
                      </SecondaryButton>
                      <PrimaryButton type="submit">保存</PrimaryButton>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex items-start gap-2.5">
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[.035] text-acc-300 ring-1 ring-white/[.06]">
                        <Folder size={16} weight="light" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to={`/projects/${project.id}/tasks`}
                            className="truncate text-[13px] font-medium text-zinc-100 hover:text-acc-300"
                            title={project.name}
                          >
                            {project.name}
                          </Link>
                          {project.status === "archived" && (
                            <span className="shrink-0 rounded bg-white/[.04] px-1.5 py-0.5 font-mono text-[8px] text-zinc-500">
                              归档
                            </span>
                          )}
                        </div>
                        <p
                          className="mt-1 line-clamp-1 text-[11px] leading-4 text-zinc-600"
                          title={project.description || undefined}
                        >
                          {project.description || "暂无说明"}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/[.045] pt-2.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[8px] ${
                          project.plane_project_id
                            ? "bg-run-400/[.08] text-run-400"
                            : "bg-white/[.03] text-zinc-600"
                        }`}
                      >
                        {project.plane_project_id ? (
                          <>
                            <AirplaneTakeoff size={10} /> Plane
                          </>
                        ) : (
                          "LOCAL"
                        )}
                      </span>
                      <span
                        className="font-mono text-[8px] text-zinc-700"
                        title={formatTime(project.created_at)}
                      >
                        {formatTime(project.created_at)}
                      </span>
                      <div className="ml-auto flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(project.id);
                            setEditForm({
                              name: project.name,
                              description: project.description ?? "",
                            });
                          }}
                          className="rounded p-1.5 text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                          title="编辑"
                        >
                          <PencilSimple size={13} weight="light" />
                        </button>
                        {project.status === "active" ? (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.archiveProject(project.id).catch(() => {});
                              flash("项目已归档");
                              reload();
                            }}
                            className="rounded p-1.5 text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                            title="归档"
                          >
                            <Archive size={13} weight="light" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={async () => {
                              await api.updateProject(project.id, { status: "active" }).catch(() => {});
                              flash("项目已恢复");
                              reload();
                            }}
                            className="rounded p-1.5 text-zinc-600 transition-colors hover:bg-acc-500/[.07] hover:text-acc-300"
                            title="恢复"
                          >
                            <ArrowCounterClockwise size={13} weight="light" />
                          </button>
                        )}
                        <Link
                          to={`/projects/${project.id}/tasks`}
                          className="group ml-0.5 inline-flex items-center gap-1 rounded-md bg-white/[.045] px-2 py-1 text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-all hover:bg-white/[.08] hover:text-white"
                        >
                          进入
                          <ArrowUpRight
                            size={11}
                            className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                          />
                        </Link>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
