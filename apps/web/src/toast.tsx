import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "ok" | "error";

type ToastItem = { id: number; message: string; kind: ToastKind };

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(next: ToastItem[]) => void>();

function emit() {
  for (const listener of listeners) listener(items);
}

export function inferToastKind(message: string): ToastKind {
  return /失败|错误|必填|拒绝/.test(message) ? "error" : "ok";
}

export function showToast(message: string, kind: ToastKind = "ok", durationMs = 3200) {
  const text = message.trim();
  if (!text) return;
  const id = nextId++;
  items = [...items, { id, message: text, kind }];
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, durationMs);
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
  if (typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div className="app-toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`app-toast is-${toast.kind}`}>{toast.message}</div>
      ))}
    </div>,
    document.body,
  );
}
