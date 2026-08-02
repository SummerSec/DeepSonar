import { Prohibit, SealCheck, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type CanvasNode, type JobDetail } from "./api";
import { LiveStream } from "./LiveStream";
import { MarkdownView } from "./MarkdownView";
import { SEVERITY_COLOR, STATUS_COLOR, VERIFICATION_META } from "./semantics";

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

function Field({ k, v, markdown = true }: { k: string; v: string; markdown?: boolean }) {
  return (
    <div className="py-1.5">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">{k}</div>
      <div className="mt-1 break-words text-[14px] leading-relaxed text-zinc-300">
        {markdown ? <MarkdownView markdown={v} /> : <span className="font-mono">{v}</span>}
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
  const [verifyBusy, setVerifyBusy] = useState(false);
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

  // 正文优先字段（fact.description / finding.summary 等）置顶；其余 body 字段跟后
  const PRIMARY_BODY_KEYS = ["description", "summary", "reason", "content"] as const;
  const body = node.body_json ?? {};
  const primaryEntries = PRIMARY_BODY_KEYS
    .filter((k) => body[k] != null && String(body[k]).trim() !== "")
    .map((k) => [k, body[k]] as const);
  const bodyEntries = Object.entries(body).filter(
    ([k]) => !["last_progress", "severity", ...PRIMARY_BODY_KEYS].includes(k),
  );
  const runtimeImage = (job?.job.agent_snapshot_json?.runtime_image ?? null) as Record<string, unknown> | null;
  const runtimeEvidence = (job?.job.payload_json?.runtime_evidence ?? null) as Record<string, unknown> | null;

  // fact 节点验证状态（needs_human 时提供人工确认 / 明确排除）
  const verification =
    node.node_type === "fact" && node.verification_status
      ? (VERIFICATION_META[node.verification_status] ?? {
          label: node.verification_status,
          color: "#71717a",
        })
      : null;

  /** 人工处理事实：确认 / 排除后关闭侧栏（画布轮询会反映新状态并推进报告） */
  const setVerification = async (status: "verified" | "rejected") => {
    setVerifyBusy(true);
    try {
      await api.setFactVerification(node.id, status);
      onClose();
    } catch {
      // 失败由画布轮询呈现
    } finally {
      setVerifyBusy(false);
    }
  };

  return (
    <aside className="theme-drawer deepsonar-sidebar absolute inset-y-2 right-2 z-20 flex w-[420px] flex-col overflow-hidden rounded-[22px] ring-1 ring-[var(--line-strong)]">
      {/* 头部 */}
      <div className="flex items-start gap-3 border-b border-white/[.05] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
              {node.node_type}
            </span>
            {node.status && <StatusDot status={node.status} />}
            {verification && (
              <span
                className="rounded border px-1 font-mono text-[11px]"
                style={{ color: verification.color, borderColor: `${verification.color}66` }}
              >
                {verification.label}
              </span>
            )}
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
      <div className="flex gap-1 border-b border-white/[.05] px-4 py-2">
        {TABS.filter((t) => t.key !== "stream" || node.job_id).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1.5 text-[11px] transition-colors ${
              tab === t.key
                ? "bg-white/[.08] text-zinc-100"
                : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
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
              {/* 待人工处理事实：人工确认 / 明确排除（§5.2-6；处理后调度器会尝试推进报告） */}
              {node.node_type === "fact" && node.verification_status === "needs_human" && (
                <div className="mb-3 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2.5">
                  <div className="text-[13px] leading-relaxed text-amber-200/90">
                    该事实无法自动裁决，需要人工确认或明确排除。
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => setVerification("verified")}
                      disabled={verifyBusy}
                      className="flex items-center gap-1 rounded-md border border-emerald-900/60 px-2.5 py-1 font-mono text-[12px] text-emerald-300 transition-colors hover:bg-emerald-950/40 disabled:opacity-50"
                    >
                      <SealCheck size={12} /> 标记已验证
                    </button>
                    <button
                      onClick={() => setVerification("rejected")}
                      disabled={verifyBusy}
                      className="flex items-center gap-1 rounded-md border border-red-900/60 px-2.5 py-1 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-50"
                    >
                      <Prohibit size={12} /> 排除
                    </button>
                  </div>
                </div>
              )}
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
              {/* 正文优先：fact.description / finding.summary 等 */}
              {primaryEntries.length > 0 && (
                <div className="mb-3 divide-y divide-ink-800/70 rounded-lg border border-ink-800/80 bg-ink-900/40 px-3">
                  {primaryEntries.map(([k, v]) => (
                    <Field key={k} k={k} v={typeof v === "string" ? v : JSON.stringify(v, null, 2)} />
                  ))}
                </div>
              )}
              <div className="divide-y divide-ink-800/70">
                {bodyEntries.map(([k, v]) => (
                  <Field key={k} k={k} v={typeof v === "string" ? v : JSON.stringify(v, null, 2)} />
                ))}
              </div>
              {primaryEntries.length === 0 && bodyEntries.length === 0 && (
                <div className="py-6 text-center font-mono text-[13px] text-zinc-600">
                  该节点暂无正文内容
                </div>
              )}
              {job && (
                <div className="mt-3 divide-y divide-ink-800/70 border-t border-ink-800 pt-1">
                  {runtimeImage && <Field k="runtime image" v={String(runtimeImage.image_key ?? runtimeImage.image_ref ?? "unknown")} markdown={false} />}
                  {Boolean(runtimeImage?.image_digest) && <Field k="image digest" v={String(runtimeImage?.image_digest)} markdown={false} />}
                  {Boolean(runtimeImage?.tools_manifest_sha256) && <Field k="tools manifest" v={String(runtimeImage?.tools_manifest_sha256)} markdown={false} />}
                  {Boolean(runtimeEvidence?.admission_scan_id) && <Field k="admission scan" v={String(runtimeEvidence?.admission_scan_id)} markdown={false} />}
                  {job.job.started_at && <Field k="started" v={new Date(job.job.started_at).toLocaleString()} markdown={false} />}
                  {job.job.finished_at && <Field k="finished" v={new Date(job.job.finished_at).toLocaleString()} markdown={false} />}
                </div>
              )}
              {job?.job.error && (
                <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300"><MarkdownView markdown={job.job.error} /></div>
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
                    <MarkdownView markdown={summarize(e.payload_json)} controls={false} className="mt-0.5 text-zinc-400" />
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
