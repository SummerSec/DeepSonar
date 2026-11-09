import { ArrowClockwise, Pause, Play, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProjectTaskQueue } from "../api";
import { useAuth } from "../auth";
import { useConfirmDialog } from "./ConfirmDialog";
import {
  canAccessProjectScope,
  groupProjectTaskQueue,
  projectTaskQueueAction,
  projectTaskQueueBlockReasonLabel,
  projectTaskQueuePauseReasonLabel,
  projectTaskQueueStateLabel,
} from "../task-queue-model";
import { formatTime } from "../ui";

const REFRESH_MS = 15_000;
type ProjectQueueError = { projectId: string; message: string; source: "read" | "mutation" };

export function ProjectTaskQueueEnqueueOption({ checked, disabled, onChange }: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-white/[.06] bg-white/[.015] px-3.5 py-3">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} className="mt-0.5 accent-emerald-400" />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-zinc-200">加入项目串行队列</span>
        <span className="mt-0.5 block text-[10px] leading-5 text-zinc-600">按提交顺序等待前序任务（含报告）完成后再开始；遇到失败或取消时队列会暂停。</span>
      </span>
    </label>
  );
}

export function projectTaskQueueCreatedMessage(requestedQueue: boolean, enqueued: boolean, scheduledTime: string | null): string {
  if (enqueued) return scheduledTime
    ? `任务已加入项目串行队列；轮到且到达计划时间后才会开始（${scheduledTime}）。`
    : "任务已加入项目串行队列，轮到它时才会开始。";
  if (requestedQueue) return "任务已创建，但服务端未确认加入项目串行队列。";
  if (scheduledTime) return `任务已入队，将于 ${scheduledTime} 开始执行`;
  return "任务已入队，Hub 正在决定执行路径";
}

function TaskQueueRow({ projectId, item, order }: { projectId: string; item: ProjectTaskQueue["items"][number]; order?: number }) {
  const reason = projectTaskQueueBlockReasonLabel(item.block_reason);
  const tone = item.state === "succeeded"
    ? "text-run-400"
    : item.state === "failed" || item.state === "cancelled"
      ? "text-high-500"
      : item.state === "active"
        ? "text-acc-300"
        : "text-zinc-400";

  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border border-white/[.045] bg-black/[.08] px-3 py-2.5">
      <span className="mt-0.5 w-7 shrink-0 text-right font-mono text-[10px] text-zinc-600">{order ? `${order}.` : "—"}</span>
      <div className="min-w-0 flex-1">
        <Link to={`/projects/${projectId}/tasks/${item.canvas_id}`} className="block truncate text-[12px] font-medium text-zinc-200 hover:text-acc-300">
          {item.title || item.canvas_id}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
          <span className={`font-mono ${tone}`}>{projectTaskQueueStateLabel(item.state)}</span>
          <span className="font-mono text-zinc-600">加入 {formatTime(item.created_at)}</span>
          {reason && <span className="text-amber-300/90">{reason}</span>}
        </div>
      </div>
    </li>
  );
}

