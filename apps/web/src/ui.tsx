import { ArrowUpRight, CircleNotch } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
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
  verifying: "验证中",
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

export function SeverityBadge({ severity }: { severity: string }) {
  const c = SEVERITY_COLOR[severity] ?? "#7f8796";
  return (
    <span className="severity-badge" style={{ color: c, background: `color-mix(in srgb, ${c} 10%, transparent)` }}>
      <span className="size-1.5 rounded-full" style={{ background: c }} />
      {severity}
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
  subtitle?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header deepsonar-reveal">
      <div className="min-w-0 max-w-3xl">
        <div className="eyebrow"><span />{eyebrow}</div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function PrimaryButton({ children, busy, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={busy || props.disabled} className={`primary-button group ${className}`}>
      <span>{busy ? "处理中…" : children}</span>
      <span className="button-orb" aria-hidden="true">
        {busy ? <CircleNotch size={15} className="animate-spin" /> : <ArrowUpRight size={15} weight="light" />}
      </span>
    </button>
  );
}

export function SecondaryButton({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`secondary-button ${className}`}>{children}</button>;
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
  return (
    <label className="filter-control">
      {label && <span>{label}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
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

export function DataTable({ children }: { children: ReactNode }) {
  return <div className="surface-shell table-shell deepsonar-reveal"><div className="surface-core data-table"><div className="overflow-x-auto">{children}</div></div></div>;
}

export const thCls = "px-4 py-3.5 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500";
export const tdCls = "px-4 py-4 text-[13px] text-zinc-300";
export const trHover = "table-row-hover cursor-pointer";
