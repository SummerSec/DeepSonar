// #967: pure toast model. Keeping the state transitions here (instead of inside
// the React host) makes dedupe, the visible cap and the aria mapping testable
// with plain `node --test`, which is the only test runner this app uses.

export type ToastKind = "ok" | "warn" | "error";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastItem = {
  id: number;
  message: string;
  kind: ToastKind;
  /** Optional technical detail, rendered behind a native <details> disclosure. */
  detail?: string;
  /** Optional recovery action, e.g. "重试". */
  action?: ToastAction;
  /** Blocking failures stay until the user dismisses them. */
  sticky: boolean;
  durationMs: number;
};

/**
 * How long each kind stays on screen. Failures get the longest budget because
 * they carry a reason and usually a next step; plain success stays short so
 * repeated saves do not accumulate attention cost.
 */
export const TOAST_DURATIONS: Readonly<Record<ToastKind, number>> = Object.freeze({
  ok: 3200,
  warn: 6000,
  error: 8000,
});

/** Bound the stack so a burst of failures cannot cover the working area. */
export const MAX_VISIBLE_TOASTS = 4;

const ERROR_PATTERN = /失败|错误|异常|必填|拒绝|无法|不允许|冲突/;
const WARN_PATTERN = /警告|注意|部分|降级|未知|待确认|未生效/;

/**
 * Keyword fallback for callers that only have a message string. Callers that
 * know the severity should pass it explicitly; this stays for compatibility
 * with the existing 22 call sites.
 */
export function inferToastKind(message: string): ToastKind {
  if (ERROR_PATTERN.test(message)) return "error";
  if (WARN_PATTERN.test(message)) return "warn";
  return "ok";
}

/**
 * Screen-reader severity must match the visual severity: only failures are
 * assertive, everything else is polite so background refreshes do not
 * interrupt the user mid-sentence.
 */
export function toastAria(kind: ToastKind): {
  role: "alert" | "status";
  live: "assertive" | "polite";
} {
  return kind === "error"
    ? { role: "alert", live: "assertive" }
    : { role: "status", live: "polite" };
}

/**
 * Insert `incoming`, merging an identical (kind, message) toast instead of
 * stacking the same failure twice. Returns the id that was refreshed so the
 * caller can restart its timer.
 */
export function addToast(
  items: readonly ToastItem[],
  incoming: ToastItem,
): { items: ToastItem[]; replacedId: number | null } {
  const duplicate = items.find(
    (item) => item.kind === incoming.kind && item.message === incoming.message,
  );
  if (duplicate) {
    const merged = items.map((item) => item.id === duplicate.id
      ? {
        ...item,
        detail: incoming.detail ?? item.detail,
        action: incoming.action ?? item.action,
        sticky: incoming.sticky || item.sticky,
        durationMs: incoming.durationMs,
      }
      : item);
    return { items: merged, replacedId: duplicate.id };
  }

  const appended = [...items, incoming];
  const overflow = appended.length - MAX_VISIBLE_TOASTS;
  if (overflow <= 0) return { items: appended, replacedId: null };

  // Drop the oldest non-sticky toast first; a blocking error is never evicted
  // by a newer transient success.
  const evictable = [...appended].sort(
    (left, right) => Number(left.sticky) - Number(right.sticky) || left.id - right.id,
  );
  const dropped = new Set(evictable.slice(0, overflow).map((item) => item.id));
  return { items: appended.filter((item) => !dropped.has(item.id)), replacedId: null };
}

export function removeToast(items: readonly ToastItem[], id: number): ToastItem[] {
  return items.filter((item) => item.id !== id);
}

/** Remaining lifetime after spending `elapsedMs` on screen; never negative. */
export function remainingLifetime(durationMs: number, elapsedMs: number): number {
  return Math.max(0, durationMs - elapsedMs);
}
