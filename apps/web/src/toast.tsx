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

/** Why a toast is currently held. Hover and keyboard focus are independent. */
export type ToastHold = "hover" | "focus";

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

/** Per-toast lifetime bookkeeping so hover/focus can pause the countdown. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** When the current running segment started; absent while fully paused. */
const startedAt = new Map<number, number>();
/** Milliseconds left, valid while running and while paused. */
const remaining = new Map<number, number>();
/** Active holds per toast. The countdown resumes only when this becomes empty. */
const holds = new Map<number, Set<ToastHold>>();

function emit() {
  for (const listener of listeners) listener(items);
}

function isHeld(id: number): boolean {
  return (holds.get(id)?.size ?? 0) > 0;
}

function clearTimerOnly(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/** Full cleanup for a toast that is leaving. */
function forget(id: number) {
  clearTimerOnly(id);
  startedAt.delete(id);
  remaining.delete(id);
  holds.delete(id);
}

/** Start (or restart) the countdown with an explicit budget. */
function startTimer(id: number, durationMs: number) {
  clearTimerOnly(id);
  startedAt.set(id, Date.now());
  remaining.set(id, durationMs);
  timers.set(id, setTimeout(() => {
    forget(id);
    dismissToast(id);
  }, durationMs));
}

function pruneDetachedTimers() {
  for (const id of [...timers.keys()]) {
    if (!items.some((item) => item.id === id)) forget(id);
  }
}

/**
 * #967: show a toast and return its id so callers can tie a sticky failure to a
 * recovery path and dismiss it once that path succeeds.
 *
 * `options` accepts a bare number for backwards compatibility with the previous
 * `showToast(message, kind, durationMs)` shape.
 */
export function showToast(
  message: string,
  kind: ToastKind = "ok",
  options: number | ShowToastOptions = {},
): number | null {
  const text = message.trim();
  if (!text) return null;
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
  if (!active) return null;
  if (active.sticky) {
    forget(activeId);
    return activeId;
  }
  if (isHeld(activeId)) {
    // Keep the pause. Only the budget is refreshed, and it never grows past the
    // new duration: rescheduling here would restart a countdown the user paused
    // and, because the DOM key is unchanged, nothing would re-trigger the hold.
    const left = remaining.get(activeId) ?? active.durationMs;
    remaining.set(activeId, Math.min(left, active.durationMs));
    return activeId;
  }
  startTimer(activeId, active.durationMs);
  return activeId;
}

export function dismissToast(id: number) {
  forget(id);
  items = removeToast(items, id);
  emit();
}

/**
 * Hold the countdown. Idempotent per reason: pausing twice (or pausing while
 * another reason already holds the toast) never subtracts the paused interval
 * a second time.
 */
export function pauseToast(id: number, reason: ToastHold = "hover") {
  const active = holds.get(id) ?? new Set<ToastHold>();
  if (active.has(reason)) return;
  active.add(reason);
  holds.set(id, active);
  if (active.size > 1) return; // already paused by another interaction

  const started = startedAt.get(id);
  const left = remaining.get(id);
  if (started === undefined || left === undefined) return;
  const spent = Math.max(0, Date.now() - started);
  clearTimerOnly(id);
  startedAt.delete(id);
  remaining.set(id, Math.max(0, left - spent));
}

/** Release one hold. The countdown resumes only when no hold remains. */
export function resumeToast(id: number, reason: ToastHold = "hover") {
  const active = holds.get(id);
  if (!active || !active.has(reason)) return;
  active.delete(reason);
  if (active.size > 0) return; // another interaction still holds it
  holds.delete(id);

  const left = remaining.get(id);
  if (left === undefined) return;
  if (left <= 0) {
    dismissToast(id);
    return;
  }
  startTimer(id, left);
}

/** Test/utility hook: drop every toast and timer. */
export function clearToasts() {
  for (const id of [...timers.keys()]) forget(id);
  for (const id of [...holds.keys()]) forget(id);
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

  // Do not leave timers or holds running after the host unmounts.
  useEffect(() => () => {
    for (const id of [...timers.keys()]) forget(id);
    for (const id of [...holds.keys()]) forget(id);
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
            onMouseEnter={() => pauseToast(toast.id, "hover")}
            onMouseLeave={() => resumeToast(toast.id, "hover")}
            onFocus={() => pauseToast(toast.id, "focus")}
            onBlur={(event) => {
              // Moving focus between controls inside the same toast must not
              // release the hold: the user is still interacting with it.
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              resumeToast(toast.id, "focus");
            }}
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
