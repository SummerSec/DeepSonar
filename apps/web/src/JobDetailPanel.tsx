import { ArrowClockwise, PaperPlaneTilt, Stop, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CanvasHumanMessage, type ContextDiagnostics, type JobDetail, type JobEvidence, type JobEvent, type JobSession, type ProviderCredential } from "./api";
import { LiveStream, StreamView, recordsToStreamBlocks } from "./LiveStream";
import { LiveTerminalWorkspace } from "./LiveTerminalWorkspace";
import { appendUniqueRows, mergeRefreshedPage } from "./canvas-page-sync";
import { useConfirmDialog } from "./components/ConfirmDialog";
import { MarkdownView } from "./MarkdownView";
import { SearchableMultiSelect } from "./SearchableSelect";
import { HumanMessageList } from "./HumanMessageList";
import { SEVERITY_COLOR, STATUS_COLOR } from "./semantics";
import { SessionViewer } from "./session-viewer/SessionViewer";
import { extractDispatchPrompt } from "./job-dispatch-prompt";
import { SeverityBadge, StatusBadge, formatTime } from "./ui";

/**
 * 运行详情（画布节点 / 运行列表共用）：
 * - 结果：下发 prompt + 运行摘要 + 产出（已结束默认）
 * - 实时流 / 事件 / Session（时间线/用量/统计/原始 + 下载）/ 产出发现 / 运行配置
 */
type DetailTab = "result" | "live" | "events" | "session" | "findings" | "config";
const ACTIVE = new Set(["claimed", "provisioning", "running", "waiting_human"]);
const RESUMABLE = new Set(["waiting_human", "orphan", "failed", "timeout"]);

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

