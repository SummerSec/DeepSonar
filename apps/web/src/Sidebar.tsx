import { X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type CanvasNode, type JobDetail } from "./api";
import { LiveStream } from "./LiveStream";
import { SEVERITY_COLOR, STATUS_COLOR } from "./nodes";

const EVENT_COLOR: Record<string, string> = {
  progress: "#38bdf8",
  finding: "#f97316",
  done: "#34d399",
  human: "#fbbf24",
  error: "#f87171",
};

function StatusDot({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? "#71717a";
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-1.5 rounded-full" style={{ background: c }} />
      <span className="font-mono text-[13px]" style={{ color: c }}>{status}</span>
    </span>
  );
}

function Field({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="py-1.5">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">{k}</div>
      <div
        className={`mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-300 ${mono ? "font-mono" : ""}`}
      >
        {v}
      </div>
    </div>
  );
}

type Tab = "overview" | "stream" | "events";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "stream", label: "实时流" },
  { key: "events", label: "事件" },
];

/** 节点详情侧栏：概览 / 实时流（WS）/ 事件时间线 */
export function Sidebar({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  // running 的 job 节点默认落到实时流 tab，其余落概览
  const [tab, setTab] = useState<Tab>(
    node.job_id && node.status === "running" ? "stream" : "overview",
  );

  useEffect(() => {
    setJob(null);
    setTab(node.job_id && node.status === "running" ? "stream" : "overview");
    if (node.job_id) {
      api.job(node.job_id).then(setJob).catch(() => {});
    }
  }, [node.id, node.job_id, node.status]);

  const bodyEntries = Object.entries(node.body_json ?? {}).filter(
    ([k]) => !["last_progress", "severity"].includes(k),
  );

  return (
    <aside className="dfh-sidebar absolute inset-y-0 right-0 z-20 flex w-[420px] flex-col border-l border-ink-700 bg-ink-900/95 backdrop-blur">
      {/* 头部 */}
      <div className="flex items-start gap-3 border-b border-ink-800 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
              {node.node_type}
            </span>
            {node.status && <StatusDot status={node.status} />}
          </div>
          <h2 className="mt-1 break-words text-[16px] font-semibold leading-snug text-zinc-100">
            {node.title}
          </h2>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-ink-800 hover:text-zinc-200"
        >
          <X size={16} />
        </button>
      </div>

      {/* tab 栏（实时流只对 job 节点有意义） */}
      <div className="flex gap-1 border-b border-ink-800 px-3 py-1.5">
        {TABS.filter((t) => t.key !== "stream" || node.job_id).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-2.5 py-1 text-[14px] transition-colors ${
              tab === t.key
                ? "bg-ink-800 text-zinc-100"
                : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 实时流：常驻挂载，切 tab 不断连，只隐藏 */}
      {node.job_id && (
        <div className={`flex-1 overflow-hidden ${tab === "stream" ? "" : "hidden"}`}>
          <LiveStream jobId={node.job_id} active={tab === "stream"} />
        </div>
      )}

      {/* 概览 / 事件 */}
      {tab !== "stream" && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {tab === "overview" && (
            <>
              {Boolean(node.body_json?.severity) && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
                  <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">severity</span>
                  <span
                    className="ml-auto font-mono text-[14px] font-medium uppercase"
                    style={{ color: SEVERITY_COLOR[String(node.body_json.severity)] ?? "#71717a" }}
                  >
                    {String(node.body_json.severity)}
                  </span>
                </div>
              )}
              <div className="divide-y divide-ink-800/70">
                {bodyEntries.map(([k, v]) => (
                  <Field key={k} k={k} v={typeof v === "string" ? v : JSON.stringify(v, null, 2)} />
                ))}
              </div>
              {job && (
                <div className="mt-3 divide-y divide-ink-800/70 border-t border-ink-800 pt-1">
                  {job.job.started_at && <Field k="started" v={new Date(job.job.started_at).toLocaleString()} />}
                  {job.job.finished_at && <Field k="finished" v={new Date(job.job.finished_at).toLocaleString()} />}
                </div>
              )}
              {job?.job.error && (
                <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 font-mono text-[13px] leading-relaxed text-red-300">
                  {job.job.error}
                </div>
              )}
            </>
          )}

          {tab === "events" &&
            (job && job.events.length > 0 ? (
              <ol className="relative ml-1 border-l border-ink-700 pl-4">
                {job.events.map((e) => (
                  <li key={e.id} className="relative pb-3 last:pb-0">
                    <span
                      className="absolute -left-[21px] top-1.5 inline-block size-2 rounded-full border border-ink-950"
                      style={{ background: EVENT_COLOR[e.type] ?? "#71717a" }}
                    />
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] text-zinc-600">#{e.job_seq}</span>
                      <span
                        className="font-mono text-[13px] font-medium"
                        style={{ color: EVENT_COLOR[e.type] ?? "#a1a1aa" }}
                      >
                        {e.type}
                      </span>
                    </div>
                    <div className="mt-0.5 break-words text-[14px] leading-relaxed text-zinc-400">
                      {summarize(e.payload_json)}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="py-8 text-center font-mono text-[13px] text-zinc-600">
                {node.job_id ? "加载事件中…" : "该节点无关联 job 事件"}
              </div>
            ))}
        </div>
      )}
    </aside>
  );
}

function summarize(p: Record<string, unknown>): string {
  const s = (p.message as string) ?? (p.title as string) ?? (p.summary as string) ?? JSON.stringify(p);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}
