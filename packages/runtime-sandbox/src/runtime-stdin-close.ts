/** execd 没有 stdin EOF 控制帧；terminal_result 后有界等待再 kill，避免 claude/pi 驻留到 Reaper。 */

export const DEFAULT_STDIN_CLOSE_KILL_MS = 8_000;

export function resolveStdinCloseKillMs(value?: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = value ?? Number.parseInt(String(env.DEEPSONAR_STDIN_CLOSE_KILL_MS ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STDIN_CLOSE_KILL_MS;
}

export function createStdinCloseKiller(input: {
  kill: () => void;
  graceMs?: number;
}): { afterClose(reason?: string): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceMs = resolveStdinCloseKillMs(input.graceMs);
  return {
    afterClose(reason) {
      if (reason !== "terminal_result" || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        input.kill();
      }, graceMs);
      timer.unref?.();
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
