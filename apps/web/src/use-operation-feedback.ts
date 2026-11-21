import { useCallback, useEffect, useId, useRef, useState } from "react";
import { dismissToast, showToast, type ShowToastOptions, type ToastKind } from "./toast";
import { TOAST_DURATIONS } from "./toast-model";
import { useFlashMessage } from "./use-flash-message";

export type OperationFeedbackOptions = Pick<ShowToastOptions, "detail" | "action">;

/** One page owns its inline result and viewport notice, including their cleanup. */
export function useOperationFeedback(scopeKey?: string) {
  const owner = useId();
  const { message, flash: flashMessage, clear: clearMessage } = useFlashMessage();
  const [kind, setKind] = useState<ToastKind>("ok");
  const toastId = useRef<number | null>(null);
  const mounted = useRef(true);
  const currentScope = useRef({ key: scopeKey });
  if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey };
  const scope = currentScope.current;

  const dismissOwnedToast = useCallback(() => {
    if (toastId.current !== null) dismissToast(toastId.current);
    toastId.current = null;
  }, []);

  const clear = useCallback(() => {
    dismissOwnedToast();
    clearMessage();
  }, [clearMessage, dismissOwnedToast]);

  useEffect(() => {
    mounted.current = true;
    clear();
    return () => {
      mounted.current = false;
      dismissOwnedToast();
    };
  }, [scope, clear, dismissOwnedToast]);

  const flash = useCallback((next: string, nextKind: ToastKind = "ok", options: OperationFeedbackOptions = {}) => {
    if (!mounted.current || currentScope.current !== scope || !next.trim()) return;
    dismissOwnedToast();
    setKind(nextKind);
    flashMessage(next, { durationMs: nextKind === "error" ? 0 : TOAST_DURATIONS[nextKind] });
    toastId.current = showToast(next, nextKind, { ...options, owner });
  }, [scope, owner, flashMessage, dismissOwnedToast]);

  return { message, kind, flash, clear };
}
