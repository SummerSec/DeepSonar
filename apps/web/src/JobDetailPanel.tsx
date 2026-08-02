import { DownloadSimple, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type JobDetail, type JobEvidence } from "./api";
import { LiveStream } from "./LiveStream";
import { MarkdownView } from "./MarkdownView";
import { SeverityBadge, StatusBadge, formatTime } from "./ui";

type DetailTab = "process" | "events" | "session" | "findings";
const ACTIVE = new Set(["claimed", "provisioning", "running", "waiting_human"]);

function recordsAsMarkdown(records: Array<Record<string, unknown>>): string {
  return records.map((record) => {
    const payload = record.payload_json && typeof record.payload_json === "object"
      ? record.payload_json as Record<string, unknown>
      : record;
    const text = [payload.message, payload.text, payload.delta, payload.summary, payload.title]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const type = String(record.type ?? payload.type ?? "event");
    return `### ${type}\n\n${text ?? `\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``}`;
  }).join("\n\n---\n\n");
}

export function JobDetailPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [evidence, setEvidence] = useState<JobEvidence | null>(null);
  const [stream, setStream] = useState<Array<Record<string, unknown>>>([]);
  const [session, setSession] = useState<{ text: string; truncated: boolean } | null>(null);
  const [tab, setTab] = useState<DetailTab>("process");
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null); setEvidence(null); setStream([]); setSession(null); setError(null); setDownloadError(null); setTab("process");
    api.job(jobId).then((v) => alive && setDetail(v)).catch((e) => alive && setError(String(e)));
    api.jobEvidence(jobId).then((v) => alive && setEvidence(v)).catch(() => {});
    api.jobStream(jobId).then((v) => alive && setStream(v.events)).catch(() => {});
    api.jobSession(jobId).then((v) => alive && setSession({ text: v.text, truncated: v.truncated })).catch(() => {});
    return () => { alive = false; };
  }, [jobId]);

  const active = detail ? ACTIVE.has(detail.job.status) : false;
  const tabs: Array<[DetailTab, string, number | null]> = [
    ["process", "执行过程", stream.length],
    ["events", "语义事件", detail?.events.length ?? null],
    ["session", "原始 Session", evidence?.manifest.files.filter((f) => f.kind === "main" || f.kind === "subagent").length ?? null],
    ["findings", "产出发现", detail?.findings.length ?? null],
  ];

  return (
    <div className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="运行详情" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="theme-drawer flex h-full w-full max-w-[900px] flex-col border-l">
        <header className="theme-drawer-header theme-divider flex shrink-0 items-center gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1"><div className="font-mono text-[10px] uppercase tracking-[.18em] text-zinc-600">Execution detail</div><div className="mt-1 flex items-center gap-2"><span className="font-mono text-[13px] text-zinc-200">{detail?.job.type ?? "加载运行…"}</span>{detail && <StatusBadge status={detail.job.status} />}</div></div>
          <button type="button" onClick={onClose} aria-label="关闭运行详情" className="theme-surface flex size-9 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90"><X size={16} /></button>
        </header>

        {detail && <div className="theme-divider grid shrink-0 grid-cols-2 gap-px border-b bg-[var(--line)] sm:grid-cols-4">{[["JOB ID", jobId], ["开始", formatTime(detail.job.started_at)], ["结束", formatTime(detail.job.finished_at)], ["证据", evidence ? `${evidence.manifest.files.length} files` : active ? "采集中" : "无归档"]].map(([k, v]) => <div key={k} className="theme-drawer min-w-0 px-4 py-3"><div className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{k}</div><div className="mt-1 truncate font-mono text-[10px] text-zinc-400" title={v}>{v}</div></div>)}</div>}

        <nav className="theme-divider flex shrink-0 gap-1 overflow-x-auto border-b p-2">{tabs.map(([key, label, count]) => <button key={key} type="button" onClick={() => setTab(key)} className={`rounded-full px-3 py-2 text-[11px] ${tab === key ? "theme-chip" : "text-zinc-600 hover:opacity-80"}`}>{label}{count !== null ? <span className="ml-1.5 font-mono text-[9px] text-zinc-600">{count}</span> : null}</button>)}</nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="m-5 rounded-xl bg-red-950/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-400/20">{error}</div>}
          {!error && !detail && <div className="p-8 font-mono text-sm text-zinc-600">正在读取运行账本…</div>}
          {detail?.job.error && <div className="m-4 rounded-xl bg-red-950/20 px-4 py-3 text-red-300 ring-1 ring-red-400/15"><MarkdownView markdown={detail.job.error} /></div>}

          {detail && tab === "process" && <div className="h-full min-h-[420px]">{active ? <LiveStream jobId={jobId} active /> : stream.length ? <div className="theme-surface m-4 rounded-2xl p-4 ring-1"><MarkdownView markdown={recordsAsMarkdown(stream)} /></div> : <div className="p-8 text-center text-[13px] text-zinc-600">此运行没有持久化过程流。旧运行在本功能上线前只保存在内存中，无法追溯。</div>}</div>}

          {detail && tab === "events" && <div className="theme-surface m-4 rounded-2xl p-4 ring-1"><MarkdownView markdown={detail.events.length ? recordsAsMarkdown(detail.events as unknown as Array<Record<string, unknown>>) : "没有语义事件"} /></div>}

          {detail && tab === "session" && <div className="p-4"><div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-[12px] text-zinc-500">{evidence ? `${evidence.manifest.cli} · session ${evidence.manifest.session_id ?? "unknown"}` : active ? "Session 将在运行终态前归档" : "没有 Session 归档"}</span>{evidence && session && <button type="button" onClick={() => api.downloadJobSession(jobId).catch((e) => setDownloadError(String(e)))} className="theme-surface ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] text-zinc-300 ring-1 hover:opacity-90"><DownloadSimple size={13} /> 下载原始文件</button>}</div>{downloadError && <p className="mb-3 text-[11px] text-red-300">{downloadError}</p>}{session ? <><pre className="theme-input-surface max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-2xl border p-4 font-mono text-[11px] leading-5 text-zinc-400">{session.text}</pre>{session.truncated && <p className="mt-2 text-[10px] text-amber-300">页面预览已截断，请下载完整原始文件。</p>}</> : <div className="theme-surface rounded-2xl p-8 text-center text-[13px] text-zinc-600 ring-1">该 CLI 未生成可归档的独立 Session，或此运行发生在归档功能上线前。</div>}</div>}

          {detail && tab === "findings" && <div className="space-y-2 p-4">{detail.findings.length ? detail.findings.map((f) => <div key={f.id} className="theme-surface flex items-center gap-3 rounded-xl px-4 py-3 ring-1"><SeverityBadge severity={f.severity} /><span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{f.title}</span><StatusBadge status={f.verify_status} /></div>) : <div className="p-8 text-center text-[13px] text-zinc-600">该运行没有产出 Finding。</div>}</div>}
        </div>
      </aside>
    </div>
  );
}
