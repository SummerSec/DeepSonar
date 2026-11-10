import { createHash } from "node:crypto";

export interface RuntimeWarning { code: string; detail?: string; occurrences?: number }
const MAX_UNKNOWN_TYPES = 32;
type TypeSummary = { hash: string; chars: number } | { shape: string };
type Bucket = { reason: string; types: TypeSummary[]; count: number; reported: number };

/** Job-run local diagnostics, never authority. No raw type, body or high-cardinality metric label. */
export function createRuntimeWarningReporter(
  adapter: { id: string; version: string },
  emit: ((warning: RuntimeWarning) => void) | undefined,
  redact: (text: string) => string,
) {
  const buckets = new Map<string, Bucket>();
  const summarize = (value: unknown): TypeSummary => {
    if (typeof value === "string") {
      return { hash: createHash("sha256").update(redact(value)).digest("hex").slice(0, 16), chars: value.length };
    }
    return { shape: value === null ? "null" : typeof value };
  };
  const publish = (bucket: Bucket, phase: "first" | "summary") => {
    emit?.({ code: "unknown_runtime_event", occurrences: bucket.count - bucket.reported,
      detail: JSON.stringify({ reason: bucket.reason, adapter: adapter.id, version: adapter.version,
        types: bucket.types, count: bucket.count, phase }) });
    bucket.reported = bucket.count;
  };
  return {
    warn(warning: RuntimeWarning, raw: Record<string, unknown>) {
      if (!emit) return;
      if (warning.code !== "unknown_runtime_event") { emit(warning); return; }
      const reason = warning.detail === "stream_event_type" ? "stream_event_type" : "unrecognized_stream_type";
      const nested = raw.type === "stream_event" ? raw.event : raw.assistantMessageEvent;
      const types = [summarize(raw.type)];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) types.push(summarize((nested as Record<string, unknown>).type));
      let key = `${reason}:${JSON.stringify(types)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        const overflow = buckets.size >= MAX_UNKNOWN_TYPES;
        if (overflow) { key = "overflow"; bucket = buckets.get(key); }
        if (!bucket) {
          bucket = { reason: overflow ? "overflow" : reason, types: overflow ? [{ shape: "overflow" }] : types, count: 1, reported: 0 };
          buckets.set(key, bucket);
          publish(bucket, "first");
          return;
        }
      }
      bucket.count++;
    },
    flush() {
      for (const bucket of buckets.values()) if (bucket.count > bucket.reported) publish(bucket, "summary");
    },
  };
}
