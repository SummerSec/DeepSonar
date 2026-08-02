import { DownloadSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type JobDetail, type JobEvidence, type JobEvent } from "./api";
import { LiveStream, ProcessStreamView, recordsToStreamBlocks } from "./LiveStream";
import { MarkdownView } from "./MarkdownView";
import { SEVERITY_COLOR, STATUS_COLOR } from "./semantics";
import { SeverityBadge, StatusBadge, formatTime } from "./ui";

/**
 * 运行详情（画布节点 / 运行列表共用）：
 * - 执行过程：持久化过程流（可筛选）
 * - 实时流：WS 原始流（运行中）
 * - 事件：调度器 events 表语义事件（可筛选）
 * - 原始 Session / 产出发现：与调度器证据/finding 接口一致
 */
type DetailTab = "process" | "live" | "events" | "session" | "findings";
const ACTIVE = new Set(["claimed", "provisioning", "running", "waiting_human"]);

const EVENT_COLOR: Record<string, string> = {
  progress: "#38bdf8",
  finding: "#f97316",
  done: "#34d399",
  human: "#fbbf24",
  error: "#f87171",
};

function summarizePayload(p: Record<string, unknown>): string {
  const s =
    (p.message as string) ??
    (p.title as string) ??
    (p.summary as string) ??
    (p.text as string) ??
    JSON.stringify(p);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

export function JobDetailPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [evidence, setEvidence] = useState<JobEvidence | null>(null);
  const [stream, setStream] = useState<Array<Record<string, unknown>>>([]);
  const [session, setSession] = useState<{ text: string; truncated: boolean } | null>(null);
  const [tab, setTab] = useState<DetailTab>("process");
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [eventQuery, setEventQuery] = useState("");

  // 初次加载 + 运行中轮询：与调度器账本保持同步
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setEvidence(null);
    setStream([]);
    setSession(null);
    setError(null);
    setDownloadError(null);
    setEventTypeFilter("");
    setEventQuery("");

    const loadCore = () =>
      api
        .job(jobId)
        .then((v) => {
          if (!alive) return;
          setDetail(v);
          setError(null);
          // 运行中默认实时流，已结束默认执行过程（与调度器账本一致）
          setTab(ACTIVE.has(v.job.status) ? "live" : "process");
        })
        .catch((e) => alive && setError(String(e)));

    const loadEvidenceBundle = () => {
      api.jobEvidence(jobId).then((v) => alive && setEvidence(v)).catch(() => {});
      api.jobStream(jobId).then((v) => alive && setStream(v.events)).catch(() => {});
      api
        .jobSession(jobId)
        .then((v) => alive && setSession({ text: v.text, truncated: v.truncated }))
        .catch(() => {});
    };

    loadCore().then(() => {
      if (!alive) return;
      loadEvidenceBundle();
    });

    const poll = setInterval(() => {
      if (!alive) return;
      api
        .job(jobId)
        .then((v) => {
          if (!alive) return;
          setDetail(v);
          if (ACTIVE.has(v.job.status)) {
            // 运行中：过程流持续刷新（事件随 job 详情一起更新）
            api.jobStream(jobId).then((s) => alive && setStream(s.events)).catch(() => {});
          }
        })
        .catch(() => {});
    }, 4000);

    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [jobId]);

  const active = detail ? ACTIVE.has(detail.job.status) : false;
  const archivedBlocks = useMemo(() => recordsToStreamBlocks(stream), [stream]);

  const eventTypes = useMemo(() => {
    if (!detail) return [] as string[];
    return Array.from(new Set(detail.events.map((e) => e.type).filter(Boolean))).sort();
  }, [detail]);

  const filteredEvents = useMemo(() => {
    if (!detail) return [] as JobEvent[];
    const needle = eventQuery.trim().toLowerCase();
    return detail.events.filter((e) => {
      if (eventTypeFilter && e.type !== eventTypeFilter) return false;
      if (!needle) return true;
      const blob = `${e.type} ${JSON.stringify(e.payload_json ?? {})}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [detail, eventQuery, eventTypeFilter]);

  const tabs: Array<[DetailTab, string, number | null, boolean]> = [
    ["process", "执行过程", stream.length, true],
    ["live", "实时流", null, true],
    ["events", "事件", detail?.events.length ?? null, true],
    [
      "session",
      "原始 Session",
      evidence?.manifest.files.filter((f) => f.kind === "main" || f.kind === "subagent").length ?? null,
      true,
    ],
    ["findings", "产出发现", detail?.findings.length ?? null, true],
  ];

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="运行详情"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="theme-drawer flex h-full w-full max-w-[900px] flex-col border-l">
        <header className="theme-drawer-header theme-divider flex shrink-0 items-center gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-zinc-600">
              Execution detail
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] text-zinc-200">
                {detail?.job.type ?? "加载运行…"}
              </span>
              {detail && <StatusBadge status={detail.job.status} />}
              {active && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-acc-500/10 px-2 py-0.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20">
                  <span className="deepsonar-live-dot inline-block size-1.5 rounded-full bg-acc-400" />
                  运行中
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭运行详情"
            className="theme-surface flex size-9 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90"
          >
            <X size={16} />
          </button>
        </header>

        {detail && (
          <div className="theme-divider grid shrink-0 grid-cols-2 gap-px border-b bg-[var(--line)] sm:grid-cols-4">
            {(
              [
                ["JOB ID", jobId],
                ["开始", formatTime(detail.job.started_at)],
                ["结束", formatTime(detail.job.finished_at)],
                [
                  "证据",
                  evidence
                    ? `${evidence.manifest.files.length} files`
                    : active
                      ? "采集中"
                      : "无归档",
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="theme-drawer min-w-0 px-4 py-3">
                <div className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{k}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-zinc-400" title={v}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        )}

        <nav className="theme-divider flex shrink-0 gap-1 overflow-x-auto border-b p-2">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-full px-3 py-2 text-[11px] ${
                tab === key ? "theme-chip" : "text-zinc-600 hover:opacity-80"
              }`}
            >
              {label}
              {key === "live" && active && (
                <span className="ml-1.5 inline-block size-1.5 rounded-full bg-acc-400 deepsonar-live-dot" />
              )}
              {count !== null ? (
                <span className="ml-1.5 font-mono text-[9px] text-zinc-600">{count}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-hidden">
          {error && (
            <div className="m-5 rounded-xl bg-red-950/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-400/20">
              {error}
            </div>
          )}
          {!error && !detail && (
            <div className="p-8 font-mono text-sm text-zinc-600">正在读取运行账本…</div>
          )}
          {detail?.job.error && (
            <div className="m-4 rounded-xl bg-red-950/20 px-4 py-3 text-red-300 ring-1 ring-red-400/15">
              <MarkdownView markdown={detail.job.error} />
            </div>
          )}

          {/* 执行过程：调度器持久化 stream（NDJSON），可筛选；与是否运行中无关 */}
          {detail && tab === "process" && (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {stream.length ? (
                <ProcessStreamView
                  blocks={archivedBlocks}
                  emptyHint="此运行没有可解析的过程流。"
                />
              ) : (
                <div className="p-8 text-center text-[13px] text-zinc-600">
                  {active
                    ? "过程流尚未落盘，可先看「实时流」；终态后会归档到此。"
                    : "此运行没有持久化过程流。旧运行在本功能上线前只保存在内存中，无法追溯。"}
                </div>
              )}
            </div>
          )}

          {/* 实时流：WS 原始流（仅运行中有意义） */}
          {detail && tab === "live" && (
            <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
              {active ? (
                <LiveStream jobId={jobId} active />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-[13px] text-zinc-500">运行已结束，实时流已关闭。</p>
                  <button
                    type="button"
                    onClick={() => setTab("process")}
                    className="rounded-full px-3 py-1.5 font-mono text-[11px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08]"
                  >
                    查看执行过程
                  </button>
                  {stream.length > 0 && (
                    <p className="font-mono text-[10px] text-zinc-600">
                      已归档 {stream.length} 条过程记录
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 事件：调度器 events 表（emit_progress / finding / done…） */}
          {detail && tab === "events" && (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[.06] px-3 py-2">
                <select
                  aria-label="事件类型筛选"
                  value={eventTypeFilter}
                  onChange={(e) => setEventTypeFilter(e.target.value)}
                  className="min-h-8 rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 ring-1 ring-white/[.08]"
                >
                  <option value="">全部类型</option>
                  {eventTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="搜索事件"
                  value={eventQuery}
                  onChange={(e) => setEventQuery(e.target.value)}
                  placeholder="搜索事件内容…"
                  className="min-h-8 min-w-[8rem] flex-1 rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 ring-1 ring-white/[.08] placeholder:text-zinc-700"
                />
                <span className="font-mono text-[10px] text-zinc-600">
                  {filteredEvents.length}/{detail.events.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {filteredEvents.length === 0 ? (
                  <div className="py-8 text-center text-[13px] text-zinc-600">
                    {detail.events.length ? "没有匹配当前筛选的事件" : "没有语义事件"}
                  </div>
                ) : (
                  <ol className="relative ml-1 border-l border-ink-700 pl-4">
                    {filteredEvents.map((e) => (
                      <li key={e.id} className="relative pb-3 last:pb-0">
                        <span
                          className="absolute -left-[21px] top-1.5 inline-block size-2 rounded-full border border-ink-950"
                          style={{ background: EVENT_COLOR[e.type] ?? STATUS_COLOR[e.type] ?? "#71717a" }}
                        />
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-[11px] text-zinc-600">#{e.job_seq}</span>
                          <span
                            className="font-mono text-[12px] font-medium"
                            style={{ color: EVENT_COLOR[e.type] ?? "#a1a1aa" }}
                          >
                            {e.type}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-700">
                            {formatTime(e.created_at)}
                          </span>
                        </div>
                        <MarkdownView
                          markdown={summarizePayload(e.payload_json ?? {})}
                          controls={false}
                          className="mt-0.5 text-[13px] text-zinc-400"
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}

          {detail && tab === "session" && (
            <div className="h-full min-h-0 overflow-y-auto p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-zinc-500">
                  {evidence
                    ? `${evidence.manifest.cli} · session ${evidence.manifest.session_id ?? "unknown"}`
                    : active
                      ? "Session 将在运行终态前归档"
                      : "没有 Session 归档"}
                </span>
                {evidence && session && (
                  <button
                    type="button"
                    onClick={() =>
                      api.downloadJobSession(jobId).catch((e) => setDownloadError(String(e)))
                    }
                    className="theme-surface ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] text-zinc-300 ring-1 hover:opacity-90"
                  >
                    <DownloadSimple size={13} /> 下载原始文件
                  </button>
                )}
              </div>
              {downloadError && <p className="mb-3 text-[11px] text-red-300">{downloadError}</p>}
              {session ? (
                <>
                  <pre className="theme-input-surface max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-2xl border p-4 font-mono text-[11px] leading-5 text-zinc-400">
                    {session.text}
                  </pre>
                  {session.truncated && (
                    <p className="mt-2 text-[10px] text-amber-300">
                      页面预览已截断，请下载完整原始文件。
                    </p>
                  )}
                </>
              ) : (
                <div className="theme-surface rounded-2xl p-8 text-center text-[13px] text-zinc-600 ring-1">
                  该 CLI 未生成可归档的独立 Session，或此运行发生在归档功能上线前。
                </div>
              )}
            </div>
          )}

          {detail && tab === "findings" && (
            <div className="h-full min-h-0 space-y-2 overflow-y-auto p-4">
              {detail.findings.length ? (
                detail.findings.map((f) => (
                  <div
                    key={f.id}
                    className="theme-surface flex items-center gap-3 rounded-xl px-4 py-3 ring-1"
                  >
                    <SeverityBadge severity={f.severity} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{f.title}</span>
                    <span
                      className="shrink-0 font-mono text-[10px] uppercase"
                      style={{ color: SEVERITY_COLOR[f.severity] ?? undefined }}
                    >
                      {f.severity}
                    </span>
                    <StatusBadge status={f.verify_status} />
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-[13px] text-zinc-600">该运行没有产出 Finding。</div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
