import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type FindingSummary } from "../api";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  PageSkeleton,
  SeverityBadge,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
  trHover,
} from "../ui";

const SEVERITIES = [
  { value: "critical", label: "critical" },
  { value: "high", label: "high" },
  { value: "medium", label: "medium" },
  { value: "low", label: "low" },
];

const VERIFY = [
  { value: "pending", label: "pending" },
  { value: "verifying", label: "verifying" },
  { value: "confirmed", label: "confirmed" },
  { value: "false_positive", label: "false_positive" },
  { value: "needs_human", label: "needs_human" },
];

/** 全局或项目级发现清单 */
export function FindingsPage({ scope }: { scope: "global" | "project" }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const severity = searchParams.get("severity") ?? "";
  const verify = searchParams.get("verify") ?? "";

  const [rows, setRows] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .findings({
          project_id: scope === "project" ? projectId : undefined,
          severity: severity || undefined,
          verify_status: verify || undefined,
        })
        .then((list) => {
          if (!stop) {
            setRows(list);
            setError(null);
            setLoading(false);
          }
        })
        .catch((e) => {
          if (!stop) { setError(String(e)); setLoading(false); }
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [scope, projectId, severity, verify]);

  const setFilter = (key: "severity" | "verify", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const linkTo = (f: FindingSummary) => {
    if (f.canvas_id) return `/projects/${f.project_id}/tasks/${f.canvas_id}`;
    return `/projects/${f.project_id}/findings`;
  };

  if (loading) return <PageSkeleton rows={5} />;
  return (
    <div className="page-scroll">
      <PageHeader
        title={scope === "global" ? "发现" : "项目发现"}
        eyebrow="EVIDENCE REGISTER"
        subtitle="发现不是结论，而是等待验证的风险假设。打开对应任务可以查看来源、验证路径与最终报告。"
        actions={
          <>
            <FilterSelect
              value={severity}
              onChange={(v) => setFilter("severity", v)}
              placeholder="全部 severity"
              label="SEVERITY"
              options={SEVERITIES}
            />
            <FilterSelect
              value={verify}
              onChange={(v) => setFilter("verify", v)}
              placeholder="全部验证状态"
              label="VERIFY"
              options={VERIFY}
            />
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="暂无发现" hint="审计产出 finding 后会汇总到这里" />
      ) : (
        <>
        <div className="grid gap-3 md:hidden">
          {rows.map((finding) => <Link key={finding.id} to={linkTo(finding)} className="surface-shell group"><article className="surface-core p-4"><div className="flex items-center justify-between gap-3"><SeverityBadge severity={finding.severity} /><span className="font-mono text-[8px] text-zinc-700">{relativeTime(finding.created_at)}</span></div><h2 className="mt-4 text-[14px] font-medium leading-6 text-zinc-100">{finding.title}</h2>{finding.summary && <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-zinc-600">{finding.summary}</p>}<div className="mt-4 flex items-center gap-2 border-t border-white/[.045] pt-3 text-[9px] text-zinc-600"><span className="truncate">{finding.project_name}</span><span>·</span><span className="truncate font-mono">{finding.location || "无位置"}</span><span className="ml-auto font-mono text-zinc-500">{finding.verify_status}</span></div></article></Link>)}
        </div>
        <div className="hidden md:block"><DataTable>
          <table className="w-full min-w-[880px]">
            <thead>
              <tr>
                <th className={thCls}>Severity</th>
                <th className={thCls}>标题</th>
                {scope === "global" && <th className={thCls}>项目</th>}
                <th className={thCls}>位置</th>
                <th className={thCls}>验证</th>
                <th className={thCls}>时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className={trHover}>
                  <td className={tdCls}>
                    <SeverityBadge severity={f.severity} />
                  </td>
                  <td className={tdCls}>
                    <Link to={linkTo(f)} className="font-medium text-zinc-100 hover:text-acc-400">
                      {f.title}
                    </Link>
                    {f.summary && (
                      <div className="mt-0.5 line-clamp-1 text-[13px] text-zinc-600">{f.summary}</div>
                    )}
                  </td>
                  {scope === "global" && (
                    <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                      <Link
                        to={`/projects/${f.project_id}/findings`}
                        className="hover:text-acc-400"
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
              ))}
            </tbody>
          </table>
        </DataTable></div>
        </>
      )}
    </div>
  );
}
