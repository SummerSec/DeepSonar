import type { ReactNode } from "react";
import { STATUS_COLOR, SEVERITY_COLOR } from "./nodes";

/** 状态点 + 文案 */
export function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? "#71717a";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2 rounded-full" style={{ background: c }} />
      <span className="font-mono text-[13px]" style={{ color: c }}>
        {status}
      </span>
    </span>
  );
}

/** severity 徽章 */
export function SeverityBadge({ severity }: { severity: string }) {
  const c = SEVERITY_COLOR[severity] ?? "#71717a";
  return (
    <span
      className="inline-flex rounded-full px-2.5 py-0.5 font-mono text-[12px] font-medium uppercase tracking-wide"
      style={{ color: c, background: `${c}18`, border: `1px solid ${c}40` }}
    >
      {severity}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-zinc-100">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[14px] leading-relaxed text-zinc-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-ink-700 bg-ink-900/40 px-6 py-16 text-center">
      <div className="text-[15px] text-zinc-400">{title}</div>
      {hint && <div className="mt-2 max-w-sm text-[14px] leading-relaxed text-zinc-600">{hint}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string | number;
  accent?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[10px] border border-ink-700 bg-ink-900/60 px-4 py-4">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div
        className="mt-2 text-[28px] font-semibold tabular-nums tracking-tight"
        style={{ color: accent ?? "#f4f4f5" }}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[13px] text-zinc-600">{hint}</div>}
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors hover:border-ink-600 focus:border-acc-500"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h 前`;
  const day = Math.floor(hr / 24);
  return `${day}d 前`;
}

/** 表格外壳 */
export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-ink-700 bg-ink-900/40">
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export const thCls =
  "border-b border-ink-800 px-3.5 py-3 text-left font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500";
export const tdCls = "border-b border-ink-800/70 px-3.5 py-3.5 text-[14px] text-zinc-300";
export const trHover = "transition-colors hover:bg-ink-850/80 cursor-pointer";
