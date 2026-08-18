import { ArrowUpRight, CircleNotch } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SearchableSelect } from "./SearchableSelect";
import { STATUS_COLOR, SEVERITY_COLOR } from "./semantics";

const STATUS_LABEL: Record<string, string> = {
  pending: "等待中",
  claimed: "已领取",
  provisioning: "准备环境",
  running: "执行中",
  waiting_human: "待人工",
  succeeded: "已完成",
  failed: "失败",
  timeout: "已超时",
  orphan: "已失联",
  cancelled: "已取消",
  confirmed: "已确认",
  unverified: "待验证",
  verifying: "验证中",
  verified: "已验证",
  rejected: "已排除",
  false_positive: "已排除",
  needs_human: "待人工",
  // Finding 人工处置
  open: "待处置",
  accepted: "已接受",
  confirmed_vuln: "漏洞存在",
  rejected_fp: "拒绝误报",
  resolved: "处理完成",
  archived: "已归档",
};

export const DISPOSITION_OPTIONS: { value: string; label: string }[] = [
  { value: "open", label: "待处置" },
  { value: "accepted", label: "接受" },
  { value: "confirmed_vuln", label: "漏洞存在" },
  { value: "rejected_fp", label: "拒绝误报" },
  { value: "resolved", label: "处理完成" },
  { value: "archived", label: "归档" },
];

