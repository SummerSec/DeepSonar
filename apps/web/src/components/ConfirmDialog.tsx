import { WarningCircle, X } from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

type PendingConfirmation = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
  returnFocus: HTMLElement | null;
};

const ConfirmDialogContext = createContext<((options: ConfirmDialogOptions) => Promise<boolean>) | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const finish = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(confirmed);
    window.setTimeout(() => current.returnFocus?.focus(), 0);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    if (pendingRef.current) pendingRef.current.resolve(false);
    const next: PendingConfirmation = {
      ...options,
      resolve,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    pendingRef.current = next;
    setPending(next);
  }), []);

  useEffect(() => {
    if (!pending) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    confirmButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [finish, pending]);

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      {pending && createPortal(
        <div
          className="theme-overlay fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-[3px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) finish(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="theme-drawer w-full max-w-[440px] overflow-hidden rounded-lg border border-[var(--line-strong)] shadow-2xl"
          >
            <div className="theme-drawer-header flex items-start gap-3 border-b px-5 py-4">
              <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${pending.tone === "danger" ? "bg-red-500/10 text-red-300" : "bg-acc-500/10 text-acc-300"}`}>
                <WarningCircle size={18} weight="fill" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-[15px] font-medium text-zinc-100">{pending.title}</h2>
                <p id={descriptionId} className="mt-1 whitespace-pre-line text-[12px] leading-5 text-zinc-500">
                  {pending.description}
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                aria-label="关闭确认对话框"
                onClick={() => finish(false)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[.05] hover:text-zinc-200"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <button
                type="button"
                onClick={() => finish(false)}
                className="min-h-9 rounded-md border border-[var(--line)] px-4 text-[12px] text-zinc-300 transition-colors hover:bg-white/[.04]"
              >
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => finish(true)}
                className={`min-h-9 rounded-md px-4 text-[12px] font-medium text-white transition-colors ${pending.tone === "danger" ? "bg-red-600 hover:bg-red-500" : "bg-acc-500 hover:bg-acc-400"}`}
              >
                {pending.confirmLabel ?? "确认"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  return confirm;
}
