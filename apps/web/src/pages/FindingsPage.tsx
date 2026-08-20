import { GitMerge, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type FindingSummary, type Project } from "../api";
import { FindingDetailPanel } from "../FindingDetailPanel";
import { SearchableMultiSelect } from "../SearchableSelect";
import { readMultiSearchParam, writeMultiSearchParam } from "../searchable-select-model";
import { composeSeedTaskUrl, isComposeSeedCandidate, MAX_COMPOSE_SEEDS } from "../composeTaskModel";
import {
  DataTable,
  DISPOSITION_OPTIONS,
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
const VERIFY_OPTIONS = [
  { value: "pending", label: "待验证" },
  { value: "verifying", label: "验证中" },
  { value: "confirmed", label: "已确认" },
  { value: "false_positive", label: "已排除" },
  { value: "needs_human", label: "待人工" },
] as const;
const VERIFY_LABELS = Object.fromEntries(VERIFY_OPTIONS.map((option) => [option.value, option.label]));
const DISPOSITION_LABELS = Object.fromEntries(DISPOSITION_OPTIONS.map((option) => [option.value, option.label]));

function FindingStateBadges({ finding }: { finding: FindingSummary }) {
  const verifyStatus = finding.verify_status || "pending";
  const disposition = finding.disposition || "open";
  const verifyTone = verifyStatus === "confirmed"
    ? "border-emerald-400/25 bg-emerald-400/[.08] text-emerald-300"
    : verifyStatus === "needs_human"
      ? "border-amber-400/25 bg-amber-400/[.08] text-amber-300"
      : "border-sky-400/20 bg-sky-400/[.06] text-sky-300";
  const dispositionTone = disposition === "confirmed_vuln"
    ? "border-red-400/25 bg-red-400/[.08] text-red-300"
    : disposition === "open"
      ? "border-amber-400/25 bg-amber-400/[.08] text-amber-300"
      : disposition === "accepted"
        ? "border-sky-400/20 bg-sky-400/[.06] text-sky-300"
        : "border-zinc-400/20 bg-zinc-400/[.06] text-zinc-400";
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${verifyTone}`} title={`技术验证状态：${VERIFY_LABELS[verifyStatus] ?? verifyStatus}`}>
        技术 · {VERIFY_LABELS[verifyStatus] ?? verifyStatus}
      </span>
      <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${dispositionTone}`} title={`人工处置状态：${DISPOSITION_LABELS[disposition] ?? disposition}`}>
        处置 · {DISPOSITION_LABELS[disposition] ?? disposition}
      </span>
    </div>
  );
}

