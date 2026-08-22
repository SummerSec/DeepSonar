import { CalendarBlank, CaretDown, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  HOUR_OPTIONS,
  WEEKDAY_LABELS,
  applyCalendarDate,
  applyCalendarHour,
  applyCalendarTime,
  buildMonthCalendar,
  calendarMonthOf,
  formatDatetimeLocalDisplay,
  isCalendarDateDisabled,
  isCalendarHourDisabled,
  isCalendarMinuteDisabled,
  isCalendarMonthFullyPast,
  minuteChoices,
  shiftCalendarMonth,
  splitDatetimeLocal,
  splitTimeParts,
  todayLocalDate,
} from "./task-schedule";

function TableButton({
  label,
  selected,
  muted,
  today,
  disabled,
  ariaLabel,
  onClick,
}: {
  label: string;
  selected: boolean;
  muted?: boolean;
  today?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={[
        "grid min-h-7 place-items-center rounded-md font-mono text-[12px] leading-none transition-colors",
        disabled ? "cursor-not-allowed opacity-35" : selected ? "bg-acc-500/[.12] text-acc-400" : muted ? "theme-muted hover:bg-[var(--surface-tint-strong)] hover:text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--surface-tint-strong)]",
        today && !selected ? "ring-1 ring-[var(--line-strong)]" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

export function DatetimeLocalPicker({
  value,
  onChange,
  invalid,
  describedBy,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
}) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 340 });
  const { date, time } = splitDatetimeLocal(value);
  const { hour, minute } = splitTimeParts(time);
  const display = formatDatetimeLocalDisplay(value);
  const [view, setView] = useState(() => calendarMonthOf(date));
  const cells = useMemo(() => buildMonthCalendar(view.year, view.month), [view.month, view.year]);
  const minutes = minuteChoices(minute || undefined);
  const stacked = position.width < 460;
  const now = new Date();
  const targetDate = date || todayLocalDate(now);
  const prevMonth = shiftCalendarMonth(view.year, view.month, -1);
  const prevMonthDisabled = isCalendarMonthFullyPast(prevMonth.year, prevMonth.month, now);

  const commit = (next: string | null) => {
    if (next) onChange(next);
  };

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(340, Math.min(rect.width, 520)), Math.max(24, window.innerWidth - 24));
    const estimatedHeight = width < 460 ? 480 : 280;
    const above = window.innerHeight - rect.bottom < estimatedHeight && rect.top > estimatedHeight;
    setPosition({
      top: above ? Math.max(12, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12)),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    popupRef.current?.focus();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    setView(calendarMonthOf(date));
  }, [date, open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`datetime-local-trigger theme-input-surface ${invalid ? "is-invalid" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
        aria-label={display ? `开始时刻 ${display}，打开选择器` : "开始时刻，打开选择器"}
        title={display ? `${display} · 打开选择器` : "打开选择器"}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarBlank size={16} className="shrink-0 text-acc-300" weight="light" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-left">
          <span className="block font-mono text-[13px] leading-6 text-[var(--text)]">
            {display || "选择日期与时刻"}
          </span>
          <span className="theme-muted mt-0.5 block text-[11px] leading-4">打开选择器</span>
        </span>
        <CaretDown size={12} className={`theme-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          role="dialog"
          tabIndex={-1}
          aria-label="选择开始日期与时刻"
          className="datetime-local-popup theme-drawer fixed z-[140] overflow-auto rounded-lg border p-3 shadow-2xl outline-none"
          style={{ top: position.top, left: position.left, width: position.width, maxHeight: `min(520px, calc(100vh - ${position.top + 12}px))` }}
        >
          <div className={stacked ? "flex flex-col gap-3" : "flex gap-3"}>
            <div className={stacked ? "min-w-0" : "w-[252px] shrink-0"}>
              <div className="mb-1.5 flex items-center gap-1">
                <button type="button" disabled={prevMonthDisabled} className={`theme-muted grid size-7 place-items-center rounded-md ${prevMonthDisabled ? "cursor-not-allowed opacity-35" : "hover:bg-[var(--surface-tint-strong)] hover:text-[var(--text)]"}`} aria-label="上个月" onClick={() => setView((current) => shiftCalendarMonth(current.year, current.month, -1))}>
                  <CaretLeft size={12} aria-hidden="true" />
                </button>
                <span className="min-w-0 flex-1 text-center font-mono text-[12px] text-[var(--text)]">{view.year}年{view.month}月</span>
                <button type="button" className="theme-muted grid size-7 place-items-center rounded-md hover:bg-[var(--surface-tint-strong)] hover:text-[var(--text)]" aria-label="下个月" onClick={() => setView((current) => shiftCalendarMonth(current.year, current.month, 1))}>
                  <CaretRight size={12} aria-hidden="true" />
                </button>
              </div>
              <div className="datetime-local-grid is-days mb-1">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label} className="theme-muted grid min-h-5 place-items-center font-mono text-[10px]">{label}</span>
                ))}
              </div>
              <div className="datetime-local-grid is-days" role="grid" aria-label="日期表">
                {cells.map((cell) => {
                  const disabled = isCalendarDateDisabled(cell.date, now);
                  return (
                    <TableButton
                      key={cell.date}
                      label={String(cell.day)}
                      ariaLabel={cell.date}
                      selected={cell.date === date}
                      muted={!cell.inMonth || disabled}
                      today={cell.isToday}
                      disabled={disabled}
                      onClick={() => commit(applyCalendarDate(value, cell.date, now))}
                    />
                  );
                })}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <span className="theme-muted mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em]">时刻 {time || "00:00"}</span>
              <span className="theme-muted mb-1 block font-mono text-[10px]">小时</span>
              <div className="datetime-local-grid is-hours mb-2" role="listbox" aria-label="小时表">
                {HOUR_OPTIONS.map((option) => (
                  <TableButton
                    key={option}
                    label={option}
                    ariaLabel={`${option} 时`}
                    selected={option === hour}
                    disabled={isCalendarHourDisabled(targetDate, option, now)}
                    onClick={() => commit(applyCalendarHour(value, option, targetDate, now))}
                  />
                ))}
              </div>
              <span className="theme-muted mb-1 block font-mono text-[10px]">分钟</span>
              <div className="datetime-local-grid is-minutes" role="listbox" aria-label="分钟表">
                {minutes.map((option) => (
                  <TableButton
                    key={option}
                    label={option}
                    ariaLabel={`${option} 分`}
                    selected={option === minute}
                    disabled={isCalendarMinuteDisabled(targetDate, hour, option, now)}
                    onClick={() => commit(applyCalendarTime(value, `${hour || "00"}:${option}`, targetDate, now))}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
