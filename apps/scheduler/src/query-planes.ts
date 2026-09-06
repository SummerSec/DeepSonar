/**
 * Query-plane contract (#400).
 *
 * Every read API belongs to exactly one plane. Clients must not treat a
 * cheaper plane as a substitute for a more durable one.
 */

export const QUERY_PLANES = ["current", "history", "live"] as const;
export type QueryPlane = (typeof QUERY_PLANES)[number];

export interface QueryPlaneContract {
  plane: QueryPlane;
  owner: string;
  examples: readonly string[];
  lifecycle: string;
  append_only: boolean;
  sort_key: string;
  cursor: string;
  retention: string;
  completeness: string;
  truncation: string;
  restart: string;
  multi_replica: string;
  /** True only when this plane is an audit source of truth. */
  audit_source: boolean;
}

export const QUERY_PLANE_CONTRACTS: readonly QueryPlaneContract[] = [
  {
    plane: "current",
    owner: "Scheduler + Postgres row state",
    examples: [
      "GET /dashboard/overview",
      "GET /dashboard/ops snapshot",
      "GET /jobs/:id",
      "GET /canvases/:id",
      "GET /findings/:id",
      "GET /projects/:id/findings/summary",
    ],
    lifecycle: "mutable snapshot of the latest committed row",
    append_only: false,
    sort_key: "entity-specific (updated_at / created_at / status)",
    cursor: "keyset where the list is paginated; otherwise a single snapshot",
    retention: "until the owning row is deleted or archived",
    completeness: "complete for the scoped project/token; empty state is a real zero",
    truncation: "list windows (e.g. findings 500) must set truncated; aggregates are not windowed",
    restart: "survives Scheduler restart; read after commit",
    multi_replica: "shared via Postgres; no process-local cache is authoritative",
    audit_source: true,
  },
  {
    plane: "history",
    owner: "Scheduler + append-only ledgers / cold store",
    examples: [
      "GET /jobs/:id/events",
      "GET /jobs/:id/evidence",
      "GET /jobs/:id/evidence/session",
      "GET /canvases/:id/broadcasts",
      "job_attempts / job_attempt_effects",
      "GET /dashboard/ops throughput",
    ],
    lifecycle: "append-only after ingest/settlement; prior rows are not rewritten",
    append_only: true,
    sort_key: "events: (created_at, id) with job_seq as Job-local order; attempts: attempt_no",
    cursor: "opaque keyset (created_at + id); CURSOR_GAP when below retention floor",
    retention: "events stay with the Job; evidence gzip/manifest is Job-directory cold store",
    completeness: "accepted semantic events are permanent; imported history may omit attempt_id",
    truncation: "bounded pages and evidence limits set truncated/gap; never silently drop",
    restart: "durable; in-flight evidence falls back to synthetic/inflight manifest",
    multi_replica: "shared via Postgres / blob store; not the process stream-bus",
    audit_source: true,
  },
  {
    plane: "live",
    owner: "process-local stream-bus + short-lived WS ticket",
    examples: [
      "GET /jobs/:id/evidence/stream (inflight tail)",
      "WS /ws?job_id=&ticket=",
    ],
    lifecycle: "ephemeral tail of the current process; may lose gaps on restart or another replica",
    append_only: false,
    sort_key: "arrival order in the local ring buffer",
    cursor: "none; HTTP stream then optional WS",
    retention: "in-memory ring; gone after process exit",
    completeness: "best-effort; missing chunks are not reconstructed",
    truncation: "ring overflow drops oldest live frames",
    restart: "empty after restart; recover from history (events / evidence / session)",
    multi_replica: "not shared across Scheduler replicas",
    audit_source: false,
  },
] as const;

export function queryPlaneContract(plane: QueryPlane): QueryPlaneContract {
  const found = QUERY_PLANE_CONTRACTS.find((item) => item.plane === plane);
  if (!found) throw new Error(`unknown query plane: ${plane}`);
  return found;
}

export function isAuditQueryPlane(plane: QueryPlane): boolean {
  return queryPlaneContract(plane).audit_source;
}
