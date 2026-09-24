/**
 * Process-stream durability policy (#388 / #359).
 *
 * Roles (verified in code, not assumed):
 * - `events` — semantic ledger; only path that may trigger control side effects
 * - evidence NDJSON/manifest under local `BLOB_DIR` — durable process evidence
 * - `stream-bus` — process-local, non-authoritative realtime delivery cache
 *
 * Persistence ack point: a frame is confirmed only after
 * `JobEvidenceWriter.appendNormalized` resolves (line appended to
 * `attempts/<id>/stream.ndjson`). `publishStream` must wait on that promise.
 * Cursor / dedupe key is `attempt_id:seq`. Catch-up always reads evidence;
 * the bus is never a catch-up source.
 *
 * Cross-replica file-tail is rejected: another replica must not be assumed to
 * see this process's local files unless the deployment mounts a shared
 * `BLOB_DIR` and that visibility is proven. No message broker is introduced.
 */

export const STREAM_WS_UNAVAILABLE_CODE = 4415;
export const STREAM_WS_UNAVAILABLE_REASON = "STREAM_UNAVAILABLE";

export type ProcessStreamTopology =
  | "single_scheduler_local_blob"
  | "multi_scheduler_shared_blob"
  | "multi_scheduler_local_blob";

export interface ProcessStreamTopologyConclusion {
  topology: ProcessStreamTopology;
  supported: boolean;
  /** Whether HTTP/WS catch-up can reconstruct frames whose append already resolved. */
  backfill_confirmed: string;
  /** Whether the process-local bus can push live frames on this replica. */
  live_delivery: string;
  /** Explicit loss / visibility reporting. */
  unpersisted_or_invisible: string;
  /** Product claim ceiling — never zero-loss. */
  claim: string;
}

/**
 * Recoverability conclusions for topologies the product is willing to name.
 * Default production Compose is a single Scheduler with a local volume.
 */
export const PROCESS_STREAM_TOPOLOGY_CONCLUSIONS: readonly ProcessStreamTopologyConclusion[] = [
  {
    topology: "single_scheduler_local_blob",
    supported: true,
    backfill_confirmed:
      "After restart or reconnect, any confirmed frame (appendNormalized resolved) is readable from local BLOB_DIR evidence; terminal gzip handoff remains readable.",
    live_delivery:
      "WS live frames come only from the process-local stream-bus after the persistence ack; ring eviction / backpressure (1013) force HTTP evidence catch-up.",
    unpersisted_or_invisible:
      "Writer pending queue reports unpersisted=true; crash before ack loses that window and must not be claimed as durable.",
    claim: "Confirmed frames recoverable on this node; unpersisted window explicit; no zero-loss claim.",
  },
  {
    topology: "multi_scheduler_shared_blob",
    supported: true,
    backfill_confirmed:
      "Any Scheduler replica that can read the shared BLOB_DIR volume can HTTP-backfill confirmed evidence for the Job.",
    live_delivery:
      "Live bus frames exist only on the lease-holding replica; other replicas keep HTTP evidence poll (or reconnect to the owner). Bus is never cross-replica.",
    unpersisted_or_invisible:
      "Same unpersisted semantics on the owner; non-owner without files yet sees empty local pages until shared writes are visible.",
    claim: "Confirmed frames recoverable on any replica with shared volume visibility; live is owner-local; no zero-loss claim.",
  },
  {
    topology: "multi_scheduler_local_blob",
    supported: false,
    backfill_confirmed:
      "Non-owner replicas cannot read the owner's local BLOB_DIR; process-stream pages return visibility=unavailable (not a silent empty success, not CURSOR_GAP).",
    live_delivery:
      "WS on a non-owner closes with 4415 STREAM_UNAVAILABLE after the unavailable snapshot; clients must not treat empty live as continuity.",
    unpersisted_or_invisible:
      "Semantic events remain in Postgres; process evidence stays on the owner disk until an operator shares the volume or accepts unavailable.",
    claim: "Process-stream continuity is unsupported without shared BLOB_DIR; unavailable is explicit; no zero-loss claim.",
  },
] as const;

export function processStreamTopologyConclusion(
  topology: ProcessStreamTopology,
): ProcessStreamTopologyConclusion {
  const found = PROCESS_STREAM_TOPOLOGY_CONCLUSIONS.find((row) => row.topology === topology);
  if (!found) throw new Error(`unknown process-stream topology: ${topology}`);
  return found;
}

/** WS must fail closed when this replica cannot see expected process evidence. */
export function shouldCloseStreamWsForVisibility(
  visibility: "local" | "unavailable" | undefined,
): boolean {
  return visibility === "unavailable";
}