export function ProjectTaskQueuePanel({ projectId }: { projectId: string }) {
  const { me } = useAuth();
  const confirm = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<{ projectId: string; queue: ProjectTaskQueue } | null>(null);
  const [errorState, setErrorState] = useState<ProjectQueueError | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const mutationLock = useRef(false);
  const queueGeneration = useRef(0);
  const currentProjectId = useRef(projectId);
  const [reloadKey, setReloadKey] = useState(0);
  currentProjectId.current = projectId;

  const canRead = canAccessProjectScope(me, projectId, ["tasks:read"]);
  const canControl = canAccessProjectScope(me, projectId, ["jobs:control"]);

  useEffect(() => {
    if (!canRead) return;
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    setLoading(true);
    const refresh = async () => {
      if (!active || mutationLock.current || inFlight) return;
      inFlight = true;
      const generation = queueGeneration.current;
      const request = (async () => {
        try {
          const queue = await api.projectTaskQueue(projectId, controller.signal);
          if (!active || generation !== queueGeneration.current) return;
          if (queue.project_id !== projectId) throw new Error("响应项目与当前项目不匹配");
          setSnapshot({ projectId, queue });
          setErrorState((current) => current?.projectId === projectId && current.source === "mutation" ? current : null);
          setLoading(false);
        } catch (cause) {
          if (active && generation === queueGeneration.current) {
            setErrorState({ projectId, source: "read", message: `读取项目队列失败：${cause instanceof Error ? cause.message : String(cause)}` });
            setLoading(false);
          }
        }
      })();
      try { await request; } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [canRead, projectId, reloadKey]);

  if (!canRead) return null;
  const queue = snapshot?.projectId === projectId ? snapshot.queue : null;
  const error = errorState?.projectId === projectId ? errorState.message : null;
  const groups = queue ? groupProjectTaskQueue(queue) : null;
  const action = queue ? projectTaskQueueAction(queue) : null;
  const unknownEffect = Boolean(queue?.items.some((item) => (item.state === "active" || item.state === "queued") && item.block_reason === "unknown_effect"));
  const visibleItems = queue?.items.length ?? 0;
  const refreshNow = () => {
    setErrorState((current) => current?.projectId === projectId ? null : current);
    setReloadKey((key) => key + 1);
  };

  const changePaused = async (paused: boolean) => {
    if (!queue || mutationLock.current) return;
    const acknowledgingFailure = !paused && projectTaskQueueAction(queue) === "resume-after-failure";
    const failedHeadId = acknowledgingFailure
      ? queue.items.find((item) => (item.state === "active" || item.state === "queued") && (item.block_reason === "task_failed" || item.block_reason === "task_cancelled"))?.id
      : undefined;
    mutationLock.current = true;
    queueGeneration.current += 1;
    setBusy(paused ? "pause" : "resume");
    try {
      if (acknowledgingFailure) {
        if (!failedHeadId) throw new Error("队列失败状态已变化，请刷新后重新确认");
        const confirmed = await confirm({
          title: "跳过已结束的队列任务并继续？",
          description: "当前队列因失败或取消暂停。确认后，已结束的队首任务会记为失败或取消并跳过，再继续后续队列。存在未结清外部效果的任务不能跳过。",
          confirmLabel: "跳过并继续",
          tone: "danger",
        });
        if (!confirmed) return;
      }
      const next = await api.setProjectTaskQueuePaused(projectId, paused, failedHeadId);
      if (currentProjectId.current === projectId) {
        if (next.project_id === projectId) {
          queueGeneration.current += 1;
          setSnapshot({ projectId, queue: next });
        }
        else setErrorState({ projectId, source: "mutation", message: "更新项目队列失败：响应项目与当前项目不匹配" });
        if (next.project_id === projectId) setErrorState(null);
      }
    } catch (cause) {
      if (currentProjectId.current === projectId) setErrorState({ projectId, source: "mutation", message: `更新项目队列失败：${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      mutationLock.current = false;
      setBusy(null);
      setReloadKey((key) => key + 1);
    }
  };

  return (
    <section className="surface-shell mb-5" aria-labelledby="project-task-queue-title">
      <div className="surface-core p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow"><span />PROJECT QUEUE</div>
            <h2 id="project-task-queue-title" className="mt-2 text-[15px] font-medium text-zinc-100">项目串行队列</h2>
            <p className="mt-1 max-w-2xl text-[11px] leading-5 text-zinc-500">队列暂停只阻止新任务开始；当前任务会按自身状态继续，直到完成或遇到需要处理的阻塞。</p>
          </div>
          <div className="flex items-center gap-2">
            {queue && canControl && action && (
              <button
                type="button"
                disabled={busy !== null || unknownEffect && action !== "pause"}
                onClick={() => void changePaused(action === "pause")}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-3 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${action === "pause" ? "border-white/[.08] text-zinc-300 hover:bg-white/[.045]" : "border-acc-400/25 bg-acc-500/[.07] text-acc-300 hover:bg-acc-500/[.12]"}`}
              >
                {action === "pause" ? <Pause size={13} /> : <Play size={13} weight="fill" />}
                {busy ? "处理中…" : action === "pause" ? "暂停队列" : action === "resume-after-failure" ? "确认后跳过并继续" : "继续队列"}
              </button>
            )}
            {canRead && (
              <button type="button" aria-label="刷新项目队列" disabled={loading} onClick={refreshNow} className="grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-white/[.045] hover:text-zinc-200 disabled:opacity-45">
                <ArrowClockwise size={14} className={loading ? "animate-spin" : ""} />
              </button>
            )}
          </div>
        </div>

        {error && <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-high-500/[.08] px-3 py-2.5 text-[11px] leading-5 text-high-500 ring-1 ring-high-500/20"><WarningCircle size={14} className="mt-0.5 shrink-0" />{error}<button type="button" className="ml-auto shrink-0 underline underline-offset-2" onClick={refreshNow}>重试</button></div>}
        {!queue ? (
          !error && <p className="mt-4 text-[11px] text-zinc-600">{loading ? "正在读取队列…" : "当前队列状态暂不可用"}</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
              <span className={`rounded-full px-2.5 py-1 ring-1 ${queue.paused ? "bg-amber-400/[.08] text-amber-300 ring-amber-400/20" : "bg-run-400/[.07] text-run-400 ring-run-400/20"}`}>{queue.paused ? "队列已暂停" : "队列运行中"}</span>
              <span className="text-zinc-600">当前 {groups?.active.length ?? 0} · 等待 {groups?.queued.length ?? 0} · 历史 {groups?.history.length ?? 0}</span>
              {queue.pause_reason && <span className="text-amber-300/90">暂停原因：{projectTaskQueuePauseReasonLabel(queue.pause_reason)}</span>}
            </div>
            {unknownEffect && <p role="status" className="mt-3 rounded-lg bg-amber-400/[.06] px-3 py-2 text-[11px] leading-5 text-amber-200/90">存在未结清的外部效果；系统不会跳过当前任务，请先按效果对账流程处理。{queue.paused ? "队列继续按钮已停用。" : "当前任务仍占用队首。"}</p>}
            <div className="mt-4 space-y-4">
              <QueueSection title="当前占位" items={groups!.active.map((item) => ({ item }))} projectId={projectId} emptyLabel="当前没有占位任务" />
              <QueueSection title="等待顺序" items={groups!.queued.map((item, index) => ({ item, order: index + 1 }))} projectId={projectId} emptyLabel="当前没有等待任务" />
              <QueueSection title="已结束历史" items={groups!.history.map((item) => ({ item }))} projectId={projectId} emptyLabel="尚无已结束任务" />
            </div>
            <p className="mt-3 text-[10px] leading-5 text-zinc-600">
              本次返回 {visibleItems} 项，最多展示 100 项；活动任务和等待顺序优先。{queue.has_more ? "还有更多项目未显示，列表不代表完整历史。" : "历史记录仅显示本次返回范围。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function QueueSection({ title, items, projectId, emptyLabel }: {
  title: string;
  items: Array<{ item: ProjectTaskQueue["items"][number]; order?: number }>;
  projectId: string;
  emptyLabel: string;
}) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-500">{title} · {items.length}</h3>
      {items.length ? (
        <ol className="grid gap-1.5">
          {items.map(({ item, order }) => <TaskQueueRow key={item.id} projectId={projectId} item={item} order={order} />)}
        </ol>
      ) : <p className="text-[10px] text-zinc-700">{emptyLabel}</p>}
    </section>
  );
}
