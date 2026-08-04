import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type FindingSummary, type Project } from "../api";
import { FindingDetailPanel } from "../FindingDetailPanel";
import {
  DataTable,
  EmptyState,
  FilterCountBar,
  PageHeader,
  PageSkeleton,
  SeverityBadge,
  formatTime,
  relativeTime,
  tdCls,
  trHover,
} from "../ui";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const VERIFY = ["pending", "verifying", "confirmed", "false_positive", "needs_human"] as const;

/** 全局或项目级发现清单 */
export function FindingsPage({ scope }: { scope: "global" | "project" }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const severity = searchParams.get("severity") ?? "";
  const verify = searchParams.get("verify") ?? "";
  const projectFilter = searchParams.get("project") ?? "";
  const q = searchParams.get("q") ?? "";
  const selectedFinding = searchParams.get("finding");

  const [rows, setRows] = useState<FindingSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchDraft, setSearchDraft] = useState(q);

  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  useEffect(() => {
    if (scope !== "global") return;
    api.projects().then(setProjects).catch(() => {});
  }, [scope]);

  // 拉当前作用域全量发现，severity/verify/项目/搜索在前端筛，才能展示「筛选后 / 全量」
  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .findings({
          // 项目页只限定本项目；全局页不过滤，便于统计全量
          project_id: scope === "project" ? projectId : undefined,
        })
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
  }, [scope, projectId]);

  const setParam = (key: "severity" | "verify" | "q" | "project", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const openFinding = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("finding", id);
    else next.delete("finding");
    setSearchParams(next, { replace: true });
  };

  const projectOptions = useMemo(() => {
    if (projects.length) {
      return projects
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    }
    // 回退：从当前结果集里抽项目
    const map = new Map<string, string>();
    for (const f of rows) {
      if (f.project_id) map.set(f.project_id, f.project_name ?? f.project_id.slice(0, 8));
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [projects, rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((f) => {
      if (severity && f.severity !== severity) return false;
      if (verify && f.verify_status !== verify) return false;
      if (scope === "global" && projectFilter && f.project_id !== projectFilter) return false;
      if (!needle) return true;
      const hay =
        `${f.title} ${f.summary ?? ""} ${f.location ?? ""} ${f.project_name ?? ""} ${f.fingerprint ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, severity, verify, projectFilter, q, scope]);

  const filterActive = Boolean(
    severity || verify || q.trim() || (scope === "global" && projectFilter),
  );
  const totalCount = rows.length;
  const filteredCount = visible.length;
  const filterChips = [
    severity && `风险 ${severity}`,
    verify && `验证 ${verify}`,
    scope === "global" &&
      projectFilter &&
      `项目 ${projectOptions.find((p) => p.id === projectFilter)?.name ?? projectFilter.slice(0, 8)}`,
    q.trim() && `搜索 “${q.trim()}”`,
  ].filter((v): v is string => Boolean(v));

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("severity");
    next.delete("verify");
    next.delete("q");
    next.delete("project");
    setSearchDraft("");
    setSearchParams(next, { replace: true });
  };

  const commitSearch = () => {
    setParam("q", searchDraft.trim());
  };

  if (loading) return <PageSkeleton rows={5} />;

  return (
    <div className="page-scroll">
      <PageHeader
        title={scope === "global" ? "发现" : "项目发现"}
        eyebrow="EVIDENCE REGISTER"
        subtitle="点开任一发现可查看完整内容、验证路径与人工处置。筛选结果与全量对比见下方计数条。"
      />

      <FilterCountBar
        filtered={filteredCount}
        total={totalCount}
        unit="条发现"
        active={filterActive}
        filters={filterChips}
        onClear={clearFilters}
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {/* 桌面：筛选/搜索在表头列内（不在页头、不在表外独立条） */}
      <div className="hidden min-w-0 md:block">
        <DataTable>
          <table className="data-table-adaptive w-full">
            <colgroup>
              <col style={{ width: scope === "global" ? "11%" : "12%" }} />
              <col style={{ width: scope === "global" ? "28%" : "36%" }} />
              {scope === "global" && <col style={{ width: "14%" }} />}
              <col style={{ width: scope === "global" ? "20%" : "24%" }} />
              <col style={{ width: scope === "global" ? "14%" : "16%" }} />
              <col style={{ width: scope === "global" ? "13%" : "12%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">风险等级</span>
                    <select
                      value={severity}
                      onChange={(e) => setParam("severity", e.target.value)}
                      className="table-head-control"
                      aria-label="按风险等级筛选"
                    >
                      <option value="">全部</option>
                      {SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">标题</span>
                    <div className="table-head-search">
                      <MagnifyingGlass size={12} />
                      <input
                        value={searchDraft}
                        onChange={(e) => setSearchDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && commitSearch()}
                        onBlur={commitSearch}
                        placeholder="搜索…"
                        aria-label="搜索发现"
                      />
                      {(searchDraft || q) && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchDraft("");
                            setParam("q", "");
                          }}
                          aria-label="清除搜索"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </th>
                {scope === "global" && (
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
                )}
                <th className="table-head-cell">位置</th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">验证</span>
                    <select
                      value={verify}
                      onChange={(e) => setParam("verify", e.target.value)}
                      className="table-head-control"
                      aria-label="按验证状态筛选"
                    >
                      <option value="">全部</option>
                      {VERIFY.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="table-head-cell">时间</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={scope === "global" ? 6 : 5}
                    className="px-4 py-12 text-center text-[13px] text-zinc-600"
                  >
                    {error
                      ? error
                      : rows.length
                        ? `没有匹配当前筛选的发现（0 / 全量 ${totalCount}），可在表头调整条件`
                        : "暂无发现 · 审计产出 finding 后会汇总到这里"}
                  </td>
                </tr>
              ) : (
                visible.map((f) => (
                  <tr
                    key={f.id}
                    className={`${trHover} cursor-pointer`}
                    onClick={() => openFinding(f.id)}
                  >
                    <td className={tdCls}>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td className={tdCls}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openFinding(f.id);
                        }}
                        className="text-left font-medium text-zinc-100 hover:text-acc-400"
                      >
                        {f.title}
                      </button>
                      {f.summary && (
                        <div className="mt-0.5 line-clamp-1 text-[13px] text-zinc-600">
                          {f.summary}
                        </div>
                      )}
                    </td>
                    {scope === "global" && (
                      <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                        <Link
                          to={`/projects/${f.project_id}/findings`}
                          className="hover:text-acc-400"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.project_name}
                        </Link>
                      </td>
                    )}
                    <td className={`${tdCls} max-w-[220px] truncate font-mono text-[13px] text-zinc-500`}>
                      {f.location || "—"}
                    </td>
                    <td className={`${tdCls} font-mono text-[13px]`}>{f.verify_status}</td>
                    <td
                      className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                      title={formatTime(f.created_at)}
                    >
                      {relativeTime(f.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </DataTable>
      </div>

      {/* 移动端：列筛选并入首卡，与列表同构，不进页头 */}
      <div className="md:hidden">
        <div className="surface-shell mb-3">
          <div className="surface-core space-y-2 p-3">
            <div className="relative">
              <MagnifyingGlass
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
              />
              <input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitSearch()}
                onBlur={commitSearch}
                placeholder="搜索标题、位置、指纹…"
                className="w-full rounded-md border border-white/[.08] bg-black/25 py-2 pl-8 pr-8 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              {(searchDraft || q) && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600"
                  onClick={() => {
                    setSearchDraft("");
                    setParam("q", "");
                  }}
                  aria-label="清除搜索"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className={`grid gap-2 ${scope === "global" ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2"}`}>
              <select
                value={severity}
                onChange={(e) => setParam("severity", e.target.value)}
                className="table-head-control max-w-none"
                aria-label="Severity"
              >
                <option value="">全部 severity</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {scope === "global" && (
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
              )}
              <select
                value={verify}
                onChange={(e) => setParam("verify", e.target.value)}
                className="table-head-control max-w-none"
                aria-label="验证状态"
              >
                <option value="">全部验证</option>
                {VERIFY.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            title={rows.length ? `没有匹配当前筛选的发现（0 / 全量 ${totalCount}）` : "暂无发现"}
            hint={rows.length ? "调整上方筛选条件，或清除筛选查看全量" : "审计产出 finding 后会汇总到这里"}
          />
        ) : (
          <div className="grid gap-3">
            {visible.map((finding) => (
              <button
                type="button"
                key={finding.id}
                onClick={() => openFinding(finding.id)}
                className="surface-shell group text-left"
              >
                <article className="surface-core p-4">
                  <div className="flex items-center justify-between gap-3">
                    <SeverityBadge severity={finding.severity} />
                    <span className="font-mono text-[8px] text-zinc-700">
                      {relativeTime(finding.created_at)}
                    </span>
                  </div>
                  <h2 className="mt-3 text-[14px] font-medium leading-6 text-zinc-100">
                    {finding.title}
                  </h2>
                  {finding.summary && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-zinc-600">
                      {finding.summary}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-2 border-t border-white/[.045] pt-3 text-[9px] text-zinc-600">
                    <span className="truncate">{finding.project_name}</span>
                    <span>·</span>
                    <span className="truncate font-mono">{finding.location || "无位置"}</span>
                    <span className="ml-auto font-mono text-zinc-500">{finding.verify_status}</span>
                  </div>
                </article>
              </button>
            ))}
          </div>
        )}
      </div>
      {selectedFinding && (
        <FindingDetailPanel findingId={selectedFinding} onClose={() => openFinding(null)} />
      )}
    </div>
  );
}
