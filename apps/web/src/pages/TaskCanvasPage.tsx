import {
  ArrowLeft,
  CaretDown,
  DotsThree,
  FileText,
  Graph,
  ListBullets,
  PaperPlaneTilt,
  Note,
  Pause,
  Play,
  SealCheck,
  Prohibit,
  Target,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  type CanvasConvergence,
  type CanvasData,
  type CanvasNode,
  type FactSummary,
  type FindingTrace,
  type FindingSummary,
  type EffectiveFindingProtocol,
  type JobSummary,
} from "../api";
import { useAuth } from "../auth";
import { canEditTaskIntent, taskIntentContentFromTarget } from "../task-intent";
import { CanvasView } from "../CanvasView";
import { appendUniqueRows, initializePageProgress, mergeRefreshedPage, type PageProgress } from "../canvas-page-sync";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { composeRetryErrorMessage } from "../composeTaskModel";
import { FindingDetailPanel } from "../FindingDetailPanel";
import { FactDetailPanel } from "../FactDetailPanel";
import { factPageFilterKey, readFactPageFilters, updateFactPageQuery, type FactFilterKey } from "../fact-page-state";
import { HumanInterventionBanner } from "../HumanInterventionBanner";
import { HumanMessageComposer } from "../HumanMessageComposer";
import {
  humanInterventionUiPrefUserKey,
  humanMessageTargetNodeForJobId,
  humanMessageTargetNodeFromContext,
  jobCanReceiveHumanReply,
  listHumanInterventions,
  openHumanInterventionForJob,
  readHumanInterventionPrefs,
  writeHumanInterventionPrefs,
  type HumanInterventionItem,
  type HumanInterventionPrefs,
} from "../human-messages";
import { JobDetailPanel } from "../JobDetailPanel";
import { MarkdownView } from "../MarkdownView";
import { ReportPanel } from "../ReportPanel";
import { taskWorkbenchCanvasLayerClass, taskWorkbenchListPaneClass } from "../task-workbench-layers";
import { SearchableMultiSelect } from "../SearchableSelect";
import { readMultiSearchParam, writeMultiSearchParam } from "../searchable-select-model";
import { ACTIVE_TASK_JOB_STATUSES, deriveTaskLifecycle, readScheduledStartAt } from "../task-lifecycle";
import {
  DataTable,
  EmptyState,
  SeverityBadge,
  StatusBadge,
  formatElapsed,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
} from "../ui";

type Tab = "canvas" | "facts" | "findings" | "jobs" | "report";

// Human-gated work is still active; current running elapsed therefore continues
// from the first actual start while a Job is waiting_human.
const ACTIVE_JOB = ACTIVE_TASK_JOB_STATUSES;
const RESUMABLE_JOB = new Set(["waiting_human", "orphan", "failed", "timeout"]);

function parseConvergenceFromTarget(target: Record<string, unknown> | undefined): CanvasConvergence | null {
  if (!target || typeof target !== "object") return null;
  const conv = target.convergence as Record<string, unknown> | undefined;
  if (!conv || typeof conv !== "object") return null;
  return {
    hub_paused: Boolean(conv.hub_paused),
    paused_reason: typeof conv.paused_reason === "string" ? conv.paused_reason : undefined,
    paused_at: typeof conv.paused_at === "string" ? conv.paused_at : undefined,
    auto_stopped: Boolean(conv.auto_stopped),
  };
}

async function loadFindingIndex(canvasId: string): Promise<FindingSummary[]> {
  const rows: FindingSummary[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < 80; pageNumber += 1) {
    const page = await api.findingsPage({ canvas_id: canvasId, after, limit: 50 });
    rows.push(...page.items);
    if (!page.has_more || !page.next_cursor) return rows;
    if (seenCursors.has(page.next_cursor)) throw new Error("Finding 索引游标没有前进");
    seenCursors.add(page.next_cursor);
    after = page.next_cursor;
  }
  throw new Error("Finding 索引超过 4000 条安全上限");
}

/** 待人工处理事实卡片：needs_human 的 fact 节点，人工确认 / 明确排除（§5.2-6） */
function HumanFactCard({ canvasId, node, onDone }: { canvasId: string; node: CanvasNode; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: "verified" | "rejected") => {
    setBusy(true);
    try {
      await api.setFactVerification(canvasId, node.id, status);
      onDone(status === "verified" ? "已标记为已验证" : "已排除该事实");
    } catch {
      // 失败由下一轮轮询呈现
    } finally {
      setBusy(false);
    }
  };
  const desc = (node.body_json?.description as string) ?? "";
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-amber-400/[.045] px-4 py-3 ring-1 ring-amber-300/15 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-zinc-100">{node.title}</div>
        {desc && <MarkdownView markdown={desc} className="mt-2" />}
      </div>
      <button
        onClick={() => act("verified")}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-400/[.06] px-3 py-1.5 font-mono text-[10px] text-emerald-300 ring-1 ring-emerald-300/15 transition-colors hover:bg-emerald-400/[.1] disabled:opacity-50"
      >
        <SealCheck size={12} /> 标记已验证
      </button>
      <button
        onClick={() => act("rejected")}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-full bg-red-400/[.05] px-3 py-1.5 font-mono text-[10px] text-red-300 ring-1 ring-red-300/15 transition-colors hover:bg-red-400/[.09] disabled:opacity-50"
      >
        <Prohibit size={12} /> 排除
      </button>
    </div>
  );
}

