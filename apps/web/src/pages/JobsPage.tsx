import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type JobSummary, type Project } from "../api";
import { JobDetailPanel } from "../JobDetailPanel";
import {
  DataTable,
  EmptyState,
  FilterCountBar,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  formatTime,
  relativeTime,
  tdCls,
} from "../ui";

const STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "timeout",
  "orphan",
  "cancelled",
] as const;

const CANCELLABLE = new Set([
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
]);
const RESUMABLE = new Set(["waiting_human", "orphan", "failed", "timeout"]);

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const typeFilter = searchParams.get("type") ?? "";
  const projectFilter = searchParams.get("project") ?? "";
  const canvasFilter = searchParams.get("canvas") ?? "";
  const cliFilter = searchParams.get("cli") ?? "";
  const modelFilter = searchParams.get("model") ?? "";
  const selectedJob = searchParams.get("job");
  const [rows, setRows] = useState<JobSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 拉全量队列，筛选在前端做，才能同时展示「筛选后 / 全量」
  const reload = () =>
    api
      .jobs({})
      .then((list) => {
        setRows(list);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .jobs({})
        .then((list) => {
          if (!stop) {
            setRows(list);
            setError(null);
            setLoading(false);
          }
        })
        .catch((e) => {
          if (!stop) {
            setError(String(e));
            setLoading(false);
          }
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const setParam = (key: "status" | "type" | "project" | "canvas" | "cli" | "model", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    // 切换项目时清空画布筛选，避免跨项目残留
    if (key === "project") next.delete("canvas");
    setSearchParams(next, { replace: true });
  };

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const j of rows) if (j.type) set.add(j.type);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const cliOptions = useMemo(() => {
    const set = new Set<string>();
    for (const j of rows) if (j.agent_cli) set.add(j.agent_cli);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const j of rows) if (j.model) set.add(j.model);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const projectOptions = useMemo(() => {
    if (projects.length) {
      return projects
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    }
    const map = new Map<string, string>();
    for (const j of rows) {
      if (j.project_id) map.set(j.project_id, j.project_name ?? j.project_id.slice(0, 8));
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [projects, rows]);

  const canvasOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of rows) {
      if (!j.canvas_id) continue;
      if (projectFilter && j.project_id !== projectFilter) continue;
      map.set(j.canvas_id, j.canvas_title ?? j.canvas_id.slice(0, 8));
    }
    return [...map.entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }, [rows, projectFilter]);

  const visible = useMemo(() => {
    return rows.filter((j) => {
      if (status && j.status !== status) return false;
      if (typeFilter && j.type !== typeFilter) return false;
      if (projectFilter && j.project_id !== projectFilter) return false;
      if (canvasFilter && j.canvas_id !== canvasFilter) return false;
      if (cliFilter && (j.agent_cli ?? "") !== cliFilter) return false;
      if (modelFilter && (j.model ?? "") !== modelFilter) return false;
      return true;
    });
  }, [rows, status, typeFilter, projectFilter, canvasFilter, cliFilter, modelFilter]);

  const filterActive = Boolean(
    status || typeFilter || projectFilter || canvasFilter || cliFilter || modelFilter,
  );
  const totalCount = rows.length;
  const filteredCount = visible.length;
  const filterChips = [
    status && `状态 ${status}`,
    typeFilter && `类型 ${typeFilter}`,
    cliFilter && `CLI ${cliFilter}`,
    modelFilter && `模型 ${modelFilter}`,
    projectFilter &&
      `项目 ${projectOptions.find((p) => p.id === projectFilter)?.name ?? projectFilter.slice(0, 8)}`,
    canvasFilter &&
      `画布 ${canvasOptions.find((c) => c.id === canvasFilter)?.title ?? canvasFilter.slice(0, 8)}`,
  ].filter((v): v is string => Boolean(v));

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("status");
    next.delete("type");
    next.delete("project");
    next.delete("canvas");
    next.delete("cli");
    next.delete("model");
    setSearchParams(next, { replace: true });
  };

  const act = async (id: string, kind: "cancel" | "resume") => {
    if (kind === "cancel" && !window.confirm("强制退出该 Job？将立即取消调度并回收沙箱。")) return;
    setBusy(id);
    try {
      if (kind === "cancel") await api.cancelJob(id, { force: true, reason: "强制退出" });
      else await api.resumeJob(id);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openJob = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("job", id);
    else next.delete("job");
    setSearchParams(next, { replace: true });
  };

  if (loading) return <PageSkeleton rows={6} />;

  return (
    <div className="page-scroll">
      <PageHeader
        title="调度队列"
        eyebrow="EXECUTION LEDGER"
        subtitle="用于定位异常、取消活动任务，或恢复失败与待人工任务。筛选结果与全量对比见下方计数条。"
      />

      <FilterCountBar
        filtered={filteredCount}
        total={totalCount}
        unit="条运行"
        active={filterActive}
        filters={filterChips}
        onClear={clearFilters}
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {/* 桌面：状态 / 类型 / CLI / 模型 / 项目 / 画布 表头筛选 */}
      <div className="hidden min-w-0 md:block">
        <DataTable>
          <table className="data-table-adaptive w-full min-w-[1100px]">
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "11%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">状态</span>
                    <select
                      value={status}
                      onChange={(e) => setParam("status", e.target.value)}
                      className="table-head-control"
                      aria-label="按状态筛选"
                    >
                      <option value="">全部</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">类型</span>
                    <select
                      value={typeFilter}
                      onChange={(e) => setParam("type", e.target.value)}
                      className="table-head-control"
                      aria-label="按类型筛选"
                    >
                      <option value="">全部</option>
                      {typeOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">CLI 工具</span>
                    <select
                      value={cliFilter}
                      onChange={(e) => setParam("cli", e.target.value)}
                      className="table-head-control"
                      aria-label="按 CLI 工具筛选"
                    >
                      <option value="">全部</option>
                      {cliOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">模型</span>
                    <select
                      value={modelFilter}
                      onChange={(e) => setParam("model", e.target.value)}
                      className="table-head-control"
                      aria-label="按模型筛选"
                    >
                      <option value="">全部</option>
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">项目</span>
                    <select
                      value={projectFilter}
                      onChange={(e) => setParam("project", e.target.value)}
                      className="table-head-control"
                      aria-label="按项目筛选"
                    >
                      <option value="">全部</option>
                      {projectOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">任务画布</span>
                    <select
                      value={canvasFilter}
                      onChange={(e) => setParam("canvas", e.target.value)}
                      className="table-head-control"
                      aria-label="按任务画布筛选"
                    >
                      <option value="">全部</option>
                      {canvasOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">开始</th>
                <th className="table-head-cell">创建</th>
                <th className="table-head-cell">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-[13px] text-zinc-600">
                    {rows.length
                      ? `没有匹配当前筛选的运行（0 / 全量 ${totalCount}），可在表头调整条件`
                      : "队列为空 · 没有匹配的 Job"}
                  </td>
                </tr>
              ) : (
                visible.map((j) => (
                  <tr
                    key={j.id}
                    className="table-row-hover cursor-pointer"
                    onClick={() => openJob(j.id)}
                  >
                    <td className={tdCls}>
                      <StatusBadge status={j.status} />
                      {j.error && (
                        <div
                          className="mt-0.5 max-w-full truncate font-mono text-[12px] text-red-400"
                          title={j.error}
                        >
                          {j.error}
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-[13px]`}>
                      <button type="button" className="text-left hover:text-acc-400" onClick={(event) => { event.stopPropagation(); openJob(j.id); }}>
                        <span className="block">{j.type}</span>
                        {j.role_name && (
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={j.role_name}>
                            {j.role_name}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className={`${tdCls} font-mono text-[12px] text-zinc-300`}>
                      {j.agent_cli ? (
                        <span className="rounded-md bg-acc-500/10 px-1.5 py-0.5 text-acc-300 ring-1 ring-acc-400/20">
                          {j.agent_cli}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className={`${tdCls} max-w-[160px] font-mono text-[12px] text-zinc-300`}>
                      {j.model ? (
                        <span className="block truncate" title={j.model}>
                          {j.model}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                      {j.credential_provider && (
                        <div className="mt-0.5 truncate text-[10px] text-zinc-600" title={j.credential_provider}>
                          via {j.credential_provider}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <Link
                        to={`/projects/${j.project_id}/tasks`}
                        className="text-zinc-300 hover:text-acc-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {j.project_name ?? j.project_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className={`${tdCls} max-w-[180px]`}>
                      {j.canvas_id ? (
                        <Link
                          to={`/projects/${j.project_id}/tasks/${j.canvas_id}`}
                          className="block truncate text-zinc-300 hover:text-acc-400"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {j.canvas_title ?? j.canvas_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                      {formatTime(j.started_at)}
                    </td>
                    <td
                      className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                      title={formatTime(j.created_at)}
                    >
                      {relativeTime(j.created_at)}
                    </td>
                    <td className={tdCls}>
                      <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {CANCELLABLE.has(j.status) && (
                          <button
                            disabled={busy === j.id}
                            onClick={() => act(j.id, "cancel")}
                            title="强制退出：取消 Job 并回收沙箱"
                            className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 transition-colors hover:border-red-900/60 hover:text-red-300 disabled:opacity-50"
                          >
                            强制退出
                          </button>
                        )}
                        {RESUMABLE.has(j.status) && (
                          <button
                            disabled={busy === j.id}
                            onClick={() => act(j.id, "resume")}
                            className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 transition-colors hover:border-acc-500/50 hover:text-acc-400 disabled:opacity-50"
                          >
                            恢复
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </DataTable>
      </div>

      {/* 移动端筛选 */}
      <div className="md:hidden">
        <div className="surface-shell mb-3">
          <div className="surface-core grid grid-cols-2 gap-2 p-3">
            <select
              value={status}
              onChange={(e) => setParam("status", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="状态"
            >
              <option value="">全部状态</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setParam("type", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="类型"
            >
              <option value="">全部类型</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={cliFilter}
              onChange={(e) => setParam("cli", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="CLI 工具"
            >
              <option value="">全部 CLI</option>
              {cliOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={modelFilter}
              onChange={(e) => setParam("model", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="模型"
            >
              <option value="">全部模型</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={projectFilter}
              onChange={(e) => setParam("project", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="项目"
            >
              <option value="">全部项目</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={canvasFilter}
              onChange={(e) => setParam("canvas", e.target.value)}
              className="table-head-control max-w-none"
              aria-label="任务画布"
            >
              <option value="">全部画布</option>
              {canvasOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            title={rows.length ? `没有匹配当前筛选的运行（0 / 全量 ${totalCount}）` : "队列为空"}
            hint={rows.length ? "调整上方筛选条件，或清除筛选查看全量" : "没有 Job"}
          />
        ) : (
          <div className="grid gap-3">
            {visible.map((j) => (
              <article key={j.id} className="surface-shell">
                <div className="surface-core p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                        {j.type}
                        {j.role_name ? ` · ${j.role_name}` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => openJob(j.id)}
                        className="mt-2 block truncate text-left text-[14px] font-medium text-zinc-100 hover:text-acc-400"
                      >
                        {j.canvas_title ?? j.project_name ?? j.id.slice(0, 8)}
                      </button>
                      <p className="mt-1 font-mono text-[10px] text-zinc-500">
                        {[j.agent_cli ?? "CLI 未冻结", j.model ?? "模型未冻结"]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <p className="mt-1 text-[10px] text-zinc-600">
                        {j.project_name} · {relativeTime(j.created_at)}
                      </p>
                    </div>
                    <StatusBadge status={j.status} />
                  </div>
                  {j.error && (
                    <p className="mt-3 line-clamp-2 rounded-xl bg-red-400/[.05] px-3 py-2 font-mono text-[9px] leading-4 text-red-300">
                      {j.error}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-2 border-t border-white/[.045] pt-3">
                    <button
                      type="button"
                      onClick={() => openJob(j.id)}
                      className="secondary-button min-h-8 px-3 py-1 text-[10px]"
                    >
                      详情
                    </button>
                    {CANCELLABLE.has(j.status) && (
                      <button
                        disabled={busy === j.id}
                        onClick={() => act(j.id, "cancel")}
                        title="强制退出：取消 Job 并回收沙箱"
                        className="secondary-button min-h-8 px-3 py-1 text-[10px]"
                      >
                        强制退出
                      </button>
                    )}
                    {RESUMABLE.has(j.status) && (
                      <button
                        disabled={busy === j.id}
                        onClick={() => act(j.id, "resume")}
                        className="secondary-button min-h-8 px-3 py-1 text-[10px]"
                      >
                        恢复
                      </button>
                    )}
                    <span className="ml-auto font-mono text-[8px] text-zinc-700">
                      {formatTime(j.started_at)}
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {selectedJob && <JobDetailPanel jobId={selectedJob} onClose={() => openJob(null)} />}
    </div>
  );
}
