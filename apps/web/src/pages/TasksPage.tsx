import { AirplaneTakeoff, Archive, ArrowClockwise, ArrowSquareOut, ArrowUpRight, CaretDown, Clock, GitMerge, Pause, Play, Plus, Sparkle, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type CanvasSummary, type EffectiveFindingProtocol, type FindingProtocolConfig, type FindingSummary, type Project } from "../api";
import { FindingProtocolEditor } from "../FindingProtocolEditor";
import { SearchableMultiSelect } from "../SearchableSelect";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { targetLine } from "../TaskList";
import { ACTIVE_TASK_JOB_STATUSES, deriveTaskLifecycle, readScheduledStartAt } from "../task-lifecycle";
import { composeRetryErrorMessage, filterComposeSeedCandidates, MAX_COMPOSE_SEEDS, parseComposeSeedQuery } from "../composeTaskModel";
import { DISPOSITION_OPTIONS, EmptyState, FilterSelect, PageHeader, PageSkeleton, PrimaryButton, SecondaryButton, SeverityBadge, formatElapsed, formatTime, relativeTime } from "../ui";

type Filter = "" | "active" | "findings" | "archived";
/** 立即开始，或指定墙钟时间（按浏览器本地时区选择，提交为 ISO UTC）。 */
type ScheduleMode = "immediate" | "at";
interface PlaneInfo { enabled: boolean; web_url: string; workspace_slug: string; ready_state: string; }
const inputCls =
  "theme-input-surface w-full border px-3.5 py-2.5 text-[13px] leading-6 text-zinc-200 outline-none transition-colors placeholder:text-zinc-600";
const labelCls = "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500";
const SEED_SEVERITY_OPTIONS = [
  { value: "critical", label: "严重" },
  { value: "high", label: "高危" },
  { value: "medium", label: "中危" },
  { value: "low", label: "低危" },
  { value: "info", label: "信息" },
] as const;
const NETWORK_OPTIONS = [
  { value: "project" as const, label: "继承项目设置" },
  { value: "allow" as const, label: "允许出网" },
  { value: "deny" as const, label: "禁止出网" },
];

function formatBeijingTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + "（北京时间）";
  } catch {
    return iso;
  }
}

/** datetime-local value (YYYY-MM-DDTHH:mm) in the user's local wall clock. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Next 08:00 Asia/Shanghai as a local datetime-local string for the picker. */
function nextBeijing8amLocalValue(from: Date = new Date()): string {
  // Asia/Shanghai is fixed UTC+8; 08:00 Beijing = 00:00 UTC same calendar day.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(from).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (hour > 8 || (hour === 8 && (minute > 0 || second > 0))) {
    const pivot = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    pivot.setUTCDate(pivot.getUTCDate() + 1);
    const next = Object.fromEntries(
      fmt.formatToParts(pivot).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    y = Number(next.year);
    m = Number(next.month);
    d = Number(next.day);
  }
  const utc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)); // 08:00 Beijing
  return toDatetimeLocalValue(utc);
}

function parseDatetimeLocalToIso(value: string): string | null {
  if (!value.trim()) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Past wall-clock times cannot schedule a future wake; surface before submit. */
function scheduleTimeIssue(localValue: string, nowMs = Date.now()): string | null {
  if (!localValue.trim()) return "请选择开始时间";
  const iso = parseDatetimeLocalToIso(localValue);
  if (!iso) return "开始时间格式无效";
  if (Date.parse(iso) <= nowMs) {
    return "开始时间不能是过去的时间。历史时刻不会触发调度，请改选未来时间，或改用「立即开始」。";
  }
  return null;
}

function PlaneGuide({ project, plane }: { project: Project; plane: PlaneInfo | null }) {
  const [open, setOpen] = useState(false);
  const projectUrl = plane ? `${plane.web_url}/${plane.workspace_slug}/projects/${project.plane_project_id}/issues/` : null;
  return <div className="surface-shell mb-4"><div className="surface-core overflow-hidden"><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-run-400/[.08] text-run-400 ring-1 ring-run-400/15"><AirplaneTakeoff size={16} weight="light" /></span><span className="min-w-0 flex-1"><strong className="block text-[12px] font-medium text-zinc-300">Plane 自动下发已启用</strong><small className="block truncate text-[10px] text-zinc-600">Issue 进入 {plane?.ready_state ?? "Ready"} 后会进入同一任务闭环</small></span><CaretDown size={14} className={`text-zinc-600 transition-transform ${open ? "rotate-180" : ""}`} /></button>{open && <div className="border-t border-white/[.045] px-5 py-4 text-[11px] leading-6 text-zinc-500"><ol className="list-decimal space-y-1 pl-4"><li>在 Plane 创建 issue，标题写结果目标，描述补充背景和约束。</li><li>把状态移到「{plane?.ready_state ?? "Ready"}」，系统会自动铸造任务画布并开始调度。</li><li>本地创建与 Plane 下发拥有完全相同的证据、验证与报告流程。</li></ol>{projectUrl && <a href={projectUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-acc-300 hover:text-acc-200">打开 Plane 项目<ArrowSquareOut size={12} /></a>}</div>}</div></div>;
}

