import postgres from "postgres";
import { config } from "./config.js";
import { inc } from "./metrics.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHARED_ASSET_LOCK_TIMEOUT_MS = 60_000;
type Operation = "prepare" | "cleanup";
type Conflict = "lock_timeout" | "lock_lost" | "stale_attempt" | "active_attempt" | "unknown_owner";

export interface SharedAssetLifecycleScope {
  jobId: string;
  attemptId?: string | null;
  canvasId?: string | null;
}

export interface SharedAssetLifecycleSession {
  query: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

type OpenSession = () => Promise<SharedAssetLifecycleSession>;

export class SharedAssetLifecycleConflictError extends Error {
  readonly code = "SHARED_ASSET_LIFECYCLE_CONFLICT";
  constructor(readonly reason: Conflict) {
    super(`shared assets lifecycle conflict: ${reason}`);
    this.name = "SharedAssetLifecycleConflictError";
  }
}

/** A dedicated connection avoids exhausting the business pool while provision uses SQL. */
async function openSession(): Promise<SharedAssetLifecycleSession> {
  const db = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: config.db.connectTimeoutSec,
    connection: {
      application_name: "deepsonar-shared-assets",
      statement_timeout: SHARED_ASSET_LOCK_TIMEOUT_MS,
      lock_timeout: SHARED_ASSET_LOCK_TIMEOUT_MS,
    },
  });
  try {
    const session = await db.reserve();
    return {
      // SAFETY: postgres.js reserved sessions expose the same tagged-template query interface.
      query: session as unknown as SharedAssetLifecycleSession["query"],
      close: async () => {
        session.release();
        // Never return a possibly still locked session to the shared business pool.
        await db.end({ timeout: 0 });
      },
    };
  } catch (error) {
    try { await db.end({ timeout: 0 }); }
    catch (closeError) {
      throw new AggregateError([error, closeError], "shared assets session acquisition and close failed", { cause: error });
    }
    throw error;
  }
}

function canonicalScope(scope: SharedAssetLifecycleScope): SharedAssetLifecycleScope {
  if (!ID_RE.test(scope.jobId) || (scope.attemptId != null && !ID_RE.test(scope.attemptId))) {
    throw new Error("invalid shared-assets Job/Attempt id");
  }
  return { ...scope, jobId: scope.jobId.toLowerCase(), attemptId: scope.attemptId?.toLowerCase() };
}

function conflict(scope: SharedAssetLifecycleScope, operation: Operation, reason: Conflict, state?: Record<string, unknown>): void {
  inc("deepsonar_shared_assets_lifecycle_conflicts_total", { operation, reason });
  console.warn("[shared-assets] lifecycle conflict", {
    operation, reason, job_id: scope.jobId, attempt_id: scope.attemptId ?? null,
    canvas_id: state?.canvas_id ?? scope.canvasId ?? null,
    active_attempt_id: state?.active_attempt_id ?? null,
    latest_attempt_id: state?.latest_attempt_id ?? null,
  });
}

