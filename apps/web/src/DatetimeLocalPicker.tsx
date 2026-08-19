import { CalendarBlank, CaretDown } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatDatetimeLocalDisplay,
  joinDatetimeLocal,
  splitDatetimeLocal,
} from "./task-schedule";

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
  const dateRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 320 });
  const { date, time } = splitDatetimeLocal(value);
  const display = formatDatetimeLocalDisplay(value);

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 320), Math.max(24, window.innerWidth - 24));
    setPosition({
      top: rect.bottom + 6,
      left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12)),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    dateRef.current?.focus();
  }, [open, updatePosition]);

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
          aria-label="选择开始日期与时刻"
          className="datetime-local-popup theme-drawer fixed z-[140] rounded-lg border p-3 shadow-2xl"
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="theme-muted mb-1 block font-mono text-[10px] uppercase tracking-[0.12em]">日期</span>
              <input
                ref={dateRef}
                type="date"
                value={date}
                required={required}
                onChange={(event) => onChange(joinDatetimeLocal(event.target.value, time))}
                className="theme-input-surface w-full rounded-md border px-2.5 py-2 font-mono text-[13px] outline-none"
              />
            </label>
            <label className="block">
              <span className="theme-muted mb-1 block font-mono text-[10px] uppercase tracking-[0.12em]">时刻</span>
              <input
                type="time"
                step={60}
                value={time}
                required={required}
                onChange={(event) => onChange(joinDatetimeLocal(date, event.target.value))}
                className="theme-input-surface w-full rounded-md border px-2.5 py-2 font-mono text-[13px] outline-none"
              />
            </label>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
