import { readNormalizedStreamPage } from "./evidence.js";
import type { PageEnvelope } from "./pagination.js";
import { subscribeStream, type StreamItem } from "./stream-bus.js";

/**
 * Live process-stream glue: evidence is the catch-up source, the bus is only
 * a non-authoritative delivery cache. Subscribe first, then snapshot evidence,
 * then drain the subscribe/snapshot race by attempt_id:seq.
 */

export function processStreamItemKey(item: { attempt_id?: unknown; seq?: unknown }): string {
  const attempt = typeof item.attempt_id === "string" && item.attempt_id ? item.attempt_id : "legacy";
  return `${attempt}:${Number(item.seq)}`;
}

/** Return pending bus frames that the evidence snapshot did not already include. */
export function mergeCatchupAndPending<T extends { attempt_id?: unknown; seq?: unknown }>(
  snapshotItems: readonly T[],
  pending: readonly T[],
): T[] {
  const seen = new Set(snapshotItems.map((item) => processStreamItemKey(item)));
  const extra: T[] = [];
  for (const item of pending) {
    const key = processStreamItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(item);
  }
  return extra;
}

export async function subscribeThenCatchUp(
  jobId: string,
  options: {
    after?: string | null;
    limit?: number;
    live?: boolean;
    expectLocal?: boolean;
    tail?: boolean;
  },
): Promise<{
  snapshot: PageEnvelope<Record<string, unknown>>;
  unsubscribe: () => void;
  startLive: (onLive: (item: StreamItem) => void) => void;
}> {
  const pending: StreamItem[] = [];
  let liveHandler: ((item: StreamItem) => void) | null = null;
  const unsubscribe = subscribeStream(jobId, (item) => {
    if (liveHandler) liveHandler(item);
    else pending.push(item);
  });
  try {
    const snapshot = await readNormalizedStreamPage(jobId, options);
    return {
      snapshot,
      unsubscribe,
      startLive(onLive) {
        const extras = mergeCatchupAndPending(snapshot.items as StreamItem[], pending);
        liveHandler = onLive;
        for (const item of extras) onLive(item);
        const late = mergeCatchupAndPending(
          [...(snapshot.items as StreamItem[]), ...extras],
          pending,
        );
        for (const item of late) onLive(item);
      },
    };
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