function snapStr(snap: Record<string, unknown> | null | undefined, key: string): string {
  const v = snap?.[key];
  if (v == null || v === "") return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function snapRuntimeImageKey(snap: Record<string, unknown> | null | undefined): string {
  const runtimeImage = snap?.runtime_image;
  if (runtimeImage && typeof runtimeImage === "object" && !Array.isArray(runtimeImage)) {
    const key = (runtimeImage as Record<string, unknown>).image_key;
    if (typeof key === "string" && key.trim()) return key;
  }
  // Older snapshots may only carry the RoleConfig override field.
  return snapStr(snap, "runtime_image_key");
}

function ConfigField({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="theme-surface min-w-0 rounded-xl px-3 py-2.5 ring-1">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">{label}</div>
      <div className="mt-1 break-all font-mono text-[12px] text-zinc-200" title={title ?? value}>
        {value}
      </div>
    </div>
  );
}

function ContextDiagnosticsView({ diagnostics }: { diagnostics: ContextDiagnostics | null }) {
  if (!diagnostics) {
    return <p className="font-mono text-[12px] text-zinc-600">该运行尚未记录上下文生命周期摘要。</p>;
  }
  const observationLabel = diagnostics.compaction.observation === "observed"
    ? "已观测"
    : diagnostics.compaction.observation === "unsupported"
      ? "适配器不支持"
      : "未知";
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <ConfigField label="上下文 ID" value={diagnostics.context_id} />
        <ConfigField label="版本" value={String(diagnostics.context_revision)} />
        <ConfigField label="Attempt ID" value={diagnostics.attempt_id ?? "—"} />
        <ConfigField label="适配器" value={`${diagnostics.adapter_id} ${diagnostics.adapter_version}`} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ConfigField label="运行身份摘要" value={diagnostics.runtime_identity} />
        <ConfigField label="变换链摘要" value={diagnostics.transform_chain_digest} />
      </div>
      <div className="font-mono text-[11px] text-zinc-400">
        <span className="text-zinc-600">压缩观测：</span>{observationLabel}
        <span className="ml-3 text-zinc-600">策略：</span>{diagnostics.compaction.policy}
        {diagnostics.compaction.reason && <span className="ml-3 text-zinc-500">{diagnostics.compaction.reason}</span>}
      </div>
      <ol className="space-y-1.5 font-mono text-[10px] text-zinc-500">
        {diagnostics.transforms.map((transform) => (
          <li key={`${transform.revision}:${transform.stage}`} className="flex flex-wrap gap-x-2 gap-y-1 border-l border-white/[.08] pl-3">
            <span className="text-zinc-300">r{transform.revision} {transform.stage}</span>
            <span>{transform.source}</span>
            {transform.budget && <span>预算 {transform.budget.observed ?? "?"}/{transform.budget.limit} {transform.budget.unit}</span>}
            {transform.omission && <span className="text-amber-300">省略 {transform.omission.count ?? "?"}：{transform.omission.reason}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExecutionLedgerView({ detail }: { detail: JobDetail }) {
  const latestAttempt = detail.attempts[0] ?? null;
  const unknownEffects = detail.effects.filter((effect) => effect.status === "unknown" || effect.status === "effect_pending");
  const deliveryCounts = detail.broadcasts.reduce<Record<string, number>>((counts, delivery) => {
    counts[delivery.delivery_status] = (counts[delivery.delivery_status] ?? 0) + 1;
    return counts;
  }, {});
  const inputTokens = detail.usage.reduce((total, row) => total + Number(row.input_tokens || 0), 0);
  const outputTokens = detail.usage.reduce((total, row) => total + Number(row.output_tokens || 0), 0);
  const cacheReadTokens = detail.usage.reduce((total, row) => total + Number(row.cache_read_input_tokens || 0), 0);
  const cacheWriteTokens = detail.usage.reduce((total, row) => total + Number(row.cache_creation_input_tokens || 0), 0);
  const totalTokens = detail.usage.reduce((total, row) => total + Number(row.total_tokens || 0), 0);
  if (!latestAttempt && detail.effects.length === 0 && detail.broadcasts.length === 0 && detail.usage.length === 0) {
    return <p className="font-mono text-[12px] text-zinc-600">该运行尚未记录执行账本。</p>;
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <ConfigField
          label="最新 Attempt"
          value={latestAttempt ? `#${latestAttempt.attempt_no} · ${latestAttempt.status}` : "—"}
        />
        <ConfigField label="执行阶段" value={latestAttempt?.phase ?? "—"} />
        <ConfigField label="外部效果" value={`${detail.effects.length} · 未决 ${unknownEffects.length}`} />
        <ConfigField
          label="模型用量"
          value={detail.usage.length
            ? `${detail.usage.length} 次 · in ${inputTokens} / out ${outputTokens} / cache ${cacheReadTokens}/${cacheWriteTokens} / Σ ${totalTokens}`
            : "—"}
        />
      </div>
      <div className="font-mono text-[11px] text-zinc-400">
        <span className="text-zinc-600">增量投递：</span>
        injected {deliveryCounts.injected ?? 0}
        <span className="ml-3">planned {deliveryCounts.planned ?? 0}</span>
        <span className="ml-3">failed {deliveryCounts.failed ?? 0}</span>
        <span className="ml-3">unknown {deliveryCounts.unknown ?? 0}</span>
      </div>
      {unknownEffects.length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10px] text-amber-300">未决或未知效果</div>
          <ol className="space-y-1 font-mono text-[10px] text-zinc-500">
            {unknownEffects.slice(0, 5).map((effect) => (
              <li key={effect.id} className="flex flex-wrap gap-x-2 border-l border-amber-400/30 pl-3">
                <span className="text-zinc-300">{effect.effect_kind}</span>
                <span>{effect.status}</span>
                <span className="break-all">{effect.effect_id}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function JobDetailPanel({ jobId, onClose, messages = [], onSendMessage }: { jobId: string; onClose: () => void; messages?: readonly CanvasHumanMessage[]; onSendMessage?: () => void }) {
  const confirm = useConfirmDialog();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [evidence, setEvidence] = useState<JobEvidence | null>(null);
  const [stream, setStream] = useState<Array<Record<string, unknown>>>([]);
  const [streamCursor, setStreamCursor] = useState<string | null>(null);
  const [streamHasMore, setStreamHasMore] = useState(false);
  const [streamTruncated, setStreamTruncated] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamCursorRef = useRef<string | null>(null);
  const [jobEvents, setJobEvents] = useState<JobEvent[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [session, setSession] = useState<JobSession | null>(null);
  const [sessionLoad, setSessionLoad] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("live");
  const [expandedMessageIds, setExpandedMessageIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const sessionSelectReq = useRef(0);
  const [eventTypeFilter, setEventTypeFilter] = useState<string[]>([]);
  const [eventQuery, setEventQuery] = useState("");
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [forceBusy, setForceBusy] = useState(false);
  const [forceMsg, setForceMsg] = useState<string | null>(null);
  const [rerunBusy, setRerunBusy] = useState<"resume" | "current" | null>(null);
  const [terminalAllowed, setTerminalAllowed] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // ConfirmDialog is portaled outside this drawer. Let its own Escape
      // handler resolve the pending confirmation before closing the job view.
      if (document.querySelector('[role="alertdialog"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 初次加载 + 运行中轮询：与调度器账本保持同步
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setEvidence(null);
    setStream([]);
    setStreamCursor(null);
    streamCursorRef.current = null;
    setStreamHasMore(false);
    setStreamTruncated(false);
    setStreamError(null);
    setJobEvents([]);
    setEventsCursor(null);
    setEventsHasMore(false);
    setSession(null);
    setSessionLoad("loading");
    setSessionError(null);
    setError(null);
    setDownloadError(null);
    setEventTypeFilter([]);
    setEventQuery("");
    setExpandedMessageIds([]);
    api.credentials().then((list) => alive && setCredentials(list)).catch(() => {});
    api.authMe().then((me) => {
      if (!alive) return;
      const scopes = me.actor?.scopes ?? [];
      setTerminalAllowed(scopes.includes("admin") || scopes.includes("jobs:control"));
    }).catch(() => alive && setTerminalAllowed(false));

    const loadCore = () =>
      api
        .job(jobId)
        .then((v) => {
          if (!alive) return;
          setDetail(v);
          setJobEvents((before) => before.length > 0 ? before : v.events);
          setError(null);
          // 运行中默认实时流；已结束默认「结果」（prompt + 摘要 + 产出）
          setTab(ACTIVE.has(v.job.status) ? "live" : "result");
        })
        .catch((e) => alive && setError(String(e)));

    const loadEvidenceBundle = () => {
      api.jobEvidence(jobId).then((v) => alive && setEvidence(v)).catch(() => {});
      api.jobStreamPage(jobId, { limit: 50 }).then((v) => {
        if (!alive) return;
        setStream(v.items);
        setStreamCursor(v.next_cursor);
        streamCursorRef.current = v.next_cursor;
        setStreamHasMore(v.has_more);
        setStreamTruncated(Boolean(v.truncated || v.gap));
      }).catch((e) => alive && setStreamError(String(e)));
      api.jobEventsPage(jobId, { limit: 50 }).then((v) => {
        if (!alive) return;
        setJobEvents(v.items);
        setEventsCursor(v.next_cursor);
        setEventsHasMore(v.has_more);
      }).catch(() => {});
      api
        .jobSession(jobId)
        .then((v) => {
          if (!alive) return;
          setSession(v);
          setSessionLoad("ready");
          setSessionError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setSession(null);
          const msg = String(e);
          // 404 / not found：无归档；其它错误显式展示，避免静默成空页
          if (/\b404\b/i.test(msg) || /not found|无.*session|session.*missing/i.test(msg)) {
            setSessionLoad("missing");
            setSessionError(null);
          } else {
            setSessionLoad("error");
            setSessionError(msg);
          }
        });
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
          setJobEvents((before) => before.length > 0 ? before : v.events);
          if (ACTIVE.has(v.job.status)) {
            // 运行中：过程流持续刷新（事件随 job 详情一起更新）
            const after = streamCursorRef.current;
            api.jobStreamPage(jobId, { after, limit: 50, tail: after === null }).then((s) => {
              if (!alive) return;
              if (s.items.length > 0) {
                setStream((before) => {
                  const seen = new Set(before.map((item) => `${String(item.attempt_id ?? "legacy")}:${String(item.seq ?? "")}`));
                  return [...before, ...s.items.filter((item) => {
                    const key = `${String(item.attempt_id ?? "legacy")}:${String(item.seq ?? "")}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  })];
                });
              }
              if (s.next_cursor) {
                streamCursorRef.current = s.next_cursor;
                setStreamCursor(s.next_cursor);
              }
              setStreamHasMore(s.has_more);
              setStreamTruncated((before) => before || Boolean(s.truncated || s.gap));
            }).catch((e) => alive && setStreamError(String(e)));
            api.jobEventsPage(jobId, { limit: 50 }).then((s) => alive && setJobEvents((before) => mergeRefreshedPage(s.items, before))).catch(() => {});
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

  const loadMoreStream = async () => {
    if (!streamCursor || !streamHasMore) return;
    try {
      const next = await api.jobStreamPage(jobId, { after: streamCursor, limit: 50 });
      setStream((before) => {
        const seen = new Set(before.map((item) => `${String(item.attempt_id ?? "legacy")}:${String(item.seq ?? "")}`));
        return [...before, ...next.items.filter((item) => {
          const key = `${String(item.attempt_id ?? "legacy")}:${String(item.seq ?? "")}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })];
      });
      setStreamCursor(next.next_cursor);
      streamCursorRef.current = next.next_cursor;
      setStreamHasMore(next.has_more);
      setStreamTruncated((before) => before || Boolean(next.truncated || next.gap));
      setStreamError(null);
    } catch (e) {
      setStreamError(String(e));
    }
  };

  const eventTypes = useMemo(() => {
    if (!detail) return [] as string[];
    return Array.from(new Set(jobEvents.map((e) => e.type).filter(Boolean))).sort();
  }, [jobEvents]);

  const filteredEvents = useMemo(() => {
    if (!detail) return [] as JobEvent[];
    const needle = eventQuery.trim().toLowerCase();
    return jobEvents.filter((e) => {
      if (eventTypeFilter.length > 0 && !eventTypeFilter.includes(e.type)) return false;
      if (!needle) return true;
      const blob = `${e.type} ${JSON.stringify(e.payload_json ?? {})}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [detail, eventQuery, eventTypeFilter, jobEvents]);

  const snapshot = (detail?.job.agent_snapshot_json ?? null) as Record<string, unknown> | null;
  const terminalSupported = (() => {
    const runtime = snapshot?.agent_runtime;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return false;
    const capabilities = (runtime as { capabilities?: { interactiveTerminal?: boolean } }).capabilities;
    return capabilities?.interactiveTerminal === true;
  })();
  const agentCli = snapStr(snapshot, "agent_cli");
  const dshTaskMode = snapStr(snapshot, "dsh_task_mode");
  const model = snapStr(snapshot, "model");
  const upstreamModel = snapStr(snapshot, "upstream_model");
  const contextWindowTokens = snapStr(snapshot, "context_window_tokens");
  const roleName = snapStr(snapshot, "name");
  const credentialId = snapStr(snapshot, "credential_id");
  const runtimeImageKey = snapRuntimeImageKey(snapshot);
  const missingModules = Array.isArray(snapshot?.missing_modules)
    ? snapshot.missing_modules
    : detail?.missing_modules ?? [];
  const forceExit = async () => {
    if (!detail || !ACTIVE.has(detail.job.status)) return;
    if (!await confirm({
      title: `强制退出 Job「${detail.job.type}」？`,
      description: "将立即取消调度、回收沙箱并标记为 cancelled，当前执行不可恢复。",
      confirmLabel: "强制退出",
      tone: "danger",
    })) return;
    setForceBusy(true);
    setForceMsg(null);
    try {
      await api.cancelJob(jobId, { force: true, reason: "强制退出" });
      setForceMsg("已强制退出");
      const v = await api.job(jobId);
      setDetail(v);
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setForceBusy(false);
    }
  };
  const rerun = async (mode: "resume" | "current") => {
    if (!detail || !RESUMABLE.has(detail.job.status)) return;
    const useCurrent = mode === "current";
    if (!await confirm({
      title: useCurrent ? "按当前配置重新执行？" : "使用旧冻结快照重新执行？",
      description: useCurrent
        ? "保留同一 Job、画布与历史 Attempt/effect，按当前 RoleConfig、Credential、项目策略和运行镜像完整重冻快照。"
        : "保留同一 Job 与画布并创建新 Attempt，不采用当前配置变化；若受治理身份已漂移，服务端会返回 SNAPSHOT_STALE。",
      confirmLabel: useCurrent ? "当前配置重跑" : "旧快照重跑",
    })) return;
    setRerunBusy(mode);
    setForceMsg(null);
    try {
      if (useCurrent) await api.rerunJobCurrent(jobId);
      else await api.resumeJob(jobId);
      setForceMsg(useCurrent ? "已按当前配置重新入队" : "已使用旧冻结快照重新入队");
      setDetail(await api.job(jobId));
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRerunBusy(null);
    }
  };
  const loadMoreEvents = async () => {
    if (!eventsHasMore || !eventsCursor) return;
    try {
      const next = await api.jobEventsPage(jobId, { after: eventsCursor, limit: 50 });
      setJobEvents((before) => appendUniqueRows(before, next.items));
      setEventsCursor(next.next_cursor);
      setEventsHasMore(next.has_more);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const credentialLabel = useMemo(() => {
    if (!snapshot) return "—";
    const frozenName = snapStr(snapshot, "credential_name");
    if (frozenName !== "—") return frozenName;
    const id = snapStr(snapshot, "credential_id");
    if (id === "—") return "—";
    const hit = credentials.find((c) => c.id === id);
    return hit?.name?.trim() || id;
  }, [snapshot, credentials]);

  /** 下发 prompt：优先 API 冻结/回填结果，再读 payload.intent */
  const dispatchPrompt = useMemo(() => {
    if (!detail) return "";
    const fromApi = typeof detail.dispatched_prompt === "string" ? detail.dispatched_prompt.trim() : "";
    if (fromApi) return fromApi;
    return extractDispatchPrompt(detail.job.type, detail.job.payload_json);
  }, [detail]);

  const intentDescription = useMemo(() => {
    if (!detail) return "";
    const payload = (detail.job.payload_json ?? {}) as Record<string, unknown>;
    const intent = (payload.intent ?? null) as Record<string, unknown> | null;
    return typeof intent?.description === "string" ? intent.description.trim() : "";
  }, [detail]);

  const runSummary = useMemo(() => {
    if (!detail) return "";
    const events = jobEvents.length > 0 ? jobEvents : detail.events;
    // done 事件 summary 优先
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "done" && e.type !== "mark_job_done") continue;
      const p = e.payload_json ?? {};
      const s = typeof p.summary === "string" ? p.summary.trim() : "";
      if (s) return s;
    }
    // progress 最后一条有时也带结论
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "progress") continue;
      const p = e.payload_json ?? {};
      const s =
        (typeof p.summary === "string" && p.summary.trim()) ||
        (typeof p.message === "string" && p.message.trim()) ||
        "";
      if (s && s.length > 40) return s; // 避免过短的心跳
    }
    return "";
  }, [detail, jobEvents]);

  const tabs: Array<[DetailTab, string, number | null, boolean]> = [
    ["result", "结果", runSummary || detail?.findings.length ? 1 : 0, true],
    ["live", "实时流", null, true],
    ["events", "事件", jobEvents.length || detail?.events.length || null, true],
    [
      "session",
      "Session",
      evidence?.manifest.files.filter((f) => f.kind === "main" || f.kind === "subagent" || f.kind === "vendor_export").length ?? null,
      true,
    ],
    ["findings", "产出发现", detail?.findings.length ?? null, true],
    ["config", "运行配置", snapshot ? 1 : 0, true],
  ];

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="运行详情"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="theme-drawer flex h-full min-h-0 min-w-0 w-full max-w-[1320px] flex-col border-l">
        <header className="theme-drawer-header theme-divider flex shrink-0 flex-wrap items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-zinc-600">
              运行详情
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
            {detail && (
              <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
                <span className="rounded-full bg-acc-500/10 px-2 py-0.5 text-acc-300 ring-1 ring-acc-400/20">
                  CLI {agentCli}
                </span>
                <span className="rounded-full bg-white/[.06] px-2 py-0.5 text-zinc-300 ring-1 ring-white/[.08]">
                  模型 {model}
                </span>
                {roleName !== "—" && (
                  <span className="rounded-full bg-white/[.04] px-2 py-0.5 text-zinc-500 ring-1 ring-white/[.06]">
                    角色 {roleName}
                  </span>
                )}
              </div>
            )}
            {onSendMessage && active && (
              <button type="button" onClick={onSendMessage} className="human-message-inline-action">
                <PaperPlaneTilt size={14} /> 发消息
              </button>
            )}
          </div>
          <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
            {detail && RESUMABLE.has(detail.job.status) && (
              <>
                <button
                  type="button"
                  disabled={rerunBusy !== null}
                  onClick={() => void rerun("resume")}
                  title="使用该 Job 创建时的旧冻结快照；身份漂移时拒绝"
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[.04] px-3 py-2 font-mono text-[11px] text-zinc-300 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.08] disabled:opacity-50"
                >
                  <ArrowClockwise size={14} />
                  {rerunBusy === "resume" ? "入队中…" : "旧快照重跑"}
                </button>
                <button
                  type="button"
                  disabled={rerunBusy !== null}
                  onClick={() => void rerun("current")}
                  title="按当前 RoleConfig、凭据和运行镜像重冻快照"
                  className="inline-flex items-center gap-1.5 rounded-full bg-acc-500/[.08] px-3 py-2 font-mono text-[11px] text-acc-300 ring-1 ring-acc-400/20 transition-colors hover:bg-acc-500/[.14] disabled:opacity-50"
                >
                  <ArrowClockwise size={14} weight="bold" />
                  {rerunBusy === "current" ? "入队中…" : "当前配置重跑"}
                </button>
              </>
            )}
            {detail && ACTIVE.has(detail.job.status) && (
              <button
                type="button"
                disabled={forceBusy}
                onClick={() => void forceExit()}
                title="强制退出：取消 Job 并回收沙箱"
                className="inline-flex items-center gap-1.5 rounded-full bg-red-500/[.08] px-3 py-2 font-mono text-[11px] text-red-300 ring-1 ring-red-400/20 transition-colors hover:bg-red-500/[.14] disabled:opacity-50"
              >
                <Stop size={14} weight="fill" />
                {forceBusy ? "退出中…" : "强制退出"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭运行详情"
              className="theme-surface flex size-9 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-400"
            >
              <X size={16} />
            </button>
          </div>
        </header>
        {forceMsg && (
          <div
            className={`theme-divider shrink-0 border-b px-5 py-2 font-mono text-[11px] ${
              forceMsg.startsWith("已") ? "text-acc-300" : "text-red-300"
            }`}
          >
            {forceMsg}
          </div>
        )}

        {detail && (
          <div className="theme-divider grid shrink-0 grid-cols-2 gap-px border-b bg-[var(--line)] sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["JOB ID", jobId],
                ["CLI 工具", agentCli],
                ["模型", model],
                ["开始", formatTime(detail.job.started_at)],
                ["结束", formatTime(detail.job.finished_at)],
                [
                  "证据",
                  evidence
                    ? evidence.manifest.synthetic
                      ? `${evidence.manifest.files.length} inflight files`
                      : `${evidence.manifest.files.length} files`
                    : active
                      ? "采集中"
                      : "无归档",
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="theme-drawer min-w-0 px-4 py-3">
                <div className="font-mono text-[8px] tracking-[.15em] text-zinc-700">{k}</div>
                <div className="mt-1 break-all font-mono text-[10px] text-zinc-400" title={v}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        )}

        <nav className="theme-divider flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b p-2">
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

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {error && (
            <div className="m-5 rounded-xl bg-red-950/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-400/20">
              {error}
            </div>
          )}
          {!error && !detail && (
            <div className="p-8 font-mono text-sm text-zinc-600">正在读取运行账本…</div>
          )}
          {/* 非「结果」页：顶栏展示一次 Job 终态错误；结果页内已有带标题的错误卡片，避免双份 */}
          {detail?.job.error && tab !== "result" && (
            <div className="m-4 rounded-xl bg-red-950/20 px-4 py-3 text-red-300 ring-1 ring-red-400/15">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400/80">
                错误
              </div>
              <MarkdownView markdown={detail.job.error} scrollable={false} />
            </div>
          )}

          {/* 结果：下发 prompt + 已运行输出摘要 + 产出发现 */}
          {detail && tab === "result" && (
            <div className="min-h-full min-w-0 space-y-4 p-4">
              {detail.job.error && (
                <div className="rounded-xl bg-red-950/25 px-4 py-3 text-red-300 ring-1 ring-red-400/20">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400/80">
                    错误
                  </div>
                  <MarkdownView markdown={detail.job.error} scrollable={false} />
                </div>
              )}

              <HumanMessageList
                messages={messages}
                heading="人工消息"
                expandedIds={expandedMessageIds}
                onExpandedIdsChange={setExpandedMessageIds}
              />
              <section className="theme-surface rounded-2xl p-4 ring-1">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400/90">
                    下发 Prompt
                  </div>
                  {dispatchPrompt && (
                    <button
                      type="button"
                      className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
                      onClick={() => {
                        void navigator.clipboard?.writeText(dispatchPrompt);
                      }}
                    >
                      复制
                    </button>
                  )}
                </div>
                {intentDescription && (
                  <p className="mb-2 text-[12px] leading-relaxed text-zinc-500">{intentDescription}</p>
                )}
                {dispatchPrompt ? (
                  <div className="theme-input-surface rounded-xl px-3 py-3 ring-1">
                    <MarkdownView markdown={dispatchPrompt} scrollable={false} />
                  </div>
                ) : (
                  <p className="font-mono text-[12px] text-zinc-600">
                    没有可展示的下发 prompt。Hub 后续轮次只存 trigger，新运行会把去掉画布 YAML 的完整输入冻结到 payload.dispatched_prompt。
                  </p>
                )}
              </section>

              <section className="theme-surface rounded-2xl p-4 ring-1">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-400/90">
                  运行输出摘要
                </div>
                {runSummary ? (
                  <div className="theme-input-surface rounded-xl px-3 py-3 ring-1">
                    <MarkdownView markdown={runSummary} scrollable={false} />
                  </div>
                ) : active ? (
                  <p className="font-mono text-[12px] text-zinc-600">
                    仍在运行，尚无终态摘要。可切到「实时流」查看输出。
                  </p>
                ) : (
                  <p className="font-mono text-[12px] text-zinc-600">
                    没有 mark_job_done 摘要。可查看「实时流」归档内容或「事件」时间线。
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTab("live")}
                    className="rounded-full px-3 py-1 font-mono text-[10px] text-zinc-400 ring-1 ring-white/[.08] hover:text-zinc-200"
                  >
                    查看完整实时流{stream.length ? ` · ${stream.length}` : ""}
                  </button>
                  {(jobEvents.length > 0 || detail.events.length > 0) && (
                    <button
                      type="button"
                      onClick={() => setTab("events")}
                      className="rounded-full px-3 py-1 font-mono text-[10px] text-zinc-400 ring-1 ring-white/[.08] hover:text-zinc-200"
                    >
                      查看事件 · {jobEvents.length || detail.events.length}
                    </button>
                  )}
                </div>
              </section>

              <section className="theme-surface rounded-2xl p-4 ring-1">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                    产出发现
                  </div>
                  {detail.findings.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTab("findings")}
                      className="font-mono text-[10px] text-acc-400 hover:text-acc-300"
                    >
                      全部 {detail.findings.length} →
                    </button>
                  )}
                </div>
                {detail.findings.length === 0 ? (
                  <p className="font-mono text-[12px] text-zinc-600">该运行没有产出 Finding。</p>
                ) : (
                  <div className="space-y-2">
                    {detail.findings.slice(0, 8).map((f) => (
                      <div
                        key={f.id}
                        className="theme-surface flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1"
                      >
                        <SeverityBadge severity={f.severity} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{f.title}</span>
                        <StatusBadge status={f.verify_status} />
                      </div>
                    ))}
                    {detail.findings.length > 8 && (
                      <p className="font-mono text-[10px] text-zinc-600">
                        另有 {detail.findings.length - 8} 条，见「产出发现」
                      </p>
                    )}
                  </div>
                )}
              </section>

              <section className="theme-surface rounded-2xl p-4 ring-1">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  执行账本
                </div>
                <ExecutionLedgerView detail={detail} />
              </section>

              <section className="theme-surface rounded-2xl p-4 ring-1">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  上下文生命周期
                </div>
                <ContextDiagnosticsView diagnostics={detail.context_diagnostics} />
              </section>

              {stream.length > 0 && (
                <section className="theme-surface overflow-hidden rounded-2xl ring-1">
                  <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-2.5">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      过程流预览
                    </div>
                    <button
                      type="button"
                      onClick={() => setTab("live")}
                      className="font-mono text-[10px] text-acc-400 hover:text-acc-300"
                    >
                      展开完整过程 →
                    </button>
                  </div>
                  <div className="max-h-[280px] overflow-hidden">
                    <StreamView
                      blocks={archivedBlocks.slice(-40)}
                      emptyHint="无过程流"
                    />
                  </div>
                </section>
              )}
            </div>
          )}

          {/* 实时流常驻挂载：切换结果/事件 tab 只隐藏，不销毁 WS。 */}
          {detail && active && (
            <div className={`relative flex h-full min-h-0 flex-col overflow-hidden ${tab === "live" ? "" : "hidden"}`}>
              <LiveTerminalWorkspace jobId={jobId} terminalAllowed={terminalAllowed} terminalSupported={terminalSupported} />
            </div>
          )}
          {detail && !active && tab === "live" && (
            <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
              <div className="border-b border-white/[.06] px-3 py-1.5 font-mono text-[10px] text-zinc-600">
                运行已结束 · 显示归档过程
              </div>
              <div className="min-h-0 flex-1">
                <StreamView blocks={archivedBlocks} emptyHint="此运行没有归档过程记录" />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[.06] px-3 py-2">
                {streamHasMore && (
                  <button
                    type="button"
                    onClick={() => void loadMoreStream()}
                    className="rounded-full px-3 py-1.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08]"
                  >
                    加载更多
                  </button>
                )}
                <span className="font-mono text-[10px] text-zinc-600">已加载 {stream.length} 条</span>
                {streamTruncated && <span className="font-mono text-[10px] text-amber-300">归档已截断，可能存在游标缺口</span>}
                {streamError && <span className="font-mono text-[10px] text-red-300">{streamError}</span>}
              </div>
            </div>
          )}

          {/* 事件：调度器 events 表（emit_progress / finding / done…） */}
          {detail && tab === "events" && (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[.06] px-3 py-2">
                <SearchableMultiSelect
                  ariaLabel="事件类型筛选"
                  value={eventTypeFilter}
                  onChange={setEventTypeFilter}
                  options={eventTypes.map((type) => ({ value: type, label: type }))}
                  placeholder="全部类型"
                  className="contents"
                />
                <input
                  aria-label="搜索事件"
                  value={eventQuery}
                  onChange={(e) => setEventQuery(e.target.value)}
                  placeholder="搜索事件内容…"
                  className="theme-input-surface min-h-8 min-w-[8rem] flex-1 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 ring-1 placeholder:text-zinc-700"
                />
                <span className="font-mono text-[10px] text-zinc-600">
                  {filteredEvents.length}/{jobEvents.length || detail.events.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {filteredEvents.length === 0 ? (
                  <div className="py-8 text-center text-[13px] text-zinc-600">
                    {jobEvents.length || detail.events.length ? "没有匹配当前筛选的事件" : "没有语义事件"}
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
                {eventsHasMore && (
                  <button
                    type="button"
                    onClick={() => void loadMoreEvents()}
                    className="mt-4 rounded-full px-3 py-1.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08]"
                  >
                    加载更多事件
                  </button>
                )}
              </div>
            </div>
          )}

          {detail && tab === "session" && (
            <div className="min-h-0 space-y-3 p-4">
              {sessionLoad === "loading" && (
                <div className="theme-surface rounded-2xl p-8 text-center text-[13px] text-zinc-500 ring-1">
                  正在加载 Session 归档…
                </div>
              )}
              {sessionLoad === "error" && (
                <div className="rounded-2xl bg-red-950/20 p-6 text-[13px] text-red-300 ring-1 ring-red-400/20">
                  <p className="font-medium">Session 归档读取失败</p>
                  <p className="mt-2 font-mono text-[11px] text-red-200/80">{sessionError}</p>
                </div>
              )}
              {sessionLoad === "ready" && session && (
                <SessionViewer
                  text={session.text}
                  truncated={session.truncated}
                  cli={evidence?.manifest.cli}
                  sessionId={evidence?.manifest.session_id}
                  sourceLabel="CLI Session 归档"
                  artifacts={session.artifacts ?? [session.meta]}
                  selectedPath={session.meta.path}
                  gatewayUsage={detail.usage}
                  downloadError={downloadError}
                  onSelectArtifact={(path) => {
                    const req = ++sessionSelectReq.current;
                    setDownloadError(null);
                    api.jobSession(jobId, { path })
                      .then((next) => {
                        if (req !== sessionSelectReq.current) return;
                        setSession(next);
                        setSessionError(null);
                      })
                      .catch((cause) => {
                        if (req !== sessionSelectReq.current) return;
                        setDownloadError(String(cause));
                      });
                  }}
                  onDownload={() =>
                    api.downloadJobSession(jobId, {
                      path: session.meta.path,
                      filename: session.meta.name,
                    }).catch((e) => setDownloadError(String(e)))
                  }
                />
              )}
              {sessionLoad === "missing" && stream.length > 0 && (
                <>
                  <p className="text-[11px] text-amber-300/90">
                    {evidence?.manifest.capture_error
                      ? `Session 归档不可用：${evidence.manifest.capture_error} 以下仅展示中断前过程流，不可下载原始 Session。`
                      : "无 CLI 原始 Session 文件；以下为过程流（normalized stream）回退视图，不可下载原始 Session。"}
                  </p>
                  <SessionViewer
                    text={stream.map((row) => JSON.stringify(row)).join("\n")}
                    cli={evidence?.manifest.cli ?? agentCli}
                    sourceLabel="过程流回退"
                    gatewayUsage={detail.usage}
                  />
                </>
              )}
              {sessionLoad === "missing" && stream.length === 0 && detail.usage.length > 0 && (
                <SessionViewer
                  text=""
                  cli={evidence?.manifest.cli ?? agentCli}
                  sourceLabel="Gateway 用量账本"
                  gatewayUsage={detail.usage}
                />
              )}
              {sessionLoad === "missing" && stream.length === 0 && detail.usage.length === 0 && (
                <div className="theme-surface space-y-2 rounded-2xl p-8 text-center text-[13px] text-zinc-500 ring-1">
                  <p>
                    {active
                      ? "Session 将在运行终态前归档（Claude Code / Codex / OpenCode / Pi / DSH）。"
                      : evidence?.manifest.capture_error
                        ? `Session 归档失败：${evidence.manifest.capture_error}`
                        : "该 Job 没有可归档的 CLI Session。"}
                  </p>
                  <p className="font-mono text-[11px] leading-5 text-zinc-600">
                    常见原因：AGENT_MODE=fake（不会落盘 Session）、运行中尚未 finalize、
                    或该 CLI 未成功捕获 session_id。有归档时标签会显示文件数，并出现时间线 / 用量 / 统计 / 原始。
                  </p>
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

          {/* 运行配置：createJob 时冻结的 agent_snapshot_json */}
          {detail && tab === "config" && (
            <div className="h-full min-h-0 space-y-4 overflow-y-auto p-4">
              {!snapshot || Object.keys(snapshot).length === 0 ? (
                <div className="p-8 text-center text-[13px] text-zinc-600">
                  该 Job 没有冻结运行快照（旧数据或创建时未写入 agent_snapshot_json）。
                </div>
              ) : (
                <>
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      运行时身份
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ConfigField label="CLI 工具 (agent_cli)" value={agentCli} />
                      {agentCli === "dsh" && <ConfigField label="DSH 任务模式" value={dshTaskMode} />}
                      <ConfigField label="模型 (model)" value={model} />
                      <ConfigField label="上游模型 (upstream_model)" value={upstreamModel} />
                      <ConfigField
                        label="CLI 客户端上下文预算"
                        value={contextWindowTokens === "—" ? "Provider / CLI 默认" : `${contextWindowTokens} tokens`}
                        title="创建 Job 时冻结；这是客户端预算，不代表或提升上游模型能力。"
                      />
                      <ConfigField label="角色 (name)" value={roleName} />
                      <ConfigField label="角色类型 (role_kind)" value={snapStr(snapshot, "role_kind")} />
                      <ConfigField
                        label="凭据 Provider"
                        value={snapStr(snapshot, "credential_provider")}
                      />
                      <ConfigField
                        label="凭据"
                        value={credentialLabel}
                        title={credentialId !== "—" ? `ID: ${credentialId}` : undefined}
                      />
                      <ConfigField
                        label="RoleConfig 版本"
                        value={snapStr(snapshot, "role_config_version")}
                      />
                      <ConfigField
                        label="RoleConfig ID"
                        value={snapStr(snapshot, "role_config_id")}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      运行镜像与推理
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ConfigField
                        label="冻结运行镜像 key"
                        value={runtimeImageKey}
                      />
                      <ConfigField label="推理 (reasoning)" value={snapStr(snapshot, "reasoning")} />
                      <ConfigField
                        label="镜像 digest"
                        value={
                          snapshot.runtime_image &&
                          typeof snapshot.runtime_image === "object" &&
                          snapshot.runtime_image !== null
                            ? String(
                                (snapshot.runtime_image as Record<string, unknown>).image_digest ??
                                  (snapshot.runtime_image as Record<string, unknown>).image_ref ??
                                  "—",
                              )
                            : "—"
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      工具与扩展
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ConfigField
                        label="Skills"
                        value={
                          Array.isArray(snapshot.skills)
                            ? `${snapshot.skills.length} 项`
                            : snapStr(snapshot, "skills")
                        }
                      />
                      <ConfigField
                        label="Commands"
                        value={
                          Array.isArray(snapshot.commands)
                            ? `${snapshot.commands.length} 项`
                            : snapStr(snapshot, "commands")
                        }
                      />
                      <ConfigField
                        label="MCP"
                        value={
                          Array.isArray(snapshot.mcps)
                            ? `${snapshot.mcps.length} 项`
                            : snapStr(snapshot, "mcps")
                        }
                      />
                      <ConfigField
                        label="Subagents"
                        value={
                          Array.isArray(snapshot.subagents)
                            ? `${snapshot.subagents.length} 项`
                            : snapStr(snapshot, "subagents")
                        }
                      />
                      <ConfigField label="模块缺失" value={`${missingModules.length} 项`} />
                    </div>
                    {missingModules.length > 0 && (
                      <pre className="theme-input-surface mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border p-3 font-mono text-[11px] leading-5 text-amber-200">
                        {JSON.stringify(missingModules, null, 2)}
                      </pre>
                    )}
                  </div>
                  {typeof snapshot.instructions_markdown === "string" &&
                    snapshot.instructions_markdown.trim() && (
                      <div>
                        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                          角色指令
                        </div>
                        <div className="theme-surface rounded-xl p-4 ring-1">
                          <MarkdownView markdown={snapshot.instructions_markdown} />
                        </div>
                      </div>
                    )}
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      完整冻结快照 (agent_snapshot_json)
                    </div>
                    <pre className="theme-input-surface max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-2xl border p-4 font-mono text-[11px] leading-5 text-zinc-400">
                      {JSON.stringify(snapshot, null, 2)}
                    </pre>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
