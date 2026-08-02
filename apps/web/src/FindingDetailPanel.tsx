import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FindingDetail } from "./api";
import { SeverityBadge, StatusBadge, formatTime } from "./ui";

export function FindingDetailPanel({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api.finding(findingId).then((value) => alive && setDetail(value)).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [findingId]);

  const f = detail?.finding;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="发现详情" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-[760px] overflow-y-auto border-l border-white/[.08] bg-[#0b0f12] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/[.06] bg-[#0b0f12]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-zinc-600">Finding evidence</div>
            <div className="mt-1 truncate text-[15px] font-medium text-zinc-100">{f?.title ?? "加载发现详情…"}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭发现详情" className="flex size-9 items-center justify-center rounded-full text-zinc-500 ring-1 ring-white/[.08] hover:bg-white/[.05] hover:text-white"><X size={16} /></button>
        </header>

        {error && <div className="m-5 rounded-xl bg-red-950/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-400/20">{error}</div>}
        {!error && !f && <div className="p-8 font-mono text-sm text-zinc-600">正在读取完整证据…</div>}
        {f && detail && (
          <div className="space-y-5 p-5">
            <section className="rounded-2xl bg-white/[.025] p-5 ring-1 ring-white/[.06]">
              <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} /><StatusBadge status={f.verify_status} /><span className="ml-auto font-mono text-[10px] text-zinc-600">{formatTime(f.created_at)}</span></div>
              <h2 className="mt-4 text-xl font-medium leading-8 text-zinc-100">{f.title}</h2>
              {f.summary && <p className="mt-3 whitespace-pre-wrap text-[14px] leading-7 text-zinc-400">{f.summary}</p>}
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              {[
                ["项目", f.project_name ?? f.project_id],
                ["代码位置", f.location || "未提供"],
                ["指纹", f.fingerprint],
                ["来源运行", `${f.source_job_type} · ${f.source_job_status}`],
              ].map(([label, value]) => <div key={label} className="rounded-2xl bg-white/[.02] p-4 ring-1 ring-white/[.05]"><div className="font-mono text-[9px] uppercase tracking-[.16em] text-zinc-600">{label}</div><div className="mt-2 break-all font-mono text-[12px] leading-5 text-zinc-300">{value}</div></div>)}
            </section>

            {f.canvas_id && <Link to={`/projects/${f.project_id}/tasks/${f.canvas_id}?tab=jobs&job=${f.job_id}`} className="inline-flex items-center gap-2 rounded-full bg-acc-500/[.08] px-4 py-2 text-[12px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.14]">查看来源执行过程 <ArrowSquareOut size={14} /></Link>}

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">验证运行 ({detail.verification_jobs.length})</h3>
              {detail.verification_jobs.length ? <div className="space-y-2">{detail.verification_jobs.map((job) => <div key={job.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/[.02] px-4 py-3 ring-1 ring-white/[.05]"><StatusBadge status={job.status} /><span className="font-mono text-[11px] text-zinc-400">{job.type}</span><span className="ml-auto font-mono text-[10px] text-zinc-600">{formatTime(job.started_at ?? job.created_at)}</span>{job.error && <div className="w-full font-mono text-[11px] text-red-300">{job.error}</div>}</div>)}</div> : <p className="text-[12px] text-zinc-600">尚未派生验证运行。</p>}
            </section>

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">原始 Finding JSON</h3>
              <pre className="max-h-[420px] overflow-auto rounded-2xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-zinc-400 ring-1 ring-white/[.06]">{JSON.stringify(f.raw_json, null, 2)}</pre>
            </section>

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">来源语义事件 ({detail.source_events.length})</h3>
              <pre className="max-h-[420px] overflow-auto rounded-2xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-zinc-500 ring-1 ring-white/[.06]">{detail.source_events.map((event) => JSON.stringify(event)).join("\n")}</pre>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