/** 全局或项目级发现清单 */
export function FindingsPage({ scope }: { scope: "global" | "project" }) {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const severities = readMultiSearchParam(searchParams, "severity");
  const profiles = readMultiSearchParam(searchParams, "profile");
  const verifyStatuses = readMultiSearchParam(searchParams, "verify");
  const dispositions = readMultiSearchParam(searchParams, "disposition");
  const projectFilters = readMultiSearchParam(searchParams, "project");
  const q = searchParams.get("q") ?? "";
  const selectedFinding = searchParams.get("finding");

  const [rows, setRows] = useState<FindingSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchDraft, setSearchDraft] = useState(q);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

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

  const setParam = (key: "q", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const setMultiParam = (key: "severity" | "profile" | "verify" | "disposition" | "project", values: string[]) => {
    const next = new URLSearchParams(searchParams);
    writeMultiSearchParam(next, key, values);
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
      if (severities.length && !severities.includes(f.severity ?? "")) return false;
      if (profiles.length && !profiles.includes(f.profile)) return false;
      if (verifyStatuses.length && !verifyStatuses.includes(f.verify_status ?? "pending")) return false;
      if (dispositions.length && !dispositions.includes(String(f.disposition ?? "open"))) return false;
      if (scope === "global" && projectFilters.length && !projectFilters.includes(f.project_id)) return false;
      if (!needle) return true;
      const hay =
        `${f.title} ${f.profile} ${f.category ?? ""} ${f.summary ?? ""} ${f.location ?? ""} ${f.project_name ?? ""} ${f.canvas_title ?? ""} ${f.tags_json.join(" ")} ${f.fingerprint ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, severities, profiles, verifyStatuses, dispositions, projectFilters, q, scope]);

  const filterActive = Boolean(
    severities.length || profiles.length || verifyStatuses.length || dispositions.length || q.trim() || (scope === "global" && projectFilters.length),
  );
  const totalCount = rows.length;
  const filteredCount = visible.length;
  const filterChips = [
    ...severities.map((value) => `风险 ${value}`),
    ...profiles.map((value) => `协议 ${value}`),
    ...verifyStatuses.map((value) => `验证 ${VERIFY_LABELS[value] ?? value}`),
    ...dispositions.map((value) => `处置 ${DISPOSITION_LABELS[value] ?? value}`),
    ...(scope === "global" ? projectFilters.map((value) => `项目 ${projectOptions.find((project) => project.id === value)?.name ?? value.slice(0, 8)}`) : []),
    ...(q.trim() ? [`搜索 “${q.trim()}”`] : []),
  ];

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("severity");
    next.delete("profile");
    next.delete("verify");
    next.delete("disposition");
    next.delete("q");
    next.delete("project");
    setSearchDraft("");
    setSearchParams(next, { replace: true });
  };

  const commitSearch = () => {
    setParam("q", searchDraft.trim());
  };
  const visibleCandidates = visible.filter(isComposeSeedCandidate);
  const visibleSelectableCandidates = visibleCandidates.slice(0, MAX_COMPOSE_SEEDS);
  const selectedCandidates = rows.filter((finding) => selectedIds.has(finding.id) && isComposeSeedCandidate(finding));
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_COMPOSE_SEEDS) next.add(id);
    return next;
  });
  useEffect(() => {
    setSelectedIds((current) => new Set(
      [...current].filter((id) => rows.some((finding) => finding.id === id && isComposeSeedCandidate(finding))),
    ));
  }, [rows]);

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

      {scope === "project" && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y border-white/[.05] py-3">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-[11px] text-zinc-500">
              <input
                type="checkbox"
                checked={visibleSelectableCandidates.length > 0 && visibleSelectableCandidates.every((finding) => selectedIds.has(finding.id))}
                onChange={() => setSelectedIds((current) => {
                  const next = new Set(current);
                  const allSelected = visibleSelectableCandidates.length > 0 && visibleSelectableCandidates.every((finding) => next.has(finding.id));
                  if (allSelected) visibleSelectableCandidates.forEach((finding) => next.delete(finding.id));
                  else for (const finding of visibleSelectableCandidates) { if (next.size < MAX_COMPOSE_SEEDS) next.add(finding.id); }
                  return next;
                })}
                className="accent-emerald-400"
              />
              选择当前可代入结果（最多 {MAX_COMPOSE_SEEDS} 条，含未确认）
            </label>
            <span className="font-mono text-[10px] text-zinc-600">{selectedCandidates.length} / {MAX_COMPOSE_SEEDS}</span>
          </div>
          <button
            type="button"
            disabled={!projectId || selectedCandidates.length === 0}
            onClick={() => projectId && navigate(composeSeedTaskUrl(projectId, selectedCandidates.map((finding) => finding.id)))}
            className="inline-flex items-center gap-2 rounded-md bg-acc-500/[.1] px-3 py-2 text-[11px] font-medium text-acc-200 ring-1 ring-acc-400/20 hover:bg-acc-500/[.16] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GitMerge size={14} />用这些开组合任务
          </button>
        </div>
      )}

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
              {scope === "project" && <col style={{ width: "5%" }} />}
              <col style={{ width: scope === "global" ? "11%" : "11%" }} />
              <col style={{ width: scope === "global" ? "28%" : "36%" }} />
              {scope === "global" && <col style={{ width: "14%" }} />}
              <col style={{ width: scope === "global" ? "20%" : "24%" }} />
              <col style={{ width: scope === "global" ? "14%" : "16%" }} />
              <col style={{ width: scope === "global" ? "13%" : "12%" }} />
            </colgroup>
            <thead>
              <tr>
                {scope === "project" && <th className="table-head-cell"><span className="sr-only">选择</span></th>}
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">风险等级</span>
                    <SearchableMultiSelect
                      value={severities}
                      onChange={(values) => setMultiParam("severity", values)}
                      options={SEVERITIES.map((value) => ({ value, label: value }))}
                      placeholder="全部风险"
                      ariaLabel="按风险等级筛选"
                      className="contents"
                    />
                  </div>
                </th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">标题</span>
                    <SearchableMultiSelect
                      value={profiles}
                      onChange={(values) => setMultiParam("profile", values)}
                      options={Array.from(new Set(rows.map((finding) => finding.profile))).sort().map((value) => ({ value, label: value }))}
                      placeholder="全部 profile"
                      ariaLabel="按 Finding profile 筛选"
                      className="contents"
                    />
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
                      <SearchableMultiSelect
                        value={projectFilters}
                        onChange={(values) => setMultiParam("project", values)}
                        options={projectOptions.map((project) => ({ value: project.id, label: project.name }))}
                        placeholder="全部项目"
                        ariaLabel="按项目筛选"
                        className="contents"
                      />
                    </div>
                  </th>
                )}
                <th className="table-head-cell">位置</th>
                <th className="table-head-cell">
                  <div className="table-head-stack">
                    <span className="table-head-label">验证</span>
                    <SearchableMultiSelect
                      value={verifyStatuses}
                      onChange={(values) => setMultiParam("verify", values)}
                      options={VERIFY_OPTIONS}
                      placeholder="全部验证"
                      ariaLabel="按验证状态筛选"
                      className="contents"
                    />
                    <SearchableMultiSelect
                      value={dispositions}
                      onChange={(values) => setMultiParam("disposition", values)}
                      options={DISPOSITION_OPTIONS}
                      placeholder="全部处置"
                      ariaLabel="按处置状态筛选"
                      className="contents"
                    />
                  </div>
                </th>
                <th className="table-head-cell">时间</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={scope === "global" ? 6 : 6}
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
                    {scope === "project" && (
                      <td className={tdCls}>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${f.title}`}
                          checked={selectedIds.has(f.id)}
                          disabled={!isComposeSeedCandidate(f) || (!selectedIds.has(f.id) && selectedIds.size >= MAX_COMPOSE_SEEDS)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSelected(f.id)}
                          className="accent-emerald-400 disabled:opacity-30"
                        />
                      </td>
                    )}
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
                      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[9px] text-zinc-500">
                        <span>{f.profile}</span>
                        {f.category && <span>{f.category}</span>}
                        <span>
                          {f.scoring_json?.base_score == null
                            ? "未评分"
                            : `${String(f.scoring_json.standard)} ${String(f.scoring_json.version)} · ${String(f.scoring_json.base_score)} · ${String(f.scoring_json.exploitability_label ?? "难度未知")}`}
                        </span>
                      </div>
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
                    <td className={tdCls}><FindingStateBadges finding={f} /></td>
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
                className="theme-input-surface w-full rounded-md border py-2 pl-8 pr-8 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
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
              <SearchableMultiSelect value={severities} onChange={(values) => setMultiParam("severity", values)} options={SEVERITIES.map((value) => ({ value, label: value }))} placeholder="全部风险" ariaLabel="Severity" className="contents" />
              <SearchableMultiSelect value={profiles} onChange={(values) => setMultiParam("profile", values)} options={Array.from(new Set(rows.map((finding) => finding.profile))).sort().map((value) => ({ value, label: value }))} placeholder="全部 profile" ariaLabel="Finding profile" className="contents" />
              {scope === "global" && <SearchableMultiSelect value={projectFilters} onChange={(values) => setMultiParam("project", values)} options={projectOptions.map((project) => ({ value: project.id, label: project.name }))} placeholder="全部项目" ariaLabel="项目" className="contents" />}
              <SearchableMultiSelect value={verifyStatuses} onChange={(values) => setMultiParam("verify", values)} options={VERIFY_OPTIONS} placeholder="全部验证" ariaLabel="验证状态" className="contents" />
              <SearchableMultiSelect value={dispositions} onChange={(values) => setMultiParam("disposition", values)} options={DISPOSITION_OPTIONS} placeholder="全部处置" ariaLabel="处置状态" className="contents" />
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
              <article key={finding.id} className="surface-shell text-left">
                <div className="surface-core p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {scope === "project" && (
                        <input
                          type="checkbox"
                          aria-label={`选择 ${finding.title}`}
                          checked={selectedIds.has(finding.id)}
                          disabled={!isComposeSeedCandidate(finding) || (!selectedIds.has(finding.id) && selectedIds.size >= MAX_COMPOSE_SEEDS)}
                          onChange={() => toggleSelected(finding.id)}
                          className="accent-emerald-400 disabled:opacity-30"
                        />
                      )}
                      <SeverityBadge severity={finding.severity} />
                    </div>
                    <span className="font-mono text-[8px] text-zinc-700">{relativeTime(finding.created_at)}</span>
                  </div>
                  <button type="button" onClick={() => openFinding(finding.id)} className="mt-3 block text-left text-[14px] font-medium leading-6 text-zinc-100 hover:text-acc-300">
                    {finding.title}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-2 font-mono text-[9px] text-zinc-500">
                    <span>{finding.profile}</span>
                    <span>{finding.scoring_json?.base_score == null ? "未评分" : `${String(finding.scoring_json.standard)} ${String(finding.scoring_json.version)} · ${String(finding.scoring_json.base_score)} · ${String(finding.scoring_json.exploitability_label ?? "难度未知")}`}</span>
                  </div>
                  {finding.summary && <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-zinc-600">{finding.summary}</p>}
                  <div className="mt-3 flex items-center gap-2 border-t border-white/[.045] pt-3 text-[9px] text-zinc-600">
                    <span className="truncate">{finding.project_name}</span><span>·</span>
                    <span className="truncate font-mono">{finding.location || "无位置"}</span>
                    <div className="ml-auto shrink-0"><FindingStateBadges finding={finding} /></div>
                  </div>
                </div>
              </article>
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
