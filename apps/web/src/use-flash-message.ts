import { useCallback, useEffect, useRef, useState } from "react";

/**
 * #967: one owner for a page-local flash message.
 *
 * The pages used to call `setTimeout(() => setMsg(null), N)` inline. That leaks
 * a timer on unmount and, worse, a second flash is cancelled by the *previous*
 * timer — the newer message disappears early. This hook cancels the previous
 * timer, clears on unmount, and keeps the duration configurable per call.
 */
export function useFlashMessage(defaultDurationMs = 3200) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const clear = useCallback(() => {
    stop();
    setMessage(null);
  }, [stop]);

  const flash = useCallback((next: string, options: { durationMs?: number } = {}) => {
    stop();
    setMessage(next);
    const durationMs = options.durationMs ?? defaultDurationMs;
    // `durationMs <= 0` means "keep it until the next flash or an explicit
    // clear": blocking failures must not disappear while the user reads them.
    if (durationMs <= 0) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setMessage(null);
    }, durationMs);
  }, [defaultDurationMs, stop]);

  useEffect(() => stop, [stop]);

  return { message, flash, clear };
}
