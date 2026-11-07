import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  addToast,
  removeToast,
  TOAST_DURATIONS,
  toastAria,
  type ToastAction,
  type ToastItem,
  type ToastKind,
} from "./toast-model";

export type { ToastKind } from "./toast-model";
export { inferToastKind } from "./toast-model";

export type ShowToastOptions = {
  /** Override the per-kind default lifetime. */
  durationMs?: number;
  /** Technical detail shown behind a "详情" disclosure. */
  detail?: string;
  /** Recovery action rendered as a button. */
  action?: ToastAction;
  /** Keep the toast until the user dismisses it (blocking failures). */
  sticky?: boolean;
};

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

/** Per-toast lifetime bookkeeping so hover/focus can pause the countdown. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const startedAt = new Map<number, number>();
const remaining = new Map<number, number>();

function emit() {
  for (const listener of listeners) listener(items);
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  startedAt.delete(id);
  remaining.delete(id);
}

function schedule(id: number, durationMs: number) {
  clearTimer(id);
  startedAt.set(id, Date.now());
  remaining.set(id, durationMs);
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    startedAt.delete(id);
    remaining.delete(id);
    dismissToast(id);
  }, durationMs));
}

function pruneDetachedTimers() {
  for (const id of [...timers.keys()]) {
    if (!items.some((item) => item.id === id)) clearTimer(id);
  }
}

/**
 * #967: show a toast. `options` accepts a bare number for backwards
 * compatibility with the previous `showToast(message, kind, durationMs)` shape.
 */
export function showToast(
  message: string,
  kind: ToastKind = "ok",
  options: number | ShowToastOptions = {},
) {
  const text = message.trim();
  if (!text) return;
  const resolved: ShowToastOptions = typeof options === "number" ? { durationMs: options } : options;
  const durationMs = resolved.durationMs ?? TOAST_DURATIONS[kind];
  const detail = resolved.detail?.trim();
  const incoming: ToastItem = {
    id: nextId++,
    message: text,
    kind,
    ...(detail ? { detail } : {}),
    ...(resolved.action ? { action: resolved.action } : {}),
    sticky: resolved.sticky ?? false,
    durationMs,
  };

  const result = addToast(items, incoming);
  items = result.items;
  emit();
  pruneDetachedTimers();

  // A duplicate refreshes the existing toast instead of adding a second one.
  const activeId = result.replacedId ?? incoming.id;
  const active = items.find((item) => item.id === activeId);
  if (!active) return;
  if (active.sticky) clearTimer(activeId);
  else schedule(activeId, active.durationMs);
}

export function dismissToast(id: number) {
  clearTimer(id);
  items = removeToast(items, id);
  emit();
}

/** Pause a toast while the pointer or keyboard focus is inside it. */
export function pauseToast(id: number) {
  const started = startedAt.get(id);
  const left = remaining.get(id);
  if (started === undefined || left === undefined) return;
  const spent = Math.max(0, Date.now() - started);
  clearTimer(id);
  remaining.set(id, Math.max(0, left - spent));
  startedAt.set(id, Date.now());
}

export function resumeToast(id: number) {
  const left = remaining.get(id);
  if (left === undefined) return;
  if (left <= 0) {
    dismissToast(id);
    return;
  }
  schedule(id, left);
}

/** Test/utility hook: drop every toast and timer. */
export function clearToasts() {
  for (const id of [...timers.keys()]) clearTimer(id);
  items = [];
  emit();
}

function copyText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value).catch(() => {});
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>(items);

  useEffect(() => {
    listeners.add(setToasts);
    setToasts(items);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  // Do not leave timers running after the host unmounts.
  useEffect(() => () => {
    for (const id of [...timers.keys()]) clearTimer(id);
  }, []);

  if (typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div className="app-toast-stack">
      {toasts.map((toast) => {
        const aria = toastAria(toast.kind);
        return (
          <div
            key={toast.id}
            className={`app-toast is-${toast.kind}`}
            role={aria.role}
            aria-live={aria.live}
            aria-atomic="true"
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
            onFocus={() => pauseToast(toast.id)}
            onBlur={() => resumeToast(toast.id)}
          >
            <div className="app-toast-body">
              <span className="app-toast-message">{toast.message}</span>
              <div className="app-toast-controls">
                {toast.detail && (
                  <button
                    type="button"
                    className="app-toast-control"
                    onClick={() => copyText(toast.detail ?? "")}
                  >
                    复制
                  </button>
                )}
                {toast.action && (
                  <button
                    type="button"
                    className="app-toast-control is-action"
                    onClick={() => {
                      toast.action?.onClick();
                      dismissToast(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
                <button
                  type="button"
                  className="app-toast-control"
                  aria-label="关闭提示"
                  onClick={() => dismissToast(toast.id)}
                >
                  ×
                </button>
              </div>
            </div>
            {toast.detail && (
              <details className="app-toast-detail">
                <summary>详情</summary>
                <pre>{toast.detail}</pre>
              </details>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
