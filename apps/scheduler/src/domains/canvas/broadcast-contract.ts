export const DEFAULT_CANVAS_BROADCAST_LIMIT = 500;
export const MAX_CANVAS_BROADCAST_LIMIT = 1_000;

export function parseCanvasBroadcastLimit(raw: unknown): number {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return DEFAULT_CANVAS_BROADCAST_LIMIT;
  return Math.min(Number(raw), MAX_CANVAS_BROADCAST_LIMIT);
}