/** 任务详情：只展示本任务范围 / 本任务发现 / 本任务过程画布（不混其它任务） */
export function TaskCanvasPage() {
  const confirm = useConfirmDialog();
  const { me } = useAuth();
  const { projectId, canvasId } = useParams<{ projectId: string; canvasId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) || "canvas";
  const severities = readMultiSearchParam(searchParams, "severity");
  const profiles = readMultiSearchParam(searchParams, "profile");
  const verifyStatuses = readMultiSearchParam(searchParams, "verify");
  const factFilterKey = factPageFilterKey(readFactPageFilters(searchParams));
  const factFilters = useMemo(
    () => readFactPageFilters(searchParams),
    [factFilterKey],
  );
  const selectedFact = searchParams.get("fact");
  const selectedFinding = searchParams.get("finding");
  const selectedJob = searchParams.get("job");
  const traceFinding = searchParams.get("traceFinding");
  const focusNode = searchParams.get("focusNode");

  const [meta, setMeta] = useState<CanvasData["canvas"] | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [facts, setFacts] = useState<FactSummary[]>([]);
  const [findingIndex, setFindingIndex] = useState<FindingSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [findingsCursor, setFindingsCursor] = useState<string | null>(null);
  const [findingsHasMore, setFindingsHasMore] = useState(false);
  const [jobsCursor, setJobsCursor] = useState<string | null>(null);
  const [jobsHasMore, setJobsHasMore] = useState(false);
  const [factsCursor, setFactsCursor] = useState<string | null>(null);
  const [factsHasMore, setFactsHasMore] = useState(false);
  const [factsLoadingMore, setFactsLoadingMore] = useState(false);
  const [factsLoading, setFactsLoading] = useState(true);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [factsRefresh, setFactsRefresh] = useState(0);
  const [jobStatusFilters, setJobStatusFilters] = useState<string[]>([]);
  const [jobRoleTypeFilters, setJobRoleTypeFilters] = useState<string[]>([]);
  const [jobKeyword, setJobKeyword] = useState("");
  const [convergence, setConvergence] = useState<CanvasConvergence | null>(null);
  const [convBusy, setConvBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const paginationRef = useRef<{ findings: PageProgress | null; jobs: PageProgress | null; facts: PageProgress | null }>({
    findings: null,
    jobs: null,
    facts: null,
  });
  const [clock, setClock] = useState(() => Date.now());
  /** 任务内容 / 审计范围：默认折叠，避免挤占画布 */
  const [scopeOpen, setScopeOpen] = useState(false);
  const [intentTitle, setIntentTitle] = useState("");
  const [intentContent, setIntentContent] = useState("");
  const [intentDirty, setIntentDirty] = useState(false);
  const [intentSaving, setIntentSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [findingTrace, setFindingTrace] = useState<FindingTrace | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerNode, setComposerNode] = useState<CanvasNode | null>(null);
  const [composerInterventionId, setComposerInterventionId] = useState<string | null>(null);
  const [ignoreBusyId, setIgnoreBusyId] = useState<string | null>(null);
  const prefUserKey = humanInterventionUiPrefUserKey(me);
  const [interventionPrefs, setInterventionPrefs] = useState<HumanInterventionPrefs>(() =>
    readHumanInterventionPrefs(prefUserKey, canvasId ?? ""),
  );

  // Lifecycle counters remain live while the task is open, independent of API polling.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!canvasId || !projectId) return;
    let stop = false;
    setFindings([]);
    setFindingIndex([]);
    setFindingsCursor(null);
    setFindingsHasMore(false);
    setJobs([]);
    setJobsCursor(null);
    setJobsHasMore(false);
    paginationRef.current = { findings: null, jobs: null, facts: null };
    setMeta(null);
    setNodes([]);
    setConvergence(null);
    setError(null);
    setComposerOpen(false);
    setComposerNode(null);
    setComposerInterventionId(null);
    setInterventionPrefs(readHumanInterventionPrefs(prefUserKey, canvasId));
    loadFindingIndex(canvasId)
      .then((rows) => {
        if (!stop) setFindingIndex(rows);
      })
      .catch((e) => {
        if (!stop) setError(String(e));
      });
    const tick = () => {
      Promise.all([
        api.findingsPage({ canvas_id: canvasId, limit: 50 }),
        api.jobsPage({ canvas_id: canvasId, limit: 50 }),
      ])
        .then(([fs, js]) => {
          if (stop) return;
          setFindings((before) => mergeRefreshedPage(fs.items, before));
          if (!paginationRef.current.findings) {
            paginationRef.current.findings = initializePageProgress(null, fs);
            setFindingsCursor(paginationRef.current.findings.cursor);
            setFindingsHasMore(paginationRef.current.findings.hasMore);
          }
          setJobs((before) => mergeRefreshedPage(js.items, before));
          if (!paginationRef.current.jobs) {
            paginationRef.current.jobs = initializePageProgress(null, js);
            setJobsCursor(paginationRef.current.jobs.cursor);
            setJobsHasMore(paginationRef.current.jobs.hasMore);
          }
          setError(null);
        })
        .catch((e) => {
          if (!stop) setError(String(e));
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [canvasId, projectId, prefUserKey]);

  useEffect(() => {
    if (!canvasId) return;
    let stop = false;
    setFacts([]);
    setFactsCursor(null);
    setFactsHasMore(false);
    setFactsLoading(true);
    setFactsError(null);
    paginationRef.current.facts = null;
    const tick = async () => {
      try {
        const page = await api.factsPage(canvasId, {
          verification_status: factFilters.verification_status || undefined,
          evidence_kind: factFilters.evidence_kind || undefined,
          finding_id: factFilters.finding_id || undefined,
          job_id: factFilters.job_id || undefined,
          limit: 50,
        });
        if (stop) return;
        setFacts((before) => mergeRefreshedPage(page.items, before));
        setFactsLoading(false);
        setFactsError(null);
        if (!paginationRef.current.facts) {
          paginationRef.current.facts = initializePageProgress(null, page);
          setFactsCursor(paginationRef.current.facts.cursor);
          setFactsHasMore(paginationRef.current.facts.hasMore);
        }
      } catch (cause) {
        if (!stop) {
          setFactsLoading(false);
          setFactsError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [canvasId, factFilterKey, factsRefresh]);

  useEffect(() => {
    if (!traceFinding || !canvasId) {
      setFindingTrace(null);
      return;
    }
    let alive = true;
    let requestSequence = 0;
    setFindingTrace(null);
    const loadTrace = () => {
      const request = ++requestSequence;
      api.finding(traceFinding)
        .then((detail) => {
          if (!alive || request !== requestSequence) return;
          if (detail.trace.source.canvas_id !== canvasId) {
            setError("Finding 不属于当前任务画布");
            return;
          }
          setFindingTrace(detail.trace);
          setError(null);
        })
        .catch((e) => {
          if (alive && request === requestSequence) setError(String(e));
        });
    };
    loadTrace();
    const timer = window.setInterval(loadTrace, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [canvasId, traceFinding]);

  const onCanvasData = useCallback((canvas: CanvasData) => {
    setMeta(canvas.canvas ?? null);
    setNodes(canvas.nodes ?? []);
    setConvergence(canvas.convergence ?? parseConvergenceFromTarget(canvas.canvas?.target_json));
  }, []);

  const loadMoreFindings = async () => {
    if (!canvasId || !findingsHasMore || !findingsCursor) return;
    try {
      const next = await api.findingsPage({ canvas_id: canvasId, after: findingsCursor, limit: 50 });
      setFindings((before) => appendUniqueRows(before, next.items));
      setFindingsCursor(next.next_cursor);
      setFindingsHasMore(next.has_more);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadMoreFacts = async () => {
    if (!canvasId || !factsHasMore || !factsCursor || factsLoadingMore) return;
    setFactsLoadingMore(true);
    try {
      const next = await api.factsPage(canvasId, {
        verification_status: factFilters.verification_status || undefined,
        evidence_kind: factFilters.evidence_kind || undefined,
        finding_id: factFilters.finding_id || undefined,
        job_id: factFilters.job_id || undefined,
        after: factsCursor,
        limit: 50,
      });
      setFacts((before) => appendUniqueRows(before, next.items));
      paginationRef.current.facts = { cursor: next.next_cursor, hasMore: next.has_more };
      setFactsCursor(next.next_cursor);
      setFactsHasMore(next.has_more);
    } catch (cause) {
      setFactsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFactsLoadingMore(false);
    }
  };

  const loadMoreJobs = async () => {
    if (!canvasId || !jobsHasMore || !jobsCursor) return;
    try {
      const next = await api.jobsPage({ canvas_id: canvasId, after: jobsCursor, limit: 50 });
      setJobs((before) => appendUniqueRows(before, next.items));
      setJobsCursor(next.next_cursor);
      setJobsHasMore(next.has_more);
    } catch (e) {
      setError(String(e));
    }
  };

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  };

  const runConvergence = async (action: "pause" | "resume" | "drain" | "hub-now") => {
    if (!canvasId) return;
    setConvBusy(true);
    setMoreOpen(false);
    try {
      if (action === "pause") {
        const r = await api.pauseCanvasDecision(canvasId, "manual_pause");
        setConvergence(r.convergence);
        flash("已暂停");
      } else if (action === "resume") {
        const r = await api.resumeCanvasDecision(canvasId, false);
        setConvergence(r.convergence);
        flash("已继续");
      } else if (action === "drain") {
        const r = await api.drainCanvasPriority(canvasId);
        flash(`已清理 ${r.cancelled} 个低优先级 verify`);
      } else {
        await api.runCanvasHubNow(canvasId);
        flash("已请求一轮 Hub");
      }
    } catch (e) {
      flash(`操作失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  const toggleTaskExecution = async () => {
    if (!canvasId || !meta || meta.execution_state === "pausing") return;
    setConvBusy(true);
    try {
      const result = meta.execution_state === "paused"
        ? await api.startTask(canvasId)
        : await api.pauseTask(canvasId);
      setMeta((current) => current ? {
        ...current,
        execution_state: result.execution_state,
        execution_active_count: result.active_count,
        pending_count: result.pending_count,
      } : current);
      if (result.execution_state === "pausing") {
        flash(`暂停中，尚有 ${result.active_count} 个 Job 安全收尾`);
      } else if (result.execution_state === "paused") {
        flash(result.changed ? "任务已暂停" : "任务已经暂停");
      } else {
        flash(result.changed ? "任务已开始" : "任务已经处于开始状态");
      }
    } catch (e) {
      flash(`任务控制失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  const hasActiveJob = jobs.some((j) => ACTIVE_JOB.has(j.status));
  const canResumeSession = !hasActiveJob && jobs.length > 0;
  const canHardRetry = !hasActiveJob && jobs.length > 0;
  const activeJobs = jobs.filter((j) => ACTIVE_JOB.has(j.status));
  const rootNode = nodes.find((n) => n.node_type === "root");
  const rootStatus = rootNode?.status ?? meta?.root_status ?? null;
  const reportStatus = nodes.find((n) => n.node_type === "report")?.status ?? meta?.report_status ?? null;
  // Keep the scheduler-governed phase fields as a fallback while the L0 node
  // projection is still loading; the node values win once they are present.
  const canvasStatus = (meta as ({ status?: string } | null))?.status;
  const scheduledStartAt = readScheduledStartAt(meta?.target_json);
  const taskLifecycle = deriveTaskLifecycle({
    status: canvasStatus,
    activeCount: meta?.active_count,
    jobs,
    jobCount: meta?.job_count,
    rootStatus,
    reportStatus,
    endedAt: meta?.ended_at,
    startedAt: meta?.started_at,
    scheduledStartAt,
    executionState: meta?.execution_state,
    executionActiveCount: meta?.execution_active_count,
    pendingCount: meta?.pending_count,
    nowMs: clock,
  });
  const lifecycleActive = taskLifecycle.isActive;
  const isScheduled = taskLifecycle.status === "scheduled";
  const executionState = meta?.execution_state ?? "running";
  const executionPausing = executionState === "pausing";
  const executionPaused = executionState === "paused";
  const taskArchived = canvasStatus === "archived";
  const canEditIntent = canEditTaskIntent(me, taskArchived);
  useEffect(() => {
    if (intentDirty) return;
    setIntentTitle(meta?.title ?? "");
    setIntentContent(taskIntentContentFromTarget(meta?.target_json));
  }, [intentDirty, meta?.title, meta?.target_json]);
  // 生命周期从实际开始执行起算；定时排队阶段不算进生命周期。
  const executionElapsed = meta?.started_at
    ? formatElapsed(meta.started_at, lifecycleActive ? null : taskLifecycle.endedAt, clock)
    : "未开始";
  const startExecValue = meta?.started_at
    ? relativeTime(meta.started_at)
    : isScheduled && scheduledStartAt
      ? new Date(scheduledStartAt).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }) + "（北京）"
      : lifecycleActive
        ? "等待启动"
        : "—";
  const startExecTitle = meta?.started_at
    ? `实际开始 ${formatTime(meta.started_at)}`
    : isScheduled && scheduledStartAt
      ? `计划开始 ${new Date(scheduledStartAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`
      : "尚未有 Job 实际开始";

  /** 强制退出画布上全部活动 Job（含 running） */
  const forceExitActive = async () => {
    if (!canvasId || activeJobs.length === 0) return;
    if (!await confirm({
      title: `强制退出 ${activeJobs.length} 个活动 Job？`,
      description: "将立即取消调度并回收沙箱，相关节点会标记为 cancelled，当前执行不可恢复。",
      confirmLabel: "全部强制退出",
      tone: "danger",
    })) return;
    setConvBusy(true);
    setMoreOpen(false);
    try {
      const r = await api.cancelCanvasActiveJobs(canvasId, "强制退出全部活动 Job");
      flash(r.cancelled > 0 ? `已强制退出 ${r.cancelled} 个活动 Job` : "没有可退出的活动 Job");
      // 立即刷新列表
      const js = await api.jobsPage({ canvas_id: canvasId, limit: 50 });
      setJobs(js.items);
      setJobsCursor(js.next_cursor);
      setJobsHasMore(js.has_more);
    } catch (e) {
      flash(`强制退出失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  /** 继续执行：默认旧冻结快照；身份漂移时要求逐 Job 按当前配置重跑。 */
  const resumeSession = async () => {
    if (!canvasId) return;
    setConvBusy(true);
    setMoreOpen(false);
    try {
      const r = await api.resumeTaskSession(canvasId);
      if (r.action === "already_running") flash(r.message ?? "任务已在执行");
      else if (r.action === "rerun_interrupted_jobs") {
        flash(r.message ?? `已重新入队 ${r.jobs?.length ?? 0} 个中断 Worker（同 Job ID、新 Attempt）`);
      }
      else if (r.action === "resume_job") flash(r.message ?? "已使用旧冻结快照重新执行单个 Job");
      else if (r.action === "start_now") flash(r.message ?? "已清除定时门禁，任务立即进入调度");
      else flash("没有中断 Worker；已唤醒 Hub 继续决策");
    } catch (e) {
      flash(`继续执行失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  const rerunOneJob = async (
    job: { id: string; type: string },
    mode: "resume" | "current",
  ) => {
    const useCurrent = mode === "current";
    if (!await confirm({
      title: useCurrent ? `按当前配置重新执行「${job.type}」？` : `使用旧冻结快照重新执行「${job.type}」？`,
      description: useCurrent
        ? "保留画布 Fact/Finding/Intent 与历史 Attempt/effect，按当前 RoleConfig、Credential、项目策略和运行镜像完整重冻快照。"
        : "保留同一 Job 与画布并创建新 Attempt；不会采用当前配置变化，身份漂移时服务端会拒绝。",
      confirmLabel: useCurrent ? "当前配置重跑" : "旧快照重跑",
    })) return;
    setConvBusy(true);
    try {
      if (useCurrent) await api.rerunJobCurrent(job.id);
      else await api.resumeJob(job.id);
      flash(useCurrent ? "已按当前配置重新入队" : "已使用旧冻结快照重新入队");
      const js = await api.jobsPage({ canvas_id: canvasId, limit: 50 });
      setJobs(js.items);
      setJobsCursor(js.next_cursor);
      setJobsHasMore(js.has_more);
    } catch (e) {
      flash(`重新执行失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  /** 重试任务 = 清空本画布历史后从意图重新执行 */
  const saveTaskIntent = async () => {
    if (!canvasId || !canEditIntent) return;
    const title = intentTitle.trim();
    const content = intentContent.trim();
    if (!title) return flash("请写明希望得到的结果");
    if (!content) return flash("请补充必要背景或边界");
    setIntentSaving(true);
    try {
      const result = await api.updateTask(canvasId, { title, content });
      setMeta((prev) => prev
        ? { ...prev, title: result.title, target_json: result.target_json }
        : prev);
      setIntentTitle(result.title);
      setIntentContent(taskIntentContentFromTarget(result.target_json));
      setIntentDirty(false);
      flash(result.message);
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setIntentSaving(false);
    }
  };

  const retryTaskHard = async () => {
    if (!canvasId) return;
    const ok = await confirm({
      title: "清空历史并重新执行？",
      description: meta?.target_json?.kind === "compose"
        ? "将清空本画布的运行数据，并按冻结种子重新投影后执行。项目历史 Finding 库存不会删除；若种子已失效，系统会拒绝重试。"
        : "将删除本任务的全部运行历史（Job、画布节点、本轮 Finding、报告），并按原意图从零重新执行。此操作不可撤销。",
      confirmLabel: "清空并重试",
      tone: "danger",
    });
    if (!ok) return;
    setConvBusy(true);
    setMoreOpen(false);
    try {
      await api.retryTask(canvasId);
      flash("已清空历史并重新开始执行");
      setScopeOpen(false);
    } catch (e) {
      flash(composeRetryErrorMessage(e));
    } finally {
      setConvBusy(false);
    }
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  const scopeEntries = useMemo(() => {
    const t = meta?.target_json ?? {};
    if (typeof t.content === "string" && t.content.trim()) {
      return [["内容", t.content]] as [string, unknown][];
    }
    return Object.entries(t).filter(
      ([k, v]) =>
        k !== "convergence" &&
        v !== null &&
        v !== undefined &&
        String(v).length > 0,
    );
  }, [meta]);

  /** 决策态文案：并入副标题，不用彩色 badge */
  const decisionLabel = useMemo(() => {
    if (!convergence) return null;
    if (convergence.hub_paused) return "已暂停";
    if (convergence.auto_stopped) return "已收敛";
    return "自驱中";
  }, [convergence]);

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "canvas") sp.delete("tab");
    else sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  };

  const setQuery = (key: "finding" | "job" | "traceFinding" | "focusNode", value: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (value) sp.set(key, value);
    else sp.delete(key);
    setSearchParams(sp, { replace: true });
  };

  const setMultiQuery = (key: "severity" | "profile" | "verify", values: string[]) => {
    const sp = new URLSearchParams(searchParams);
    writeMultiSearchParam(sp, key, values);
    setSearchParams(sp, { replace: true });
  };

  const setFactQuery = (key: FactFilterKey | "fact", value: string | readonly string[] | null) => {
    const next = updateFactPageQuery(searchParams, key, value);
    if (key === "fact" && typeof value === "string" && value) {
      next.delete("finding");
      next.delete("job");
    }
    setSearchParams(next, { replace: true });
  };

  const openFromFact = (kind: "finding" | "job", id: string) => {
    const next = updateFactPageQuery(searchParams, "fact", null);
    next.set(kind, id);
    setSearchParams(next, { replace: true });
  };

  const focusFindingTrace = (findingId: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("tab");
    sp.delete("finding");
    sp.delete("focusNode");
    sp.set("traceFinding", findingId);
    setSearchParams(sp, { replace: true });
  };

  if (!projectId || !canvasId) return null;

  // 待人工处理事实（needs_human 的 fact 节点）
  const humanFacts = nodes.filter(
    (n) => n.node_type === "fact" && n.verification_status === "needs_human",
  );
  const humanInterventions = listHumanInterventions(nodes);
  const updateInterventionPrefs = (prefs: HumanInterventionPrefs) => {
    setInterventionPrefs(prefs);
    if (canvasId) writeHumanInterventionPrefs(prefUserKey, canvasId, prefs);
  };
  const openHumanReply = (target: CanvasNode | null) => {
    const targetJobId = target?.job_id ?? (typeof target?.body_json?.job_id === "string" ? target.body_json.job_id : null);
    setComposerNode(target);
    setComposerInterventionId(openHumanInterventionForJob(nodes, targetJobId)?.id ?? null);
    setComposerOpen(true);
  };
  const ignoreIntervention = async (item: HumanInterventionItem) => {
    if (!canvasId) return;
    setIgnoreBusyId(item.node.id);
    try {
      const result = await api.ignoreHumanIntervention(canvasId, item.node.id);
      setNodes((current) => current.map((node) => (
        node.id === item.node.id
          ? { ...node, status: "ignored", body_json: { ...node.body_json, resolution: "ignored" } }
          : result.job_resumed && result.job_id && node.job_id === result.job_id && (node.node_type === "job" || node.node_type === "intent" || node.node_type === "report")
            ? { ...node, status: "pending" }
            : node
      )));
      const js = await api.jobsPage({ canvas_id: canvasId, limit: 50 });
      setJobs(js.items);
      flash(result.job_resumed ? "已忽略并继续推进" : "已忽略");
    } catch (error) {
      flash(`忽略失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setIgnoreBusyId(null);
    }
  };
  const visibleFindings = findings.filter(
    (finding) => (!severities.length || severities.includes(finding.severity ?? ""))
      && (!profiles.length || profiles.includes(finding.profile))
      && (!verifyStatuses.length || verifyStatuses.includes(finding.verify_status ?? "pending")),
  );
  const findingProtocol = (meta?.target_json?.effective_finding_protocol ?? null) as EffectiveFindingProtocol | null;
  const findingIdByNodeId = useMemo(
    () => new Map(
      [...findingIndex, ...findings]
        .filter((finding) => finding.node_id)
        .map((finding) => [finding.node_id as string, finding.id]),
    ),
    [findingIndex, findings],
  );
  const factFindingFilterOptions = useMemo(
    () => Array.from(new Map(
      [...findingIndex, ...findings].map((finding) => [
        finding.id,
        { value: finding.id, label: `${finding.title} · ${finding.id.slice(0, 8)}` },
      ]),
    ).values()),
    [findingIndex, findings],
  );
  const factJobFilterOptions = useMemo(
    () => jobs.map((job) => ({ value: job.id, label: `${job.role_name ?? job.type} · ${job.id.slice(0, 8)}` })),
    [jobs],
  );
  const jobRoleTypeOptions = useMemo(
    () => Array.from(new Set(jobs.flatMap((job) => [job.role_name, job.type].filter((value): value is string => Boolean(value))))).sort(),
    [jobs],
  );
  const visibleJobs = useMemo(() => {
    const keyword = jobKeyword.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesStatus = !jobStatusFilters.length || jobStatusFilters.includes(job.status);
      const matchesRoleType = !jobRoleTypeFilters.length || jobRoleTypeFilters.some((value) => job.role_name === value || job.type === value);
      const searchable = [job.id, job.type, job.role_name, job.agent_cli, job.model, job.credential_provider, job.error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesStatus && matchesRoleType && (!keyword || searchable.includes(keyword));
    });
  }, [jobKeyword, jobRoleTypeFilters, jobStatusFilters, jobs]);
  const hasJobFilters = Boolean(jobStatusFilters.length || jobRoleTypeFilters.length || jobKeyword);

  const jobElapsed = (job: JobSummary) => {
    if (!job.started_at) return "—";
    if (!job.finished_at && !ACTIVE_JOB.has(job.status)) return "—";
    return formatElapsed(job.started_at, job.finished_at, clock);
  };

  const tabs: { key: Tab; label: string; count?: number; icon: typeof Graph }[] = [
    { key: "canvas", label: "过程画布", icon: Graph },
    { key: "facts", label: "事实", count: facts.length, icon: Note },
    { key: "findings", label: "本次发现", count: findings.length, icon: ListBullets },
    { key: "jobs", label: "本次运行", count: jobs.length, icon: Target },
    { key: "report", label: "报告", icon: FileText },
  ];

  return (
    <div className="task-workbench flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {/* 工作台上下文：返回、任务标题与状态 */}
      <div className="task-workbench-header mx-3 mt-3 flex min-h-14 shrink-0 flex-wrap items-start gap-3 rounded-[20px] bg-white/[.03] px-3 py-2 ring-1 ring-white/[.06] sm:items-center">
        <Link
          to={`/projects/${projectId}/tasks`}
          className="order-1 flex items-center gap-1.5 rounded-full theme-surface px-3 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-[var(--surface-tint-strong)] hover:text-zinc-200 sm:order-none"
        >
          <ArrowLeft size={14} weight="light" /> 任务列表
        </Link>
        <div className="order-3 min-w-0 w-full flex-none sm:order-none sm:w-auto sm:flex-1">
          <span className="block break-words text-[13px] font-medium text-zinc-200 sm:truncate">
            {meta?.title ?? "加载任务…"}
          </span>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex rounded-full px-2 py-0.5 font-mono text-[9px] ring-1" style={{ color: taskLifecycle.color, background: `${taskLifecycle.color}18`, borderColor: `${taskLifecycle.color}35` }}>
              {taskLifecycle.label}
            </span>
            {findingProtocol && (
              <span
                className="inline-flex min-w-0 max-w-full items-center break-words rounded-full bg-acc-500/[.08] px-2 py-0.5 font-mono text-[9px] leading-relaxed text-acc-300 ring-1 ring-acc-400/20"
                title={`允许 ${findingProtocol.allowed_profiles.join(", ")}`}
              >
                Finding 协议：{findingProtocol.display_name} · {findingProtocol.source === "task" ? "任务配置" : findingProtocol.source === "project" ? "继承项目" : "继承全局"}
              </span>
            )}
          </div>
          <span className="mt-0.5 block font-mono text-[10px] text-zinc-600">
            {[
              decisionLabel,
              `${findings.length} findings`,
              `${jobs.length} runs`,
            ]
              .filter(Boolean)
              .join(" · ")}
            {msg ? ` · ${msg}` : ""}
          </span>
          {!taskArchived && (
            <span className="mt-1 block text-[10px] leading-4 text-zinc-600">
              暂停会阻止该任务领取和派生新 Job；已运行 Job 会安全收尾，不会强制中断。
            </span>
          )}
          {meta && (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[9px] text-zinc-600 sm:grid-cols-4">
              <LifecycleDatum label="创建" value={relativeTime(meta.created_at)} title={formatTime(meta.created_at)} />
              <LifecycleDatum
                label="开始执行"
                value={startExecValue}
                title={startExecTitle}
                active={Boolean(meta.started_at) && lifecycleActive}
              />
              <LifecycleDatum
                label="生命周期"
                value={executionElapsed}
                title={
                  meta.started_at
                    ? (lifecycleActive ? "从实际开始执行到现在" : "从实际开始执行到终态结束")
                    : "生命周期从实际开始执行起算；尚未开始"
                }
                active={Boolean(meta.started_at) && lifecycleActive}
              />
              <LifecycleDatum
                label="结束"
                value={isScheduled ? "定时等待" : lifecycleActive ? "进行中" : taskLifecycle.endedAt ? formatTime(taskLifecycle.endedAt) : "—"}
                title={taskLifecycle.endedAt && !lifecycleActive ? formatTime(taskLifecycle.endedAt) : undefined}
              />
            </div>
          )}
        </div>
        {/* Canvas 执行门禁是主操作；Hub 收敛控制收进 ⋯。 */}
        <div className="order-2 ml-auto flex shrink-0 items-center gap-1.5 sm:order-none sm:ml-0">
          {!taskArchived && (
            <button
              type="button"
              disabled={convBusy || executionPausing || !meta}
              onClick={() => void toggleTaskExecution()}
              className="flex items-center gap-1.5 rounded-full bg-white/[.04] px-3 py-1.5 text-[11px] text-zinc-300 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.07] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              title={executionPausing
                ? `暂停中，尚有 ${meta?.execution_active_count ?? 0} 个 Job 安全收尾`
                : executionPaused
                  ? "解除任务执行门禁；不会清除定时计划或重试失败 Job"
                  : "阻止领取新 Job；已运行 Job 会安全收尾"}
            >
              {executionPausing ? (
                <><Pause size={12} /> 暂停中 · {meta?.execution_active_count ?? 0} 个收尾</>
              ) : executionPaused ? (
                <><Play size={12} /> 开始</>
              ) : (
                <><Pause size={12} /> 暂停</>
              )}
            </button>
          )}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              disabled={convBusy}
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="更多"
              className="flex size-8 items-center justify-center rounded-full text-zinc-500 ring-1 ring-white/[.06] transition-colors hover:bg-white/[.05] hover:text-zinc-300 disabled:opacity-40"
            >
              <DotsThree size={16} weight="bold" />
            </button>
            {moreOpen && (
              <div className="theme-drawer absolute right-0 top-full z-20 mt-1 min-w-[13rem] overflow-hidden rounded-xl py-1 shadow-xl ring-1 ring-[var(--line-strong)]">
                <button
                  type="button"
                  disabled={convBusy || !convergence}
                  onClick={() => runConvergence(convergence?.hub_paused ? "resume" : "pause")}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {convergence?.hub_paused ? "继续 Hub 自动决策" : "暂停 Hub 自动决策"}
                </button>
                <button
                  type="button"
                  disabled={convBusy || (!canResumeSession && !hasActiveJob)}
                  title={
                    hasActiveJob
                      ? "任务已在执行"
                      : canResumeSession
                        ? "优先使用旧冻结快照重新执行全部启动中断 Worker（同 Job ID、新 Attempt）；身份漂移时会返回 SNAPSHOT_STALE"
                        : "还没有执行记录"
                  }
                  onClick={() => void resumeSession()}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  旧快照继续执行
                </button>
                <button
                  type="button"
                  disabled={convBusy || !hasActiveJob}
                  title={
                    hasActiveJob
                      ? `强制退出 ${activeJobs.length} 个活动 Job（含 running）`
                      : "当前没有活动 Job"
                  }
                  onClick={() => void forceExitActive()}
                  className="block w-full px-3 py-2 text-left text-[12px] text-red-300/90 hover:bg-red-500/[.08] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  强制退出活动 Job{hasActiveJob ? ` (${activeJobs.length})` : ""}
                </button>
                <button
                  type="button"
                  disabled={convBusy}
                  onClick={() => runConvergence("hub-now")}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05]"
                >
                  立即跑一轮 Hub
                </button>
                <button
                  type="button"
                  disabled={convBusy || !canHardRetry}
                  title={
                    hasActiveJob
                      ? "仍有活动 Job，请先取消"
                      : jobs.length === 0
                        ? "还没有执行记录"
                        : "清空本任务全部历史后从意图重跑"
                  }
                  onClick={() => void retryTaskHard()}
                  className="block w-full px-3 py-2 text-left text-[12px] text-red-300/90 hover:bg-red-500/[.08] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  重试任务
                </button>
                <button
                  type="button"
                  disabled={convBusy}
                  onClick={() => runConvergence("drain")}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05]"
                >
                  清理低优先级 verify
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 任务只展示自然语言内容；默认可折叠，避免挤占工作台。 */}
      {(scopeEntries.length > 0 || canEditIntent) && (
        <div className="task-workbench-scope mx-3 mt-2 shrink-0 rounded-2xl bg-white/[.018] ring-1 ring-white/[.04]">
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            aria-expanded={scopeOpen}
            className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left transition-colors hover:bg-white/[.02]"
          >
            <Target size={13} className="shrink-0 text-acc-500" />
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
              {typeof meta?.target_json?.content === "string" ? "任务内容" : "本次审计范围"}
            </span>
            {!scopeOpen && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                {scopeEntries
                  .map(([, v]) => (typeof v === "string" ? v : JSON.stringify(v)))
                  .join(" · ")
                  .replace(/\s+/g, " ")}
              </span>
            )}
            {scopeOpen && <span className="flex-1" />}
            <CaretDown
              size={14}
              className={`shrink-0 text-zinc-600 transition-transform ${scopeOpen ? "rotate-180" : ""}`}
            />
          </button>
          {scopeOpen && (
            <div className="flex flex-wrap gap-2 border-t border-white/[.04] px-4 py-2.5">
              {canEditIntent ? (
                <form
                  className="flex w-full flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveTaskIntent();
                  }}
                >
                  <label className="block">
                    <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                      希望得到什么结果
                    </span>
                    <input
                      value={intentTitle}
                      maxLength={200}
                      onChange={(event) => {
                        setIntentTitle(event.target.value);
                        setIntentDirty(true);
                      }}
                      className="theme-input-surface w-full border px-3.5 py-2.5 text-[13px] leading-6 text-zinc-200 outline-none transition-colors placeholder:text-zinc-600"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                      必要背景、边界与完成标准
                    </span>
                    <textarea
                      value={intentContent}
                      maxLength={20_000}
                      rows={5}
                      onChange={(event) => {
                        setIntentContent(event.target.value);
                        setIntentDirty(true);
                      }}
                      className="theme-input-surface min-h-36 w-full resize-y border px-3.5 py-2.5 text-[13px] leading-6 text-zinc-200 outline-none transition-colors placeholder:text-zinc-600"
                    />
                  </label>
                  <p className="text-[11px] leading-5 text-zinc-600">
                    保存后只影响后续 Hub 读图、新派生 Job 与显式重试；不会改写已在跑或已结束 Job 的冻结快照。
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={intentSaving || !intentDirty || !intentTitle.trim() || !intentContent.trim()}
                      className="rounded-full bg-white/[.06] px-3 py-1.5 text-[11px] text-zinc-200 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.1] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {intentSaving ? "保存中…" : "保存"}
                    </button>
                  </div>
                </form>
              ) : (
                scopeEntries.map(([k, v]) =>
                  typeof v === "string" && k === "内容" ? (
                    <div key={k} className="theme-surface w-full rounded-xl px-4 py-3 ring-1">
                      <MarkdownView markdown={v} />
                    </div>
                  ) : (
                    <span
                      key={k}
                      className="theme-chip inline-flex max-w-full items-baseline gap-1.5 rounded-full px-2.5 py-1 ring-1"
                    >
                      <span className="shrink-0 font-mono text-[9px] text-zinc-600">{k}</span>
                      <span className="truncate text-[10px] text-zinc-300">
                        {typeof v === "string" ? v : JSON.stringify(v)}
                      </span>
                    </span>
                  ),
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* 子 Tab：画布 / 本次发现 / 本次运行 */}
      <div className="task-workbench-tabs mx-3 my-2 flex shrink-0 gap-1 overflow-x-auto rounded-full bg-white/[.018] p-1 ring-1 ring-white/[.045]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[10px] transition-colors ${
              tab === t.key
                ? "bg-white/[.08] text-zinc-100"
                : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
            }`}
          >
            <t.icon size={15} />
            {t.label}
            {typeof t.count === "number" && (
              <span className="font-mono text-[9px] text-zinc-600">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-2xl bg-red-950/25 px-4 py-3 text-[11px] text-red-300 ring-1 ring-red-400/20">
          {error}
        </div>
      )}
      {msg && (
        <div className="mx-3 mb-2 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[11px] text-acc-300 ring-1 ring-acc-400/15">
          {msg}
        </div>
      )}

      {humanInterventions.length > 0 && (
        <HumanInterventionBanner
          items={humanInterventions}
          prefs={interventionPrefs}
          ignoreBusyId={ignoreBusyId}
          onPrefsChange={updateInterventionPrefs}
          onReply={(item) => openHumanReply(humanMessageTargetNodeFromContext(item.node, nodes))}
          onIgnore={(item) => void ignoreIntervention(item)}
          onOpenFinding={(findingId) => setQuery("finding", findingId)}
          onOpenJob={(jobId) => setQuery("job", jobId)}
          imagesHref={`/projects/${projectId}/images`}
        />
      )}

      <div className="task-workbench-content theme-drawer relative mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] ring-1 ring-[var(--line)]">
        <div
          className={taskWorkbenchCanvasLayerClass(tab === "canvas")}
          aria-hidden={tab !== "canvas"}
        >
          <div className="h-full min-h-0 flex-1">
            <CanvasView
              canvasId={canvasId}
              active={tab === "canvas"}
              onData={onCanvasData}
              trace={findingTrace}
              focusNodeId={focusNode}
              findingIdByNodeId={findingIdByNodeId}
              onOpenFact={(factId) => setFactQuery("fact", factId)}
              onTraceFinding={focusFindingTrace}
              onExitTrace={() => {
                const sp = new URLSearchParams(searchParams);
                sp.delete("traceFinding");
                sp.delete("focusNode");
                setSearchParams(sp, { replace: true });
              }}
              onSendHumanMessage={(node) => openHumanReply(humanMessageTargetNodeFromContext(node, nodes))}
              humanMessagePanelCollapsed={interventionPrefs.messagesCollapsed}
              onToggleHumanMessagePanel={() => updateInterventionPrefs({
                ...interventionPrefs,
                messagesCollapsed: !interventionPrefs.messagesCollapsed,
              })}
            />
          </div>
        </div>

        {tab === "report" && (
          <div className={`${taskWorkbenchListPaneClass()} min-h-0 overflow-hidden`}>
            <ReportPanel canvasId={canvasId} />
          </div>
        )}

        {tab === "facts" && (
          <div className={`${taskWorkbenchListPaneClass()} overflow-y-auto p-4 sm:p-6`}>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <SearchableMultiSelect label="验证状态" value={factFilters.verification_status} onChange={(values) => setFactQuery("verification_status", values)} placeholder="全部状态" options={["unverified", "verifying", "verified", "rejected", "needs_human"].map((value) => ({ value, label: value }))} />
              <SearchableMultiSelect label="证据类型" value={factFilters.evidence_kind} onChange={(values) => setFactQuery("evidence_kind", values)} placeholder="全部类型" options={[{ value: "review", label: "独立复核" }, { value: "test", label: "运行测试" }]} />
              <SearchableMultiSelect label="关联 Finding" value={factFilters.finding_id} onChange={(values) => setFactQuery("finding_id", values)} placeholder="全部 Finding" options={factFindingFilterOptions} />
              <SearchableMultiSelect label="产出 Job" value={factFilters.job_id} onChange={(values) => setFactQuery("job_id", values)} placeholder="全部 Job" options={factJobFilterOptions} />
              <span className="font-mono text-[10px] text-zinc-500">已加载 {facts.length} 条</span>
            </div>

            {factsError ? (
              <EmptyState title="事实加载失败" hint={factsError} action={<button type="button" onClick={() => setFactsRefresh((value) => value + 1)} className="rounded-md bg-white/[.06] px-3 py-1.5 text-[11px] text-zinc-300 ring-1 ring-white/[.1]">重新加载</button>} />
            ) : factsLoading ? (
              <div className="p-8 text-center font-mono text-[12px] text-zinc-600">正在加载事实…</div>
            ) : facts.length === 0 ? (
              <EmptyState title="没有匹配的事实" />
            ) : (
              <>
                <DataTable>
                  <table className="w-full min-w-[980px]">
                    <thead>
                      <tr>
                        <th className={thCls}>状态</th>
                        <th className={thCls}>证据 / 结论</th>
                        <th className={thCls}>标题</th>
                        <th className={thCls}>关联 Finding</th>
                        <th className={thCls}>产出 Job</th>
                        <th className={thCls}>时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {facts.map((fact) => (
                        <tr key={fact.id} onClick={() => setFactQuery("fact", fact.id)} className="cursor-pointer transition-colors hover:bg-ink-850/80">
                          <td className={tdCls}><StatusBadge status={fact.verification_status} /></td>
                          <td className={`${tdCls} font-mono text-[11px] text-zinc-400`}>
                            {fact.verification ? <><div>{fact.verification.evidence_kind}</div><div className="mt-0.5 text-zinc-600">{fact.verification.outcome}</div></> : "—"}
                          </td>
                          <td className={`${tdCls} max-w-[360px]`}>
                            <div className="break-words font-medium text-zinc-100">{fact.title}</div>
                            {fact.description && <div className="mt-0.5 line-clamp-2 break-words text-[12px] text-zinc-600">{fact.description}</div>}
                          </td>
                          <td className={tdCls} onClick={(event) => event.stopPropagation()}>
                            {fact.finding ? (
                              <button type="button" onClick={() => setQuery("finding", fact.finding?.id ?? null)} className="max-w-[220px] text-left text-[12px] text-acc-400 hover:text-acc-300">
                                <span className="block truncate">{fact.finding.title}</span>
                                <span className="font-mono text-[9px] text-zinc-600">{fact.finding.id.slice(0, 8)}</span>
                              </button>
                            ) : "—"}
                          </td>
                          <td className={tdCls} onClick={(event) => event.stopPropagation()}>
                            {fact.job ? (
                              <button type="button" onClick={() => setQuery("job", fact.job?.id ?? null)} className="font-mono text-[11px] text-acc-400 hover:text-acc-300">
                                {fact.job.type} · {fact.job.id.slice(0, 8)}
                              </button>
                            ) : fact.job_id ? (
                              <button type="button" onClick={() => setQuery("job", fact.job_id)} className="font-mono text-[11px] text-acc-400 hover:text-acc-300">{fact.job_id.slice(0, 8)}</button>
                            ) : "—"}
                          </td>
                          <td className={`${tdCls} whitespace-nowrap font-mono text-[11px] text-zinc-500`} title={formatTime(fact.created_at)}>{relativeTime(fact.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
                {factsHasMore && (
                  <button type="button" disabled={factsLoadingMore} onClick={() => void loadMoreFacts()} className="mt-3 rounded-full px-3 py-1.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08] disabled:opacity-50">
                    {factsLoadingMore ? "加载中…" : "加载更多事实"}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {tab === "findings" && (
          <div className={`${taskWorkbenchListPaneClass()} overflow-y-auto p-4 sm:p-6`}>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <p className="text-[11px] leading-5 text-zinc-600">只列出本任务产出的发现；当前筛选 {visibleFindings.length} / {findings.length} 条。</p>
              <div className="flex flex-wrap gap-2">
                <SearchableMultiSelect label="PROFILE" value={profiles} onChange={(values) => setMultiQuery("profile", values)} placeholder="全部 profile" options={Array.from(new Set(findings.map((finding) => finding.profile))).sort().map((value) => ({ value, label: value }))} />
                <SearchableMultiSelect label="SEVERITY" value={severities} onChange={(values) => setMultiQuery("severity", values)} placeholder="全部 severity" options={["critical", "high", "medium", "low", "info"].map((value) => ({ value, label: value }))} />
                <SearchableMultiSelect label="VERIFY" value={verifyStatuses} onChange={(values) => setMultiQuery("verify", values)} placeholder="全部验证状态" options={["pending", "verifying", "confirmed", "false_positive", "needs_human"].map((value) => ({ value, label: value }))} />
              </div>
            </div>

            {/* 待人工处理事实：hub 无法自动裁决的 fact，人工确认/排除后才会推进报告 */}
            {humanFacts.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                  待人工处理事实（{humanFacts.length}）
                </div>
                <div className="flex max-w-3xl flex-col gap-2">
                  {humanFacts.map((n) => (
                    <HumanFactCard
                      key={n.id}
                      canvasId={canvasId}
                      node={n}
                      onDone={(m) => {
                        setMsg(m);
                        setTimeout(() => setMsg(null), 3000);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {visibleFindings.length === 0 ? (
              <EmptyState title="本任务暂无发现" hint="审计 Job 产出 finding 后会出现在这里" />
            ) : (
              <>
              <DataTable>
                <table className="w-full min-w-[860px]">
                  <thead>
                    <tr>
                      <th className={thCls}>Severity</th>
                      <th className={thCls}>Profile / Score</th>
                      <th className={thCls}>标题</th>
                      <th className={thCls}>位置</th>
                      <th className={thCls}>验证</th>
                      <th className={thCls}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFindings.map((f) => (
                      <tr key={f.id} onClick={() => setQuery("finding", f.id)} className="cursor-pointer transition-colors hover:bg-ink-850/80">
                        <td className={tdCls}>
                          <SeverityBadge severity={f.severity} />
                        </td>
                        <td className={`${tdCls} font-mono text-[10px] text-zinc-500`}>
                          <div className="text-zinc-300">{f.profile}</div>
                          <div>
                            {f.scoring_json?.base_score == null
                              ? "未评分"
                              : `${String(f.scoring_json.standard)} ${String(f.scoring_json.version)} · ${String(f.scoring_json.base_score)} · ${String(f.scoring_json.exploitability_label ?? "难度未知")}`}
                          </div>
                        </td>
                        <td className={tdCls}>
                          <button type="button" className="text-left font-medium text-zinc-100 hover:text-acc-400">{f.title}</button>
                          {f.summary && (
                            <div className="mt-0.5 line-clamp-2 text-[13px] text-zinc-600">
                              {f.summary}
                            </div>
                          )}
                        </td>
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
              </DataTable>
              {findingsHasMore && (
                <button type="button" onClick={() => void loadMoreFindings()} className="mt-3 rounded-full px-3 py-1.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08]">
                  加载更多发现
                </button>
              )}
              </>
            )}
          </div>
        )}

        {tab === "jobs" && (
          <div className={`${taskWorkbenchListPaneClass()} overflow-y-auto p-4 sm:p-6`}>
            <div className="mb-4 flex flex-col gap-3 rounded-2xl bg-white/[.018] p-3 ring-1 ring-white/[.045] sm:flex-row sm:flex-wrap sm:items-end">
              <SearchableMultiSelect value={jobStatusFilters} onChange={setJobStatusFilters} placeholder="全部状态" options={Array.from(new Set(jobs.map((job) => job.status))).sort().map((value) => ({ value, label: value }))} label="状态" />
              <SearchableMultiSelect value={jobRoleTypeFilters} onChange={setJobRoleTypeFilters} placeholder="全部角色 / 类型" options={jobRoleTypeOptions.map((value) => ({ value, label: value }))} label="角色 / Job 类型" />
              <label className="filter-control min-w-0 flex-1 sm:min-w-[14rem]">
                <span>关键词</span>
                <input value={jobKeyword} onChange={(event) => setJobKeyword(event.target.value)} placeholder="ID、模型、凭据等" className="theme-input-surface w-full border px-3 py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600" />
              </label>
              <div className="flex items-center gap-3 sm:ml-auto">
                <span className="font-mono text-[10px] text-zinc-500">显示 {visibleJobs.length} / {jobs.length}</span>
                {hasJobFilters && <button type="button" onClick={() => { setJobStatusFilters([]); setJobRoleTypeFilters([]); setJobKeyword(""); }} className="font-mono text-[10px] text-acc-400 transition-colors hover:text-acc-300">清空</button>}
              </div>
            </div>
            <p className="mb-4 text-[11px] leading-5 text-zinc-600">
              只列出挂在本任务画布上的 Job（审计 / 验证等），不含其它任务。
            </p>
            {jobs.length === 0 ? (
              <EmptyState title="本任务暂无运行记录" hint="调度领取后会出现在这里" />
            ) : visibleJobs.length === 0 ? (
              <EmptyState title="没有匹配的运行记录" hint="调整状态、角色 / Job 类型或关键词后重试。" action={<button type="button" onClick={() => { setJobStatusFilters([]); setJobRoleTypeFilters([]); setJobKeyword(""); }} className="rounded-full bg-white/[.05] px-3 py-1.5 text-[11px] text-zinc-300 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.08]">清空筛选</button>} />
            ) : (
              <>
              <DataTable>
                <table className="w-full min-w-[800px]">
                  <thead>
                    <tr>
                      <th className={thCls}>状态</th>
                      <th className={thCls}>类型</th>
                      <th className={thCls}>CLI 工具</th>
                      <th className={thCls}>模型</th>
                      <th className={thCls}>开始</th>
                      <th className={thCls}>耗时</th>
                      <th className={thCls}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleJobs.map((j) => (
                      <tr key={j.id} onClick={() => setQuery("job", j.id)} className="cursor-pointer transition-colors hover:bg-ink-850/80">
                        <td className={tdCls}>
                          <StatusBadge status={j.status} />
                          {j.error && (
                            <div
                              className="mt-0.5 max-w-[240px] truncate font-mono text-[12px] text-red-400"
                              title={j.error}
                            >
                              {j.error}
                            </div>
                          )}
                        </td>
                        <td className={`${tdCls} font-mono text-[13px]`}>
                          <div>{j.type}</div>
                          {j.role_name && (
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-600">{j.role_name}</div>
                          )}
                        </td>
                        <td className={`${tdCls} font-mono text-[12px]`}>
                          {j.agent_cli ? (
                            <span className="rounded-md bg-acc-500/10 px-1.5 py-0.5 text-acc-300 ring-1 ring-acc-400/20">
                              {j.agent_cli}
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className={`${tdCls} max-w-[180px] truncate font-mono text-[12px] text-zinc-300`} title={j.model ?? undefined}>
                          {j.model ?? "—"}
                        </td>
                        <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                          {formatTime(j.started_at)}
                        </td>
                        <td
                          className={`${tdCls} whitespace-nowrap font-mono text-[13px] text-zinc-500`}
                          title={j.started_at ? `开始 ${formatTime(j.started_at)}${j.finished_at ? ` · 结束 ${formatTime(j.finished_at)}` : " · 仍在运行"}` : "尚未开始运行"}
                        >
                          {jobElapsed(j)}
                        </td>
                        <td className={tdCls} onClick={(e) => e.stopPropagation()}>
                          <div className="flex flex-wrap gap-1.5">
                          {jobCanReceiveHumanReply(j) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openHumanReply(humanMessageTargetNodeForJobId(j.id, nodes));
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-amber-900/40 px-2.5 py-1 font-mono text-[12px] text-amber-300 transition-colors hover:bg-amber-950/40"
                            >
                              <PaperPlaneTilt size={12} /> 回复
                            </button>
                          )}
                          {openHumanInterventionForJob(nodes, j.id) && (
                            <button
                              type="button"
                              disabled={ignoreBusyId !== null}
                              onClick={(e) => {
                                e.stopPropagation();
                                const item = humanInterventions.find((row) => row.jobId === j.id && row.pending);
                                if (item) void ignoreIntervention(item);
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50"
                            >
                              忽略
                            </button>
                          )}
                          {ACTIVE_JOB.has(j.status) && (
                            <button
                              type="button"
                              disabled={convBusy}
                              onClick={async () => {
                                if (!await confirm({
                                  title: `强制退出 Job「${j.type}」？`,
                                  description: "将立即取消调度并回收沙箱，当前执行不可恢复。",
                                  confirmLabel: "强制退出",
                                  tone: "danger",
                                })) return;
                                setConvBusy(true);
                                try {
                                  await api.cancelJob(j.id, { force: true, reason: "强制退出" });
                                  flash("已强制退出");
                                  const js = await api.jobsPage({ canvas_id: canvasId, limit: 50 });
                                  setJobs(js.items);
                                  setJobsCursor(js.next_cursor);
                                  setJobsHasMore(js.has_more);
                                } catch (e) {
                                  flash(`强制退出失败：${e instanceof Error ? e.message : e}`);
                                } finally {
                                  setConvBusy(false);
                                }
                              }}
                              className="rounded-md border border-red-900/50 px-2.5 py-1 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-50"
                            >
                              强制退出
                            </button>
                          )}
                          {RESUMABLE_JOB.has(j.status) && (
                            <>
                              <button
                                type="button"
                                disabled={convBusy}
                                onClick={() => void rerunOneJob(j, "resume")}
                                title="使用该 Job 创建时的旧冻结快照；身份漂移时拒绝"
                                className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[11px] text-zinc-400 transition-colors hover:border-acc-500/50 hover:text-acc-300 disabled:opacity-50"
                              >
                                旧快照重跑
                              </button>
                              <button
                                type="button"
                                disabled={convBusy}
                                onClick={() => void rerunOneJob(j, "current")}
                                title="按当前 RoleConfig、凭据与运行镜像重冻快照"
                                className="rounded-md border border-acc-500/30 px-2.5 py-1 font-mono text-[11px] text-acc-400 transition-colors hover:bg-acc-500/10 disabled:opacity-50"
                              >
                                当前配置重跑
                              </button>
                            </>
                          )}
                          {!ACTIVE_JOB.has(j.status) && !RESUMABLE_JOB.has(j.status) && (
                            <span className="font-mono text-[12px] text-zinc-700">—</span>
                          )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
              {jobsHasMore && (
                <button type="button" onClick={() => void loadMoreJobs()} className="mt-3 rounded-full px-3 py-1.5 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/25 hover:bg-acc-400/[.08]">
                  加载更多运行
                </button>
              )}
              </>
            )}
          </div>
        )}
      </div>
      {selectedFact && (
        <FactDetailPanel
          canvasId={canvasId}
          factId={selectedFact}
          onClose={() => setFactQuery("fact", null)}
          onOpenFinding={(findingId) => openFromFact("finding", findingId)}
          onOpenJob={(jobId) => openFromFact("job", jobId)}
        />
      )}
      {!selectedFact && selectedFinding && <FindingDetailPanel findingId={selectedFinding} onClose={() => setQuery("finding", null)} />}
      {!selectedFact && selectedJob && (
        <JobDetailPanel
          jobId={selectedJob}
          onClose={() => setQuery("job", null)}
          onSendMessage={() => openHumanReply(humanMessageTargetNodeForJobId(selectedJob, nodes))}
        />
      )}
      {composerOpen && (
        <HumanMessageComposer
          key={composerNode?.id ?? "unresolved"}
          canvasId={canvasId}
          projectId={projectId ?? null}
          selectedNode={composerNode}
          onClose={() => { setComposerOpen(false); setComposerNode(null); setComposerInterventionId(null); }}
          onSent={() => {
            if (composerInterventionId) {
              updateInterventionPrefs({
                ...interventionPrefs,
                repliedIds: [...new Set([...interventionPrefs.repliedIds, composerInterventionId])].slice(-100),
              });
            }
            setComposerOpen(false);
            setComposerNode(null);
            setComposerInterventionId(null);
            flash("消息已写入投递账本");
          }}
        />
      )}
    </div>
  );
}

function LifecycleDatum({ label, value, title, active = false }: { label: string; value: string; title?: string; active?: boolean }) {
  return <span className="min-w-0 truncate" title={title}><span className="text-zinc-700">{label} </span><strong className={active ? "font-medium text-run-400" : "font-medium text-zinc-400"}>{value}</strong></span>;
}