async function acquireLock(scope: SharedAssetLifecycleScope, operation: Operation, connect: OpenSession) {
  const session = await connect();
  const key = `deepsonar:shared-assets:${scope.jobId}`;
  let backendPid: unknown;
  const started = performance.now();
  try {
    const [locked] = await session.query`
      SELECT pg_backend_pid() AS backend_pid, pg_advisory_lock(hashtextextended(${key}, 0))`;
    backendPid = locked?.backend_pid;
    if (!Number.isInteger(backendPid)) throw new SharedAssetLifecycleConflictError("lock_lost");
  } catch (error) {
    try {
      await session.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "shared assets lock acquisition and close failed", { cause: error });
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "55P03" || code === "57014") {
      conflict(scope, operation, "lock_timeout");
      throw new SharedAssetLifecycleConflictError("lock_timeout");
    }
    throw error;
  } finally {
    inc("deepsonar_shared_assets_lifecycle_lock_wait_seconds_sum", { operation }, (performance.now() - started) / 1000);
    inc("deepsonar_shared_assets_lifecycle_lock_wait_seconds_count", { operation });
  }
  let released = false;
  return {
    async state(): Promise<Record<string, unknown>> {
      if (released) {
        conflict(scope, operation, "lock_lost");
        throw new SharedAssetLifecycleConflictError("lock_lost");
      }
      const [state] = await session.query`
        SELECT pg_backend_pid() AS backend_pid, j.id AS job_id, j.status AS job_status, j.canvas_id,
               latest.id AS latest_attempt_id, active.id AS active_attempt_id, active.cancel_requested, active.phase AS attempt_phase
        FROM (VALUES (1)) AS singleton(n)
        LEFT JOIN jobs j ON j.id = ${scope.jobId}
        LEFT JOIN LATERAL (
          SELECT id FROM job_attempts WHERE job_id = j.id ORDER BY attempt_no DESC LIMIT 1
        ) latest ON true
        LEFT JOIN job_attempts active ON active.job_id = j.id AND active.status = 'active'`;
      // A reconnected socket is not the session that owns our advisory lock.
      if (!state || state.backend_pid !== backendPid) {
        conflict(scope, operation, "lock_lost");
        throw new SharedAssetLifecycleConflictError("lock_lost");
      }
      return state;
    },
    async sandboxState(resourceId: string): Promise<Record<string, unknown>> {
      if (released) throw new SharedAssetLifecycleConflictError("lock_lost");
      const rows = await session.query`
        SELECT pg_backend_pid() AS backend_pid, j.id AS job_id, j.status AS job_status, j.canvas_id,
               j.sandbox_id AS job_sandbox_id, latest.id AS latest_attempt_id,
               active.id AS active_attempt_id, active.sandbox_id AS active_sandbox_id,
               owned.id AS owner_attempt_id, owned.status AS owner_attempt_status
        FROM (VALUES (1)) AS singleton(n)
        LEFT JOIN jobs j ON j.id = ${scope.jobId}
        LEFT JOIN LATERAL (
          SELECT id FROM job_attempts WHERE job_id = j.id ORDER BY attempt_no DESC LIMIT 1
        ) latest ON true
        LEFT JOIN job_attempts active ON active.job_id = j.id AND active.status = 'active'
        LEFT JOIN job_attempts owned ON owned.job_id = j.id
          AND (${scope.attemptId ?? null}::uuid IS NULL OR owned.id = ${scope.attemptId ?? null}::uuid)
          AND (owned.sandbox_id = ${resourceId} OR (owned.sandbox_id IS NULL AND (
            (owned.id = latest.id AND j.sandbox_id = ${resourceId}) OR EXISTS (
              SELECT 1 FROM job_attempt_effects e
              WHERE e.job_id = j.id AND e.attempt_id = owned.id AND e.effect_kind = 'provision'
                AND e.status = 'settled' AND e.settlement_json->>'sandbox_id' = ${resourceId}
                AND e.settlement_json->>'result' IS DISTINCT FROM 'never_started'
                AND e.settlement_json->'external_effect' IS DISTINCT FROM 'false'::jsonb
            )
          )))`;
      if (!rows.length || rows.some(row => row.backend_pid !== backendPid)) {
        throw new SharedAssetLifecycleConflictError("lock_lost");
      }
      // More than one persisted owner is ambiguous, not permission to pick one.
      return rows.length === 1 ? rows[0]! : { ...rows[0], owner_attempt_id: null };
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      let failed = false;
      let failure: unknown;
      try {
        const [row] = await session.query`SELECT pg_backend_pid() AS backend_pid, pg_advisory_unlock(hashtextextended(${key}, 0)) AS unlocked`;
        if (row?.backend_pid !== backendPid || row.unlocked !== true) {
          conflict(scope, operation, "lock_lost");
          throw new SharedAssetLifecycleConflictError("lock_lost");
        }
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      } finally {
        try { await session.close(); }
        catch (error) {
          if (failed) throw new AggregateError([failure, error], "shared assets lock release and close failed", { cause: failure });
          throw error;
        }
      }
    },
  };
}

export interface SharedAssetPreparationLease {
  assertCurrent: () => Promise<void>;
  release: () => Promise<void>;
}

/** Hold through prepare AND sandbox mount handoff; callers must release in finally. No SQL transaction is held/replayed. */
export async function acquireSharedAssetPreparation(
  input: SharedAssetLifecycleScope & { attemptId: string },
  connect: OpenSession = openSession,
): Promise<SharedAssetPreparationLease> {
  const scope = canonicalScope(input);
  const lock = await acquireLock(scope, "prepare", connect);
  const assertCurrent = async (preparingOnly = false) => {
    const state = await lock.state();
    const allowedPhase = preparingOnly ? state.attempt_phase === "preparing"
      : ["preparing", "provision.effect_pending"].includes(String(state.attempt_phase));
    if (state.job_status !== "provisioning" || state.active_attempt_id !== scope.attemptId
      || state.latest_attempt_id !== scope.attemptId || state.cancel_requested !== false || !allowedPhase
      || (scope.canvasId !== undefined && state.canvas_id !== scope.canvasId)) {
      conflict(scope, "prepare", "stale_attempt", state);
      throw new SharedAssetLifecycleConflictError("stale_attempt");
    }
  };
  try {
    await assertCurrent(true); // An existing pending/unknown effect is never prepared/replayed.
    return { assertCurrent: () => assertCurrent(), release: lock.release };
  } catch (error) {
    try {
      await lock.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "shared assets fencing and lock release failed", { cause: error });
    }
    throw error;
  }
}

