import { processFeatureBatch } from './store.js';

/** Registered with the existing Scheduler maintenance gate; no model or external effects. */
export function startFindingFeatureWorker(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try { await processFeatureBatch(undefined, () => !stopped); }
    catch { /* DB unavailability leaves checkpoint intact; retry after bounded delay. */ }
    if (!stopped) timer = setTimeout(tick, 2000);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