function NewTaskForm({ projectId, initialSeedIds = [], onDone, onCancel, flash }: { projectId: string; initialSeedIds?: string[]; onDone: (canvasId: string) => void; onCancel: () => void; flash: (message: string) => void }) {
  const [form, setForm] = useState<{ title: string; content: string; kind: "standard" | "compose"; network: "project" | "allow" | "deny"; schedule: ScheduleMode; startAtLocal: string }>({
    title: initialSeedIds.length ? "基于已确认发现继续分析" : "",
    content: initialSeedIds.length ? "结合选中的已确认发现，寻找仍缺失的利用条件、交互关系或可验证的组合链。" : "",
    kind: initialSeedIds.length ? "compose" : "standard",
    network: "project",
    schedule: "immediate",
    startAtLocal: nextBeijing8amLocalValue(),
  });
  const [findingProtocol, setFindingProtocol] = useState<FindingProtocolConfig | null>(null);
  const [effectiveFindingProtocol, setEffectiveFindingProtocol] = useState<EffectiveFindingProtocol | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [seedCandidates, setSeedCandidates] = useState<FindingSummary[]>([]);
  const [selectedSeedIds, setSelectedSeedIds] = useState(() => new Set(initialSeedIds));
  const [seedSearch, setSeedSearch] = useState("");
  const [seedSeverities, setSeedSeverities] = useState<string[]>([]);
  const [seedProfiles, setSeedProfiles] = useState<string[]>([]);
  const [seedDispositions, setSeedDispositions] = useState<string[]>([]);
  const [seedCanvases, setSeedCanvases] = useState<string[]>([]);
  const [seedLoading, setSeedLoading] = useState(initialSeedIds.length > 0);
  /** Tick so past-time warnings update if the form stays open across a boundary. */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    api.settings(projectId).then((settings) => {
      if (active) setEffectiveFindingProtocol(settings.effective_finding_protocol);
    }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (form.kind !== "compose") return;
    let active = true;
    setSeedLoading(true);
    api.findings({ project_id: projectId, verify_status: "confirmed" })
      .then((items) => {
        if (!active) return;
        const eligible = filterComposeSeedCandidates(items);
        setSeedCandidates(eligible);
        setSelectedSeedIds((current) => new Set([...current].filter((id) => eligible.some((item) => item.id === id))));
      })
      .catch((error) => flash(`加载可代入 Finding 失败：${error instanceof Error ? error.message : error}`))
      .finally(() => active && setSeedLoading(false));
    return () => { active = false; };
  }, [form.kind, projectId]);
  useEffect(() => {
    if (form.schedule !== "at") return;
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [form.schedule]);

  const scheduleIssue = form.schedule === "at" ? scheduleTimeIssue(form.startAtLocal, clock) : null;
  const filteredSeedCandidates = useMemo(() => {
    return filterComposeSeedCandidates(seedCandidates, {
      search: seedSearch,
      severities: seedSeverities,
      profiles: seedProfiles,
      dispositions: seedDispositions,
      canvasIds: seedCanvases,
    });
  }, [seedCandidates, seedSearch, seedSeverities, seedProfiles, seedDispositions, seedCanvases]);
  const scheduledPreview = useMemo(() => {
    if (form.schedule !== "at" || scheduleIssue) return null;
    const iso = parseDatetimeLocalToIso(form.startAtLocal);
    return iso ? formatBeijingTime(iso) : null;
  }, [form.schedule, form.startAtLocal, scheduleIssue]);

  return (
    <div className="surface-shell mb-5 deepsonar-reveal">
      <form
        className="surface-core p-5 sm:p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!form.title.trim()) return flash("请写明希望得到的结果");
          if (!form.content.trim()) return flash("请补充必要背景或边界");
          if (form.kind === "compose" && selectedSeedIds.size === 0) {
            return flash("组合续挖任务至少选择 1 条可代入 Finding");
          }
          if (selectedSeedIds.size > MAX_COMPOSE_SEEDS) return flash(`组合续挖任务最多选择 ${MAX_COMPOSE_SEEDS} 条 Finding`);
          let scheduledStartAt: string | undefined;
          if (form.schedule === "at") {
            const issue = scheduleTimeIssue(form.startAtLocal);
            if (issue) return flash(issue);
            const iso = parseDatetimeLocalToIso(form.startAtLocal);
            if (!iso) return flash("请选择合法的开始时间");
            scheduledStartAt = iso;
          }
          setSubmitting(true);
          try {
            const result = await api.createTask(projectId, {
              title: form.title.trim(),
              content: form.content.trim(),
              kind: form.kind,
              ...(form.kind === "compose" ? { seed_finding_ids: [...selectedSeedIds] } : {}),
              ...(form.network === "project" ? {} : { allow_egress: form.network === "allow" }),
              ...(findingProtocol ? { finding_protocol: findingProtocol } : {}),
              ...(scheduledStartAt ? { scheduled_start_at: scheduledStartAt } : {}),
            });
            if (result.scheduled_start_at) {
              flash(`任务已入队，将于 ${formatBeijingTime(result.scheduled_start_at) ?? "计划时间"} 开始执行`);
            } else {
              flash("任务已入队，Hub 正在决定执行路径");
            }
            onDone(result.canvas_id);
          } catch (error) {
            flash(`创建失败：${error instanceof Error ? error.message : error}`);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow"><span />NEW INTENT</div>
            <h2 className="mt-3 text-xl font-medium tracking-[-.035em] text-zinc-100">描述结果，而不是编排步骤</h2>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-6 text-zinc-500">
              系统会从意图推导范围、角色和执行顺序。你只需要提供判断完成与否所必需的信息。
            </p>
          </div>
          <button type="button" onClick={onCancel} className="shrink-0 rounded-full p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200" aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="mt-6 space-y-4">
          <label className="block">
            <span className={labelCls}>希望得到什么结果 *</span>
            <input
              id="task-title"
              autoFocus
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={inputCls}
              placeholder="例如：确认登录与权限链路是否存在可利用绕过"
              maxLength={200}
            />
          </label>

          <label className="block">
            <span className={labelCls}>必要背景、边界与完成标准 *</span>
            <textarea
              id="task-content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className={`${inputCls} min-h-36 resize-y`}
              placeholder="代码位置、关注的业务场景、已知限制，以及你期望看到的证据。无需指定 Agent 或执行步骤。"
              maxLength={20_000}
              rows={5}
            />
          </label>

          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className={`${labelCls} px-0`}>任务类型</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="任务类型">
              <button
                type="button"
                role="radio"
                aria-checked={form.kind === "standard"}
                onClick={() => {
                  setForm({ ...form, kind: "standard" });
                  setSelectedSeedIds(new Set());
                }}
                className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${form.kind === "standard" ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100" : "theme-input-surface text-zinc-400 hover:border-white/[.12]"}`}
              >
                <span className="block text-[13px] font-medium">普通任务</span>
                <span className="mt-0.5 block text-[11px] leading-5 text-zinc-600">从空画布开始，不代入项目历史发现</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.kind === "compose"}
                onClick={() => setForm({ ...form, kind: "compose" })}
                className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${form.kind === "compose" ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100" : "theme-input-surface text-zinc-400 hover:border-white/[.12]"}`}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium"><GitMerge size={15} />组合续挖</span>
                <span className="mt-0.5 block text-[11px] leading-5 text-zinc-600">显式选择已确认发现，在新画布继续找缺口或组合链</span>
              </button>
            </div>
          </fieldset>

          {form.kind === "compose" && (
            <section className="rounded-lg border border-white/[.07] bg-black/15 p-4" aria-labelledby="compose-seeds-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 id="compose-seeds-heading" className="text-[13px] font-medium text-zinc-200">代入 Finding</h3>
                  <p className="mt-0.5 text-[11px] leading-5 text-zinc-600">只列出当前仍可用的 confirmed Finding，提交后摘要随任务冻结。</p>
                </div>
                <span className={`font-mono text-[10px] ${selectedSeedIds.size ? "text-acc-300" : "text-zinc-600"}`}>{selectedSeedIds.size} / {MAX_COMPOSE_SEEDS}</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                <input value={seedSearch} onChange={(event) => setSeedSearch(event.target.value)} className={inputCls} placeholder="标题、位置、标签…" aria-label="搜索可代入 Finding" />
                <SearchableMultiSelect value={seedSeverities} onChange={setSeedSeverities} options={SEED_SEVERITY_OPTIONS} placeholder="全部风险" ariaLabel="按风险筛选种子" className="block [&>button]:w-full" />
                <SearchableMultiSelect value={seedProfiles} onChange={setSeedProfiles} options={[...new Set(seedCandidates.map((finding) => finding.profile))].sort().map((value) => ({ value, label: value }))} placeholder="全部 profile" ariaLabel="按 profile 筛选种子" className="block [&>button]:w-full" />
                <SearchableMultiSelect value={seedDispositions} onChange={setSeedDispositions} options={DISPOSITION_OPTIONS.filter((option) => ["open", "accepted", "confirmed_vuln"].includes(option.value))} placeholder="全部处置" ariaLabel="按处置状态筛选种子" className="block [&>button]:w-full" />
                <SearchableMultiSelect value={seedCanvases} onChange={setSeedCanvases} options={[...new Map(seedCandidates.filter((finding) => finding.canvas_id).map((finding) => [finding.canvas_id!, finding.canvas_title ?? finding.canvas_id!.slice(0, 8)])).entries()].map(([value, label]) => ({ value, label }))} placeholder="全部原任务" ariaLabel="按原任务筛选种子" className="block [&>button]:w-full" />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/[.05] pb-2">
                <span className="text-[10px] text-zinc-600">当前筛选 {filteredSeedCandidates.length} 条</span>
                <button
                  type="button"
                  className="text-[10px] text-acc-300 hover:text-acc-200 disabled:text-zinc-700"
                  disabled={!filteredSeedCandidates.length}
                  onClick={() => setSelectedSeedIds((current) => {
                    const next = new Set(current);
                    for (const finding of filteredSeedCandidates) {
                      if (next.size >= MAX_COMPOSE_SEEDS) break;
                      next.add(finding.id);
                    }
                    return next;
                  })}
                >全选当前结果</button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {seedLoading ? (
                  <div className="py-8 text-center text-[11px] text-zinc-600">正在加载候选…</div>
                ) : filteredSeedCandidates.length === 0 ? (
                  <div className="py-8 text-center text-[11px] text-zinc-600">没有符合当前筛选的可代入 Finding</div>
                ) : filteredSeedCandidates.map((finding) => {
                  const checked = selectedSeedIds.has(finding.id);
                  const disabled = !checked && selectedSeedIds.size >= MAX_COMPOSE_SEEDS;
                  return (
                    <label key={finding.id} className={`flex cursor-pointer items-start gap-3 border-b border-white/[.045] py-3 last:border-0 ${disabled ? "opacity-40" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => setSelectedSeedIds((current) => {
                          const next = new Set(current);
                          if (next.has(finding.id)) next.delete(finding.id);
                          else if (next.size < MAX_COMPOSE_SEEDS) next.add(finding.id);
                          return next;
                        })}
                        className="mt-1 accent-emerald-400"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12px] font-medium text-zinc-300">{finding.title}</span>
                          <SeverityBadge severity={finding.severity} />
                          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[.07] px-1.5 py-0.5 font-mono text-[8px] text-emerald-300">技术 · 已确认</span>
                          <span className="rounded-full border border-amber-400/20 bg-amber-400/[.07] px-1.5 py-0.5 font-mono text-[8px] text-amber-300">处置 · {DISPOSITION_OPTIONS.find((option) => option.value === String(finding.disposition ?? "open"))?.label ?? finding.disposition}</span>
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[9px] text-zinc-600">{finding.profile} · {finding.canvas_title ?? "原任务未知"} · {finding.location ?? "无位置"}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className={`${labelCls} px-0`}>外部网络</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="外部网络">
              {NETWORK_OPTIONS.map((option) => {
                const active = form.network === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setForm({ ...form, network: option.value })}
                    className={`rounded-lg border px-3.5 py-2.5 text-left text-[13px] leading-6 transition-colors ${
                      active
                        ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100"
                        : "theme-input-surface text-zinc-400 hover:border-white/[.12] hover:text-zinc-200"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* 执行时间：立即 / 指定时间 集中在同一面板 */}
          <section className="rounded-xl border border-white/[.06] bg-white/[.015] p-4" aria-labelledby="task-schedule-heading">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-violet-400/[.1] text-violet-300 ring-1 ring-violet-400/20">
                <Clock size={15} weight="light" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 id="task-schedule-heading" className="text-[13px] font-medium text-zinc-200">执行时间</h3>
                <p className="mt-0.5 text-[11px] leading-5 text-zinc-600">
                  立即开始，或指定到点后自动入调度；到点前可在列表里提前「立即开始」。
                </p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="执行时间">
              <button
                type="button"
                role="radio"
                aria-checked={form.schedule === "immediate"}
                onClick={() => setForm({ ...form, schedule: "immediate" })}
                className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                  form.schedule === "immediate"
                    ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100"
                    : "theme-input-surface text-zinc-400 hover:border-white/[.12] hover:text-zinc-200"
                }`}
              >
                <span className="block text-[13px] leading-6">立即开始</span>
                <span className="mt-0.5 block text-[11px] leading-5 text-zinc-600">提交后立刻进入调度</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.schedule === "at"}
                onClick={() => setForm({
                  ...form,
                  schedule: "at",
                  startAtLocal: form.startAtLocal || nextBeijing8amLocalValue(),
                })}
                className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                  form.schedule === "at"
                    ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100"
                    : "theme-input-surface text-zinc-400 hover:border-white/[.12] hover:text-zinc-200"
                }`}
              >
                <span className="block text-[13px] leading-6">指定时间</span>
                <span className="mt-0.5 block text-[11px] leading-5 text-zinc-600">到点后自动开始</span>
              </button>
            </div>

            {form.schedule === "at" && (
              <div className="mt-3 space-y-3 border-t border-white/[.05] pt-3">
                <label className="block">
                  <span className={labelCls}>开始时刻（本机时区）</span>
                  <input
                    type="datetime-local"
                    value={form.startAtLocal}
                    min={toDatetimeLocalValue(new Date(clock))}
                    onChange={(e) => setForm({ ...form, startAtLocal: e.target.value })}
                    aria-invalid={Boolean(scheduleIssue)}
                    aria-describedby={scheduleIssue ? "task-schedule-error" : "task-schedule-hint"}
                    className={`${inputCls} [color-scheme:dark] ${
                      scheduleIssue
                        ? "border-red-500/45 focus:border-red-400/60"
                        : ""
                    }`}
                    required
                  />
                </label>
                {scheduleIssue ? (
                  <div
                    id="task-schedule-error"
                    role="alert"
                    className="flex items-start gap-2 rounded-lg bg-red-500/[.08] px-3 py-2.5 text-[11px] leading-5 text-red-200 ring-1 ring-red-500/25"
                  >
                    <WarningCircle size={14} className="mt-0.5 shrink-0 text-red-300" weight="fill" />
                    <span>{scheduleIssue}</span>
                  </div>
                ) : (
                  <p id="task-schedule-hint" className="text-[11px] leading-5 text-zinc-600">
                    必须选择<strong className="font-medium text-zinc-400">未来</strong>时刻；过去的时间不会触发调度。
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, startAtLocal: nextBeijing8amLocalValue() })}
                    className="rounded-full bg-violet-400/[.08] px-3 py-1.5 text-[11px] text-violet-200 ring-1 ring-violet-400/20 transition-colors hover:bg-violet-400/[.14]"
                  >
                    下一北京时间 08:00
                  </button>
                  {scheduledPreview && (
                    <span className="font-mono text-[10px] text-zinc-500">
                      将于 {scheduledPreview} 开始
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>

          {effectiveFindingProtocol && (
            <FindingProtocolEditor
              value={findingProtocol}
              effective={effectiveFindingProtocol}
              onChange={setFindingProtocol}
              allowInherit
            />
          )}
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-white/[.045] pt-4 sm:flex-row sm:items-center">
          <div className={`flex items-center gap-2 text-[11px] ${scheduleIssue ? "text-red-300" : "text-zinc-600"}`}>
            {scheduleIssue ? (
              <>
                <WarningCircle size={13} className="shrink-0" weight="fill" />
                请修正开始时间后再提交
              </>
            ) : (
              <>
                <Sparkle size={13} className="shrink-0 text-acc-400" />
                {form.schedule === "at" && scheduledPreview
                  ? `将于 ${scheduledPreview} 自动开始；列表可提前启动`
                  : "提交后立即进入任务工作台，执行过程可实时追踪"}
              </>
            )}
          </div>
          <div className="flex gap-2 sm:ml-auto">
            <SecondaryButton type="button" onClick={onCancel}>稍后再说</SecondaryButton>
            <PrimaryButton type="submit" busy={submitting} disabled={Boolean(scheduleIssue)}>
              交给系统
            </PrimaryButton>
          </div>
        </div>
      </form>
    </div>
  );
}

export function TasksPage() {
  const confirm = useConfirmDialog();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSeedIds = useMemo(
    () => parseComposeSeedQuery(searchParams.get("compose")),
    [searchParams],
  );
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [project, setProject] = useState<Project | undefined>();
  const [plane, setPlane] = useState<PlaneInfo | null>(null);
  const [filter, setFilter] = useState<Filter>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(initialSeedIds.length > 0);
  const [clock, setClock] = useState(() => Date.now());
  const flash = (message: string) => { setMsg(message); setTimeout(() => setMsg(null), 3200); };

  // Keep active and total lifecycle counters moving between the five-second API polls.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.projects().then((list) => setProject(list.find((item) => item.id === projectId))).catch(() => {});
    api.planeInfo().then(setPlane).catch(() => {});
    let stop = false;
    const status = filter === "archived" ? ("archived" as const) : ("active" as const);
    const tick = () => api.canvases(projectId, { status }).then((list) => { if (!stop) { setCanvases(list); setError(null); setLoading(false); } }).catch((e) => { if (!stop) { setError(String(e)); setLoading(false); } });
    tick(); const timer = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [projectId, filter]);

  const filtered = useMemo(() => {
    if (filter === "active") return canvases.filter((c) => deriveTaskLifecycle({
      status: c.status,
      activeCount: c.active_count,
      jobCount: c.job_count,
      rootStatus: c.root_status,
      reportStatus: c.report_status,
      endedAt: c.ended_at,
      startedAt: c.started_at,
      scheduledStartAt: readScheduledStartAt(c.target_json),
      executionState: c.execution_state,
      executionActiveCount: c.execution_active_count,
      pendingCount: c.pending_count,
      nowMs: clock,
    }).isActive);
    if (filter === "findings") return canvases.filter((c) => c.finding_count > 0);
    return canvases;
  }, [canvases, filter, clock]);
  if (!projectId) return null;
  if (loading) return <PageSkeleton rows={3} />;
  const activeCount = canvases.filter((canvas) => deriveTaskLifecycle({
    status: canvas.status,
    activeCount: canvas.active_count,
    jobCount: canvas.job_count,
    rootStatus: canvas.root_status,
    reportStatus: canvas.report_status,
    endedAt: canvas.ended_at,
    startedAt: canvas.started_at,
    scheduledStartAt: readScheduledStartAt(canvas.target_json),
    executionState: canvas.execution_state,
    executionActiveCount: canvas.execution_active_count,
    pendingCount: canvas.pending_count,
    nowMs: clock,
  }).isActive).length;
  const findingCount = canvases.reduce((total, canvas) => total + canvas.finding_count, 0);
  const visibleCount = canvases.length;

  return (
    <div className="page-scroll">
      <PageHeader title="任务工作台" eyebrow="INTENT PIPELINE" subtitle="每个任务是一个完整闭环：意图进入 Hub，角色 Agent 产出事实，系统验证后生成可交付报告。" actions={<><FilterSelect value={filter} onChange={(value) => setFilter(value as Filter)} placeholder="全部任务" options={[{ value: "active", label: "正在推进" }, { value: "findings", label: "已有发现" }, { value: "archived", label: "已归档" }]} />{project?.status === "active" && <PrimaryButton onClick={() => setCreating(true)}><Plus size={15} weight="bold" />下达任务</PrimaryButton>}</>} />

      <div className="mb-5 flex flex-wrap gap-2"><span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]"><strong className="mr-2 text-zinc-300">{visibleCount}</strong>{filter === "archived" ? "已归档" : "全部任务"}</span><span className="rounded-full bg-run-400/[.055] px-3 py-2 font-mono text-[9px] text-run-400 ring-1 ring-run-400/10"><strong className="mr-2">{activeCount}</strong>正在推进</span><span className="rounded-full bg-high-500/[.055] px-3 py-2 font-mono text-[9px] text-high-500 ring-1 ring-high-500/10"><strong className="mr-2">{findingCount}</strong>风险发现</span></div>
      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {msg && <div role="status" className="mb-4 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[12px] text-acc-300 ring-1 ring-acc-400/15">{msg}</div>}
      {creating && <NewTaskForm projectId={projectId} initialSeedIds={initialSeedIds} flash={flash} onCancel={() => { setCreating(false); setSearchParams({}, { replace: true }); }} onDone={(canvasId) => navigate(`/projects/${projectId}/tasks/${canvasId}`)} />}
      {project?.plane_project_id && <PlaneGuide project={project} plane={plane} />}

      {filtered.length === 0 ? <EmptyState title={canvases.length ? "没有匹配当前筛选的任务" : "下达第一项任务"} hint={canvases.length ? "切换筛选条件可以查看其它任务。" : "描述你真正需要确认的结果，系统会负责拆解、执行、验证与记账。"} action={!canvases.length && project?.status === "active" && filter !== "archived" && <PrimaryButton onClick={() => setCreating(true)}>描述任务</PrimaryButton>} /> : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((canvas, index) => {
            const scheduledStartAt = readScheduledStartAt(canvas.target_json);
            const lifecycle = deriveTaskLifecycle({
              status: canvas.status,
              activeCount: canvas.active_count,
              jobCount: canvas.job_count,
              rootStatus: canvas.root_status,
              reportStatus: canvas.report_status,
              endedAt: canvas.ended_at,
              startedAt: canvas.started_at,
              scheduledStartAt,
              executionState: canvas.execution_state,
              executionActiveCount: canvas.execution_active_count,
              pendingCount: canvas.pending_count,
              nowMs: clock,
            });
            const isActive = lifecycle.isActive;
            const isScheduled = lifecycle.status === "scheduled";
            const isArchived = lifecycle.status === "archived";
            const executionState = canvas.execution_state;
            const executionPausing = executionState === "pausing";
            const executionPaused = executionState === "paused";
            const isCompose = canvas.target_json?.kind === "compose";
            // 生命周期从「实际开始执行」起算，未真正开始则为「未开始」。
            const executionElapsed = canvas.started_at
              ? formatElapsed(canvas.started_at, lifecycle.isActive ? null : lifecycle.endedAt, clock)
              : "未开始";
            // 开始执行：已开始显示实际时刻；定时未开始显示计划时刻；其它未开始显示 —。
            const startExecValue = canvas.started_at
              ? relativeTime(canvas.started_at)
              : isScheduled && scheduledStartAt
                ? (formatBeijingTime(scheduledStartAt) ?? "定时等待")
                : isActive
                  ? "等待启动"
                  : "—";
            const startExecTitle = canvas.started_at
              ? `实际开始 ${formatTime(canvas.started_at)}`
              : isScheduled && scheduledStartAt
                ? `计划开始 ${formatBeijingTime(scheduledStartAt) ?? scheduledStartAt}`
                : "尚未有 Job 实际开始";
            const scheduleLabel = isScheduled ? formatBeijingTime(scheduledStartAt) : null;
            return (
              <article key={canvas.id} className="surface-shell deepsonar-reveal" style={{ animationDelay: `${index * 40}ms` }}>
                <div className="surface-core flex flex-col gap-2.5 p-3">
                  <div className="flex items-start gap-2">
                    <div
                      className={`relative mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ring-1 ${
                        isArchived
                          ? "bg-zinc-500/[.08] text-zinc-500 ring-white/[.06]"
                          : isScheduled
                            ? "bg-violet-400/[.08] text-violet-300 ring-violet-400/15"
                            : isActive
                              ? "bg-run-400/[.08] text-run-400 ring-run-400/15"
                              : "bg-white/[.03] text-zinc-500 ring-white/[.055]"
                      }`}
                    >
                      {isActive && !isArchived
                        ? <span className="deepsonar-live-dot size-1.5 rounded-full bg-current" />
                        : <span className="size-1.5 rounded-full bg-current" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/projects/${projectId}/tasks/${canvas.id}`}
                        className="line-clamp-1 text-[13px] font-medium leading-4 tracking-[-.01em] text-zinc-100 hover:text-acc-300"
                      >
                        {canvas.title}
                      </Link>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="rounded border border-white/[.07] bg-black/15 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500" title={`完整任务编号：${canvas.id}`}>
                          编号 · {canvas.id.slice(0, 8)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-[10px] leading-4 text-zinc-600">
                        {scheduleLabel
                          ? `计划 ${scheduleLabel} 开始`
                          : targetLine(canvas.target_json) || "任务正在等待范围解析"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span
                        className="rounded-full px-1.5 py-0.5 font-mono text-[8px] ring-1"
                        style={{ color: lifecycle.color, background: `${lifecycle.color}18`, borderColor: `${lifecycle.color}35` }}
                      >
                        {lifecycle.label}
                      </span>
                      {isCompose && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/[.08] px-1.5 py-0.5 font-mono text-[8px] text-amber-300 ring-1 ring-amber-400/20">
                          <GitMerge size={9} aria-hidden="true" />
                          组合续挖
                        </span>
                      )}
                      {canvas.last_job_status && (
                        <span className="font-mono text-[8px] text-zinc-600">Job · {canvas.last_job_status}</span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <Metric label="运行" value={canvas.job_count} />
                    <Metric label="发现" value={canvas.finding_count} tone={canvas.finding_count ? "#ec8c5d" : undefined} />
                    <Metric label="已确认" value={canvas.confirmed_count} tone={canvas.confirmed_count ? "#65e6b4" : undefined} />
                  </div>
                  <div className="grid grid-cols-3 gap-x-2 gap-y-1 border-t border-white/[.045] pt-2">
                    <LifecycleValue label="创建" value={relativeTime(canvas.created_at)} title={formatTime(canvas.created_at)} />
                    <LifecycleValue
                      label="开始执行"
                      value={startExecValue}
                      title={startExecTitle}
                      tone={isScheduled ? "#a78bfa" : canvas.started_at && isActive ? "#65e6b4" : undefined}
                    />
                    <LifecycleValue
                      label="生命周期"
                      value={executionElapsed}
                      title={
                        canvas.started_at
                          ? (lifecycle.isActive ? "从实际开始执行到现在" : "从实际开始执行到终态结束")
                          : "生命周期从实际开始执行起算；尚未开始"
                      }
                      tone={canvas.started_at && isActive ? "#65e6b4" : undefined}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1 border-t border-white/[.045] pt-2">
                <span className="font-mono text-[8px] text-zinc-700">
                  P{canvas.last_job_priority ?? "—"}
                </span>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-0.5">
                  {!isArchived && (
                    <button
                      disabled={executionPausing}
                      title={executionPausing
                        ? `暂停中，尚有 ${canvas.execution_active_count} 个 Job 安全收尾`
                        : executionPaused
                          ? "解除任务暂停；不会清除定时计划或重试失败 Job"
                          : "阻止领取新 Job；已运行 Job 会安全收尾"}
                      onClick={async () => {
                        if (executionPausing) return;
                        try {
                          const result = executionPaused
                            ? await api.startTask(canvas.id)
                            : await api.pauseTask(canvas.id);
                          setCanvases((list) => list.map((item) => item.id === canvas.id ? {
                            ...item,
                            execution_state: result.execution_state,
                            execution_active_count: result.active_count,
                            pending_count: result.pending_count,
                          } : item));
                          if (result.execution_state === "pausing") {
                            flash(`暂停中，尚有 ${result.active_count} 个 Job 安全收尾`);
                          } else {
                            flash(result.execution_state === "paused" ? "任务已暂停" : "任务已开始");
                          }
                        } catch (e) {
                          flash(`任务控制失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-amber-300 transition-colors hover:bg-amber-500/[.08] hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {executionPausing
                        ? <><Pause size={11} /> 暂停中 · {canvas.execution_active_count} 个收尾</>
                        : executionPaused
                          ? <><Play size={11} /> 开始</>
                          : <><Pause size={11} /> 暂停</>}
                    </button>
                  )}
                  {!isArchived && canvas.last_job_id && canvas.last_job_status && ACTIVE_TASK_JOB_STATUSES.has(canvas.last_job_status) && (
                    <button
                      onClick={async () => {
                        try {
                          await api.cancelJob(canvas.last_job_id!);
                          flash("已提交取消请求");
                        } catch (e) {
                          flash(`取消失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                    >
                      <Pause size={11} />
                      取消
                    </button>
                  )}
                  {!isArchived && isScheduled && (
                    <button
                      title="清除定时门禁，立即进入调度"
                      onClick={async () => {
                        try {
                          const r = await api.resumeTaskSession(canvas.id);
                          if (r.action === "start_now") flash(r.message ?? "已立即开始");
                          else if (r.action === "already_running") flash(r.message ?? "任务已在执行");
                          else flash("已提交启动请求");
                        } catch (e) {
                          flash(`立即开始失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-violet-300 transition-colors hover:bg-violet-500/[.08] hover:text-violet-200"
                    >
                      <AirplaneTakeoff size={11} />
                      立即开始
                    </button>
                  )}
                  {!isArchived && !isActive && !executionPaused && canvas.job_count > 0 && (
                    <button
                      title="优先重新执行全部启动中断 Worker（同 Job ID、新 Attempt）；否则恢复单个 Job 或唤醒 Hub"
                      onClick={async () => {
                        try {
                          const r = await api.resumeTaskSession(canvas.id);
                          if (r.action === "already_running") flash(r.message ?? "任务已在执行");
                          else if (r.action === "rerun_interrupted_jobs") {
                            flash(r.message ?? `已重新入队 ${r.jobs?.length ?? 0} 个中断 Worker（同 Job ID、新 Attempt）`);
                          }
                          else if (r.action === "resume_job") flash("已恢复单个可恢复 Job");
                          else if (r.action === "start_now") flash(r.message ?? "已立即开始");
                          else flash("没有中断 Worker；已唤醒 Hub 继续决策");
                        } catch (e) {
                          flash(`继续执行失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <ArrowClockwise size={11} />
                      恢复
                    </button>
                  )}
                  {!isArchived && !isActive && !executionPaused && canvas.job_count > 0 && (
                    <button
                      title="清空历史后从意图重新执行"
                      onClick={async () => {
                        if (!await confirm({
                          title: "清空历史并重新执行？",
                          description: isCompose
                            ? "将清空本画布的运行数据，并按冻结种子重新投影后执行。项目历史 Finding 库存不会删除；若种子已失效，系统会拒绝重试。"
                            : "将删除本任务的全部运行历史和本轮 Finding，并按原意图从零重跑。此操作不可撤销。",
                          confirmLabel: "清空并重试",
                          tone: "danger",
                        })) return;
                        try {
                          await api.retryTask(canvas.id);
                          flash("已清空历史并重新开始执行");
                        } catch (e) {
                          flash(composeRetryErrorMessage(e));
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                    >
                      <ArrowClockwise size={11} />
                      重试
                    </button>
                  )}
                  {!isArchived && (
                    <button
                      title="归档任务：停止调度，历史保留，列表默认隐藏"
                      onClick={async () => {
                        if (!await confirm({
                          title: "归档该任务？",
                          description: "任务将停止调度并从默认列表隐藏，历史数据会保留。",
                          confirmLabel: "归档任务",
                          tone: "danger",
                        })) return;
                        try {
                          const r = await api.archiveTask(canvas.id);
                          flash(r.cancelled_jobs > 0 ? `已归档（取消 ${r.cancelled_jobs} 个活动 Job）` : "已归档");
                          setCanvases((list) =>
                            filter === "archived"
                              ? list
                              : list.filter((c) => c.id !== canvas.id),
                          );
                        } catch (e) {
                          flash(`归档失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <Archive size={11} />
                      归档
                    </button>
                  )}
                  {isArchived && (
                    <button
                      title="取消归档，恢复为可调度任务（需手动恢复会话）"
                      onClick={async () => {
                        try {
                          await api.unarchiveTask(canvas.id);
                          flash("已取消归档");
                          setCanvases((list) =>
                            filter === "archived"
                              ? list.filter((c) => c.id !== canvas.id)
                              : list.map((c) => (c.id === canvas.id ? { ...c, status: "active" as const, archived_at: null } : c)),
                          );
                        } catch (e) {
                          flash(`取消归档失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <Archive size={11} />
                      取消归档
                    </button>
                  )}
                  <button
                    title="永久删除任务及全部运行数据（不可恢复）"
                    onClick={async () => {
                      if (!await confirm({
                        title: `永久删除任务「${canvas.title}」？`,
                        description: "该任务及其全部 Job、Finding、画布与报告都会被永久删除，无法恢复。",
                        confirmLabel: "永久删除",
                        tone: "danger",
                      })) return;
                      try {
                        await api.deleteTask(canvas.id);
                        flash("任务已永久删除");
                        setCanvases((list) => list.filter((c) => c.id !== canvas.id));
                      } catch (e) {
                        flash(`删除失败：${e instanceof Error ? e.message : e}`);
                      }
                    }}
                    className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-1 text-[9px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                  >
                    <Trash size={11} />
                    删除
                  </button>
                  <Link
                    to={`/projects/${projectId}/tasks/${canvas.id}`}
                    className="group ml-0.5 inline-flex items-center gap-1 rounded-full bg-white/[.045] px-2 py-1 text-[9px] text-zinc-300 ring-1 ring-white/[.06] transition-all hover:bg-white/[.075] hover:text-white"
                  >
                    打开
                    <ArrowUpRight
                      size={11}
                      className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    />
                  </Link>
                </div>
              </div>
            </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-white/[.018] px-2 py-1.5 ring-1 ring-white/[.04]">
      <span className="block font-mono text-[7px] tracking-[.12em] text-zinc-700">{label}</span>
      <strong className="mt-0.5 block text-[13px] font-medium tabular-nums leading-none text-zinc-300" style={{ color: tone }}>{value}</strong>
    </div>
  );
}

function LifecycleValue({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <span className="block font-mono text-[7px] uppercase tracking-[.1em] text-zinc-700">{label}</span>
      <strong className="mt-0.5 block truncate text-[10px] font-medium tabular-nums text-zinc-400" style={{ color: tone }} title={title}>{value}</strong>
    </div>
  );
}
