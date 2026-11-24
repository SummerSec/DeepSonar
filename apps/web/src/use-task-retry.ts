import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { requireTaskRetryAllowed } from "./composeTaskModel";
import type { ConfirmDialogOptions } from "./components/ConfirmDialog";

export function useTaskRetry(scopeKey: string | undefined, confirm: (options: ConfirmDialogOptions) => Promise<boolean>) {
  const currentScope = useRef({ key: scopeKey });
  if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey };
  const scope = currentScope.current;
  const operation = useRef<AbortController | null>(null);
  const [pendingScope, setPendingScope] = useState<typeof scope | null>(null);
  useEffect(() => () => operation.current?.abort(), [scopeKey]);

  const run = useCallback(async (canvasId: string, options: ConfirmDialogOptions): Promise<boolean> => {
    if (currentScope.current !== scope) return false;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPendingScope(scope);
    const isCurrent = () => currentScope.current === scope && operation.current === controller && !controller.signal.aborted;
    try {
      await requireTaskRetryAllowed(canvasId, controller.signal);
      if (!isCurrent()) return false;
      const accepted = await confirm({ ...options, description: `任务编号 ${canvasId}。${options.description}`, signal: controller.signal });
      if (!accepted || !isCurrent()) return false;
      await api.retryTask(canvasId);
      return isCurrent();
    } catch (error) {
      if (!isCurrent()) return false;
      throw error;
    } finally {
      if (isCurrent()) setPendingScope(null);
    }
  }, [scope, confirm]);
  return { run, busy: pendingScope === scope };
}
