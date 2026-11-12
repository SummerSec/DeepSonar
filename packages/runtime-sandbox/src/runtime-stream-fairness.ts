import { performance } from "node:perf_hooks";
import { setImmediate as yieldToIo } from "node:timers/promises";

/** Cooperative bounds, not a preemption or latency guarantee for a single callback. */
const MAX_CONTINUOUS_MS = 8;
const MAX_CONTINUOUS_ITEMS = 32;

/** Resolved promises alone can drain a stream entirely in the microtask queue.
 * Yield at bounded consumption boundaries so socket reads, automatic Pong,
 * cancellation and close timers can run. Never pause the socket or drop data. */
export function createRuntimeStreamCheckpoint(): () => Promise<void> | undefined {
  let deadline = performance.now() + MAX_CONTINUOUS_MS;
  let items = 0;
  return () => {
    if (++items < MAX_CONTINUOUS_ITEMS && performance.now() < deadline) return;
    items = 0;
    return yieldToIo().then(() => { deadline = performance.now() + MAX_CONTINUOUS_MS; });
  };
}