/**
 * Re-read ownership AFTER the cross-process lock, not from a reaper scan or an old finally.
 * false means skipped, not removed. The callback must still validate daemon-owned labels.
 */
export async function cleanupSharedAssetsForJob(
  input: SharedAssetLifecycleScope,
  remove: (assertCurrent: () => Promise<void>) => Promise<void>,
  connect: OpenSession = openSession,
): Promise<boolean> {
  return cleanupSharedAssets(input, remove, connect, false);
}

/** Inventory labels are untrusted; unlike an explicit lifecycle callback, absence is not ownership. */
export async function cleanupScannedSharedAssetsForJob(
  input: SharedAssetLifecycleScope,
  remove: (assertCurrent: () => Promise<void>) => Promise<void>,
  connect: OpenSession = openSession,
): Promise<boolean> {
  return cleanupSharedAssets(input, remove, connect, true);
}

async function cleanupSharedAssets(
  input: SharedAssetLifecycleScope,
  remove: (assertCurrent: () => Promise<void>) => Promise<void>,
  connect: OpenSession,
  requireKnownJob: boolean,
): Promise<boolean> {
  const scope = canonicalScope(input);
  return withCleanupLock(scope, connect, async (lock) => {
    const state = await lock.state();
    let reason: Conflict | undefined;
    if (requireKnownJob && state.job_id !== scope.jobId) reason = "unknown_owner";
    else if (scope.canvasId !== undefined && state.canvas_id !== scope.canvasId) reason = "unknown_owner";
    else if (scope.attemptId && state.latest_attempt_id !== scope.attemptId) reason = "stale_attempt";
    else if (state.active_attempt_id) reason = "active_attempt";
    else if (["claimed", "provisioning", "running", "waiting_human"].includes(String(state.job_status))) reason = "unknown_owner";
    if (reason) {
      conflict(scope, "cleanup", reason, state);
      return false;
    }
    await remove(async () => {
      const current = await lock.state();
      if (current.job_id !== state.job_id || current.job_status !== state.job_status || current.canvas_id !== state.canvas_id
        || current.latest_attempt_id !== state.latest_attempt_id || current.active_attempt_id
        || current.cancel_requested !== state.cancel_requested) {
        conflict(scope, "cleanup", "stale_attempt", current);
        throw new SharedAssetLifecycleConflictError("stale_attempt");
      }
    });
    return true;
  });
}

/** Delete only a DB-bound sandbox; copied Job/Attempt labels never establish ownership. */
export async function cleanupSandboxResourceForJob(
  input: SharedAssetLifecycleScope & { resourceId: string },
  remove: (assertCurrent: () => Promise<void>) => Promise<void>,
  connect: OpenSession = openSession,
): Promise<boolean> {
  const scope = canonicalScope(input);
  const resourceId = input.resourceId;
  if (!resourceId.trim() || resourceId.length > 255) throw new Error("invalid sandbox resource id");
  return withCleanupLock(scope, connect, async (lock) => {
    const state = await lock.sandboxState(resourceId);
    const allowed = (current: Record<string, unknown>) => current.job_id === scope.jobId
      && (scope.canvasId === undefined || current.canvas_id === scope.canvasId)
      && typeof current.owner_attempt_id === "string" && current.owner_attempt_status !== "active"
      && current.active_sandbox_id !== resourceId
      && !(current.active_attempt_id && current.job_sandbox_id === resourceId)
      && !(current.owner_attempt_id === current.latest_attempt_id
        && ["claimed", "provisioning", "running", "waiting_human"].includes(String(current.job_status)));
    if (!allowed(state)) {
      conflict(scope, "cleanup", "unknown_owner", state);
      return false;
    }
    await remove(async () => {
      const current = await lock.sandboxState(resourceId);
      if (!allowed(current) || Object.keys(state).some(key => current[key] !== state[key])) {
        conflict(scope, "cleanup", "stale_attempt", current);
        throw new SharedAssetLifecycleConflictError("stale_attempt");
      }
    });
    return true;
  });
}

async function withCleanupLock(
  scope: SharedAssetLifecycleScope,
  connect: OpenSession,
  run: (lock: Awaited<ReturnType<typeof acquireLock>>) => Promise<boolean>,
): Promise<boolean> {
  const lock = await acquireLock(scope, "cleanup", connect);
  let failed = false;
  let failure: unknown;
  try {
    return await run(lock);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (error) {
      if (failed) throw new AggregateError([failure, error], "shared assets cleanup and lock release failed", { cause: failure });
      throw error;
    }
  }
}
