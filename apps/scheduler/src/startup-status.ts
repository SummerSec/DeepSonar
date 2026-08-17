/** Process-local dispatcher enablement. Warmup gates startDispatcher(); health reads this. */
let dispatcherEnabled = false;
let dispatcherStartedAt: string | null = null;

export function markDispatcherEnabled(enabled: boolean): void {
  dispatcherEnabled = enabled;
  dispatcherStartedAt = enabled ? new Date().toISOString() : null;
}

export function dispatcherRuntimeStatus(): { enabled: boolean; started_at: string | null } {
  return { enabled: dispatcherEnabled, started_at: dispatcherStartedAt };
}