export function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  const c = STATUS_COLOR[status] ?? "#7f8796";
  return (
    <span
      className="status-badge"
      style={{ color: c, background: `color-mix(in srgb, ${c} 10%, transparent)` }}
      title={status}
    >
      <span className={`status-dot ${["running", "claimed", "provisioning", "verifying"].includes(status) ? "deepsonar-live-dot" : ""}`} style={{ background: c }} />
      {compact ? status : (STATUS_LABEL[status] ?? status)}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const label = severity || "未评分";
  const c = severity ? (SEVERITY_COLOR[severity] ?? "#7f8796") : "#7f8796";
  return (
    <span className="severity-badge" style={{ color: c, background: `color-mix(in srgb, ${c} 10%, transparent)` }}>
      <span className="size-1.5 rounded-full" style={{ background: c }} />
      {label}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow = "OPERATIONS",
}: {
  title: string;
  /** 支持字符串或 React 节点（如标题旁 HelpTip） */
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header deepsonar-reveal">
      <div className="min-w-0 max-w-3xl">
        <div className="eyebrow"><span />{eyebrow}</div>
        <h1>{title}</h1>
        {subtitle != null && subtitle !== "" && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/**
 * 上标说明：默认只显示小标记，悬停 / 聚焦时再展开帮助文案。
 * 气泡经 portal 挂到 body + fixed 定位，避免被父级 overflow:hidden 裁切
 * （例如设置页 rounded + overflow-hidden 卡片标题）。
 */
export function HelpTip({
  children,
  label = "说明",
}: {
  children: ReactNode;
  label?: string;
}) {
  const tipId = useId();
  const markRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; place: "above" | "below" }>({
    top: 0,
    left: 0,
    place: "above",
  });

  const updatePosition = useCallback(() => {
    const mark = markRef.current;
    if (!mark) return;
    const rect = mark.getBoundingClientRect();
    const gap = 8;
    const preferAbove = rect.top > 120;
    const top = preferAbove ? rect.top - gap : rect.bottom + gap;
    const left = Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 12);
    setCoords({
      top,
      left,
      place: preferAbove ? "above" : "below",
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, children]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePosition();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, updatePosition]);

  // Keep open while pointer moves from mark into portal bubble.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 80);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const show = () => {
    cancelClose();
    updatePosition();
    setOpen(true);
  };

  return (
    <span className="help-tip">
      <button
        ref={markRef}
        type="button"
        className="help-tip-mark"
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        onClick={(event) => {
          // Avoid toggling parent <details>/<summary> when the tip sits in a collapsible header.
          event.preventDefault();
          event.stopPropagation();
          if (open) scheduleClose();
          else show();
        }}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onFocus={show}
        onBlur={scheduleClose}
      >
        ?
      </button>
      {open
        && createPortal(
          <span
            ref={bubbleRef}
            id={tipId}
            role="tooltip"
            className={`help-tip-bubble is-portal is-${coords.place}`}
            style={{ top: coords.top, left: coords.left }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * 列表筛选结果计数条：大号数字对比「当前显示 / 全量」，筛选时高亮强调。
 */
export function FilterCountBar({
  filtered,
  total,
  unit = "条",
  active,
  filters,
  onClear,
}: {
  filtered: number;
  total: number;
  unit?: string;
  active: boolean;
  filters?: string[];
  onClear?: () => void;
}) {
  const chips = (filters ?? []).filter(Boolean);
  return (
    <div
      className={`filter-count-bar mb-4 rounded-2xl px-4 py-3.5 ring-1 sm:px-5 sm:py-4 ${
        active
          ? "bg-acc-500/[.09] ring-acc-400/35 shadow-[0_0_0_1px_rgb(var(--accent-rgb)/.12)]"
          : "bg-white/[.035] ring-white/[.08]"
      }`}
      role="status"
      aria-live="polite"
      aria-label={
        active
          ? `筛选后显示 ${filtered} ${unit}，全量 ${total} ${unit}`
          : `全量 ${total} ${unit}`
      }
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {active ? (
          <>
            <div className="flex min-w-0 items-end gap-2.5">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-acc-400/90">
                  筛选后
                </span>
                <span className="font-mono text-[32px] font-semibold leading-none tabular-nums tracking-tight text-acc-300 sm:text-[36px]">
                  {filtered}
                </span>
              </div>
              <span className="mb-1 font-mono text-[18px] text-zinc-600" aria-hidden>
                /
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                  全量
                </span>
                <span className="font-mono text-[32px] font-semibold leading-none tabular-nums tracking-tight text-zinc-100 sm:text-[36px]">
                  {total}
                </span>
              </div>
              <span className="mb-1.5 font-mono text-[12px] text-zinc-500">{unit}</span>
            </div>
            {filtered === 0 && total > 0 && (
              <span className="rounded-full bg-amber-400/10 px-2.5 py-1 font-mono text-[11px] text-amber-200 ring-1 ring-amber-400/25">
                无匹配结果
              </span>
            )}
            {filtered > 0 && filtered < total && (
              <span className="rounded-full bg-white/[.06] px-2.5 py-1 font-mono text-[11px] text-zinc-400 ring-1 ring-white/[.08]">
                已隐藏 {total - filtered} {unit}
              </span>
            )}
          </>
        ) : (
          <div className="flex min-w-0 items-end gap-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                全量
              </span>
              <span className="font-mono text-[32px] font-semibold leading-none tabular-nums tracking-tight text-zinc-100 sm:text-[36px]">
                {total}
              </span>
            </div>
            <span className="mb-1.5 font-mono text-[12px] text-zinc-500">{unit}</span>
          </div>
        )}

        <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-initial">
          {active && chips.length > 0 && (
            <div className="flex max-w-full flex-wrap justify-end gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="theme-chip max-w-[14rem] truncate rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-300 ring-1"
                  title={chip}
                >
                  {chip}
                </span>
              ))}
            </div>
          )}
          {active && onClear && (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-full bg-white/[.08] px-3 py-1.5 font-mono text-[11px] font-medium text-zinc-100 ring-1 ring-white/[.14] transition-colors hover:bg-white/[.14]"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function PrimaryButton({ children, busy, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={busy || props.disabled} className={`primary-button group ${className}`}>
      <span className="primary-button-label">{busy ? "处理中…" : children}</span>
      <span className="button-orb" aria-hidden="true">
        {busy ? <CircleNotch size={15} className="animate-spin" /> : <ArrowUpRight size={15} weight="light" />}
      </span>
    </button>
  );
}

export function SecondaryButton({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`secondary-button ${className}`}><span className="button-label">{children}</span></button>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="surface-shell deepsonar-reveal">
      <div className="empty-state surface-core">
        <div className="empty-orbit" aria-hidden="true"><span /></div>
        <div className="text-[15px] font-medium text-zinc-200">{title}</div>
        {hint && <div className="mt-2 max-w-md text-[13px] leading-6 text-zinc-500">{hint}</div>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="page-scroll" aria-label="正在加载" aria-busy="true"><div className="skeleton-line h-3 w-28" /><div className="skeleton-line mt-4 h-10 w-64 max-w-[70%]" /><div className="skeleton-line mt-3 h-3 w-[440px] max-w-full" /><div className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="surface-shell"><div className="surface-core h-36 p-5"><div className="skeleton-line h-2 w-20" /><div className="skeleton-line mt-7 h-9 w-16" /><div className="skeleton-line mt-3 h-2 w-28" /></div></div>)}</div><div className="surface-shell mt-4"><div className="surface-core p-5">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex items-center gap-4 border-b border-white/[.04] py-4 last:border-0"><div className="skeleton-line size-9 rounded-xl" /><div className="min-w-0 flex-1"><div className="skeleton-line h-3 w-1/3" /><div className="skeleton-line mt-2 h-2 w-1/2" /></div></div>)}</div></div></div>;
}

export function StatCard({ label, value, accent, hint, index = 0 }: { label: string; value: string | number; accent?: string; hint?: string; index?: number }) {
  return (
    <div className="surface-shell stat-shell deepsonar-reveal" style={{ animationDelay: `${index * 70}ms` }}>
      <div className="stat-card surface-core">
        <div className="flex items-center justify-between">
          <span className="metric-label">{label}</span>
          <span className="metric-index">0{index + 1}</span>
        </div>
        <div className="metric-value" style={{ color: accent ?? "var(--text)" }}>{value}</div>
        {hint && <div className="metric-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function FilterSelect({ value, onChange, options, placeholder, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder: string; label?: string }) {
  return <SearchableSelect value={value} onChange={onChange} options={options} placeholder={placeholder} label={label} />;
}

export function SectionHeading({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div><h2>{title}</h2>{meta && <p>{meta}</p>}</div>
      {action}
    </div>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/** Return a non-negative elapsed duration, keeping an unfinished interval live at `now`. */
export function elapsedMs(
  startIso: string | null | undefined,
  endIso?: string | null,
  now = Date.now(),
): number | null {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** Compact Chinese duration for task cards and the workbench timeline. */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

/** Format a task interval using an optional fixed clock for deterministic tests. */
export function formatElapsed(
  startIso: string | null | undefined,
  endIso?: string | null,
  now = Date.now(),
): string {
  return formatDuration(elapsedMs(startIso, endIso, now));
}

export function DataTable({ children }: { children: ReactNode }) {
  return <div className="surface-shell table-shell deepsonar-reveal"><div className="surface-core data-table"><div className="overflow-x-auto">{children}</div></div></div>;
}

export const thCls = "px-4 py-3.5 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500";
export const tdCls = "px-4 py-4 text-[13px] text-zinc-300";
export const trHover = "table-row-hover cursor-pointer";
