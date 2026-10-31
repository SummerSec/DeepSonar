import { DISPATCH_CLAIM_ADVISORY_KEY } from "../../core.js";
import type { sql as Sql } from "../../db.js";
import {
  decidePause,
  decideResume,
  readPlatformClaimsControlRow,
  type PauseDecision,
  type PlatformClaimsControl,
  type PlatformClaimsPauseReason,
  type PlatformClaimsWorkload,
  type ResumeDecision,
} from "./model.js";

type Db = typeof Sql;

/**
 * Read the persistent platform claim gate.
 *
 * The dispatcher calls this inside its claim transaction after taking the
 * dispatch claim advisory lock, so a committed pause linearizes before every
 * later claim on every Scheduler replica.
 */
export async function readPlatformClaimsControl(db: Db): Promise<PlatformClaimsControl> {
  const [row] = await db`
    SELECT claims_paused, claims_pause_reason, claims_pause_note, claims_paused_by, claims_paused_at
    FROM global_settings WHERE id = 'global'`;
  return readPlatformClaimsControlRow(row as Record<string, unknown> | undefined);
}

export async function loadPlatformClaimsWorkload(db: Db): Promise<PlatformClaimsWorkload> {
  const [jobs] = await db`
    SELECT
      COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
      COUNT(*) FILTER (WHERE status = 'provisioning')::int AS provisioning,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'waiting_human')::int AS waiting_human
    FROM jobs
    WHERE status IN ('pending', 'claimed', 'provisioning', 'running', 'waiting_human')`;
  // Terminal Attempt status does not prove its external effects have settled.
  const [effects] = await db`
    SELECT
      COUNT(DISTINCT e.attempt_id) FILTER (WHERE e.status = 'effect_pending')::int AS effect_pending_attempts,
      COUNT(DISTINCT e.attempt_id) FILTER (WHERE e.status = 'unknown')::int AS unknown_effect_attempts
    FROM job_attempt_effects e
    WHERE e.status IN ('effect_pending', 'unknown')`;
  const claimed = Number(jobs?.claimed ?? 0);
  const provisioning = Number(jobs?.provisioning ?? 0);
  const running = Number(jobs?.running ?? 0);
  return {
    in_flight: { claimed, provisioning, running, total: claimed + provisioning + running },
    pending: Number(jobs?.pending ?? 0),
    waiting_human: Number(jobs?.waiting_human ?? 0),
    effect_pending_attempts: Number(effects?.effect_pending_attempts ?? 0),
    unknown_effect_attempts: Number(effects?.unknown_effect_attempts ?? 0),
  };
}

export type PlatformClaimsMutation<D> =
  | { kind: "missing" }
  | { kind: "decided"; decision: D; before: PlatformClaimsControl; after: PlatformClaimsControl };

async function lockedControl(tx: Db): Promise<PlatformClaimsControl> {
  // Same advisory key as claimPendingJobs(): a claim already in flight finishes
  // first, and no claim can start between this read and the commit.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
  const [row] = await tx`
    SELECT claims_paused, claims_pause_reason, claims_pause_note, claims_paused_by, claims_paused_at
    FROM global_settings WHERE id = 'global'
    FOR UPDATE`;
  return readPlatformClaimsControlRow(row as Record<string, unknown> | undefined);
}

export async function pausePlatformClaims(
  db: Db,
  input: { reason: PlatformClaimsPauseReason; note: string | null; actor: string },
): Promise<PlatformClaimsMutation<PauseDecision>> {
  return db.begin(async (txRaw) => {
    // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
    const tx = txRaw as unknown as Db;
    const before = await lockedControl(tx);
    if (before.missing) return { kind: "missing" as const };
    const decision = decidePause(before, input.reason);
    if (decision.kind !== "apply") return { kind: "decided" as const, decision, before, after: before };
    const [row] = await tx`
      UPDATE global_settings
      SET claims_paused = true,
          claims_pause_reason = ${input.reason},
          claims_pause_note = ${input.note},
          claims_paused_by = ${input.actor},
          claims_paused_at = now()
      WHERE id = 'global'
      RETURNING claims_paused, claims_pause_reason, claims_pause_note, claims_paused_by, claims_paused_at`;
    return {
      kind: "decided" as const,
      decision,
      before,
      after: readPlatformClaimsControlRow(row as Record<string, unknown> | undefined),
    };
  }) as Promise<PlatformClaimsMutation<PauseDecision>>;
}

export async function resumePlatformClaims(
  db: Db,
  input: { reason?: PlatformClaimsPauseReason },
): Promise<PlatformClaimsMutation<ResumeDecision>> {
  const result = await db.begin(async (txRaw) => {
    // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
    const tx = txRaw as unknown as Db;
    const before = await lockedControl(tx);
    if (before.missing) return { kind: "missing" as const };
    const decision = decideResume(before, input.reason);
    if (decision.kind !== "apply") return { kind: "decided" as const, decision, before, after: before };
    const [row] = await tx`
      UPDATE global_settings
      SET claims_paused = false,
          claims_pause_reason = NULL,
          claims_pause_note = NULL,
          claims_paused_by = NULL,
          claims_paused_at = NULL
      WHERE id = 'global'
      RETURNING claims_paused, claims_pause_reason, claims_pause_note, claims_paused_by, claims_paused_at`;
    return {
      kind: "decided" as const,
      decision,
      before,
      after: readPlatformClaimsControlRow(row as Record<string, unknown> | undefined),
    };
  }) as PlatformClaimsMutation<ResumeDecision>;
  if (result.kind === "decided" && result.decision.kind === "apply") {
    // Wake LISTEN-driven dispatchers on every replica instead of waiting for a poll.
    await db`SELECT pg_notify('deepsonar_jobs', 'platform-claims-resumed')`;
  }
  return result;
}
