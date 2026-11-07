import postgres from "postgres";
import { config } from "./config.js";
import { sql } from "./db.js";
import { recordSystemAudit } from "./audit.js";
import { readSkillSourceManifest } from "./job-skill-catalog.js";
import { contentHashOf, healRoleConfigSelectorsAfterSync, type SourceModule } from "./skill-sources.js";

const HASH_RE = /^[0-9a-f]{64}$/;
export const SKILL_SOURCE_CANDIDATE_SCHEMA = "deepsonar.skill-source-candidate/v1";

export interface SkillSourceCandidate {
  schema: typeof SKILL_SOURCE_CANDIDATE_SCHEMA;
  source_instance_id: string;
  repo_url: string;
  branch: string;
  revocation_epoch: string;
  commit_sha: string | null;
  content_hash: string;
  module_count: number;
  synced_at: string;
  synced_by: string | null;
}

export interface SkillSourceState {
  id: string;
  name: string;
  source_instance_id: string;
  repo_url: string;
  branch: string;
  revocation_epoch: string | number | bigint;
  enabled: boolean;
  trust_status: string;
  catalog_json: SourceModule[];
  catalog_snapshot_hash: string | null;
  last_commit_sha: string | null;
  last_content_hash: string | null;
  candidate_hash: string | null;
  candidate_json: unknown;
}

export class SkillSourceCandidateError extends Error {
  constructor(readonly error_code: "SKILL_SOURCE_CANDIDATE_CONFLICT" | "SKILL_SOURCE_DISABLED" | "SKILL_SOURCE_MANIFEST_INVALID" | "SKILL_SOURCE_SYNC_CANCELLED" | "SKILL_SOURCE_LOCK_LOST") {
    super(error_code);
  }
}

export function assertSkillSourceSyncActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SkillSourceCandidateError("SKILL_SOURCE_SYNC_CANCELLED");
}

export function sameSkillSourceIdentity(current: SkillSourceState, captured: SkillSourceState): boolean {
  return current.source_instance_id === captured.source_instance_id
    && current.repo_url === captured.repo_url && current.branch === captured.branch
    && String(current.revocation_epoch) === String(captured.revocation_epoch);
}

export function parseSkillSourceCandidate(value: unknown): SkillSourceCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as SkillSourceCandidate;
  return c.schema === SKILL_SOURCE_CANDIDATE_SCHEMA
    && typeof c.source_instance_id === "string" && typeof c.repo_url === "string" && typeof c.branch === "string"
    && typeof c.revocation_epoch === "string" && /^(0|[1-9][0-9]*)$/.test(c.revocation_epoch)
    && (c.commit_sha === null || typeof c.commit_sha === "string")
    && typeof c.content_hash === "string" && HASH_RE.test(c.content_hash)
    && Number.isSafeInteger(c.module_count) && c.module_count >= 0
    && typeof c.synced_at === "string" && Number.isFinite(Date.parse(c.synced_at))
    && (c.synced_by === null || typeof c.synced_by === "string") ? c : null;
}

function candidateMatchesSource(c: SkillSourceCandidate, source: SkillSourceState): boolean {
  return c.source_instance_id === source.source_instance_id && c.repo_url === source.repo_url
    && c.branch === source.branch && c.revocation_epoch === String(source.revocation_epoch);
}

/** Dedicated session: long clones never hold source rows or exhaust the business pool. */
export async function withSkillSourceSyncLock<T>(sourceId: string, signal: AbortSignal | undefined,
  operation: (assertLock: () => Promise<void>) => Promise<T>, databaseUrl = config.databaseUrl): Promise<T> {
  const db = postgres(databaseUrl, {
    max: 1, connect_timeout: config.db.connectTimeoutSec,
    connection: { application_name: "deepsonar-skill-source-sync", statement_timeout: 180_000 },
  });
  let session: Awaited<ReturnType<typeof db.reserve>> | undefined;
  let backendPid: unknown;
  const key = `deepsonar:skill-source-sync:${sourceId.toLowerCase()}`;
  try {
    assertSkillSourceSyncActive(signal);
    session = await db.reserve();
    const [locked] = await session`SELECT pg_backend_pid() AS pid, pg_advisory_lock(hashtextextended(${key}, 0))`;
    backendPid = locked?.pid;
    if (!Number.isInteger(backendPid)) throw new SkillSourceCandidateError("SKILL_SOURCE_LOCK_LOST");
    const assertLock = async () => {
      assertSkillSourceSyncActive(signal);
      const [row] = await session!`SELECT pg_backend_pid() AS pid`;
      if (row?.pid !== backendPid) throw new SkillSourceCandidateError("SKILL_SOURCE_LOCK_LOST");
      assertSkillSourceSyncActive(signal);
    };
    await assertLock();
    return await operation(assertLock);
  } finally {
    try {
      if (session && backendPid !== undefined) {
        const [row] = await session`SELECT pg_backend_pid() AS pid, pg_advisory_unlock(hashtextextended(${key}, 0)) AS unlocked`;
        if (row?.pid !== backendPid || row.unlocked !== true) throw new SkillSourceCandidateError("SKILL_SOURCE_LOCK_LOST");
      }
    } finally {
      session?.release();
      // Discard even after failed unlock: never pool a potentially locked connection.
      await db.end({ timeout: 0 });
    }
  }
}

/** Missing pointer/index, bad bytes or mismatched metadata all force a real clone. */
export async function healthySkillSourceRevision(source: SkillSourceState, remoteHead: string, db: typeof sql = sql): Promise<{
  hash: string; candidate: SkillSourceCandidate; catalog: SourceModule[];
} | null> {
  const c = parseSkillSourceCandidate(source.candidate_json);
  const choices = [
    ...(c && source.candidate_hash && candidateMatchesSource(c, source)
      ? [{ hash: source.candidate_hash, candidate: c }] : []),
    ...(source.catalog_snapshot_hash && source.last_content_hash ? [{
      hash: source.catalog_snapshot_hash,
      candidate: {
        schema: SKILL_SOURCE_CANDIDATE_SCHEMA, source_instance_id: source.source_instance_id,
        repo_url: source.repo_url, branch: source.branch, revocation_epoch: String(source.revocation_epoch),
        commit_sha: source.last_commit_sha, content_hash: source.last_content_hash,
        module_count: Array.isArray(source.catalog_json) ? source.catalog_json.length : -1,
        synced_at: new Date().toISOString(), synced_by: null,
      } satisfies SkillSourceCandidate,
    }] : []),
  ];
  for (const revision of choices) {
    if (revision.candidate.commit_sha !== remoteHead || !HASH_RE.test(revision.hash)) continue;
    try {
      const [indexed] = await db`SELECT content_sha256 FROM shared_asset_blobs WHERE content_sha256 = ${revision.hash}`;
      if (!indexed) continue;
      const catalog = await readSkillSourceManifest({ hash: revision.hash, sourceId: source.id,
        commitSha: revision.candidate.commit_sha, contentHash: revision.candidate.content_hash,
        moduleCount: revision.candidate.module_count });
      return { ...revision, catalog };
    } catch { /* unhealthy is not unchanged */ }
  }
  return null;
}

/** Stage only: no trust/live/RoleConfig/epoch writes, even for a trusted source. */
export async function stageSkillSourceCandidate(input: {
  captured: SkillSourceState; hash: string; candidate: SkillSourceCandidate;
  signal?: AbortSignal; assertLock: () => Promise<void>;
}, db: typeof sql = sql): Promise<string | null> {
  assertSkillSourceSyncActive(input.signal);
  if (!parseSkillSourceCandidate(input.candidate)) throw new SkillSourceCandidateError("SKILL_SOURCE_MANIFEST_INVALID");
  try {
    await readSkillSourceManifest({ hash: input.hash, sourceId: input.captured.id,
      commitSha: input.candidate.commit_sha, moduleCount: input.candidate.module_count, contentHash: input.candidate.content_hash });
  } catch { throw new SkillSourceCandidateError("SKILL_SOURCE_MANIFEST_INVALID"); }
  assertSkillSourceSyncActive(input.signal);
  return await db.begin(async (tx) => {
    const [current] = await tx`SELECT * FROM skill_sources WHERE id = ${input.captured.id} FOR UPDATE` as SkillSourceState[];
    assertSkillSourceSyncActive(input.signal);
    if (!current || !sameSkillSourceIdentity(current, input.captured)
      || !candidateMatchesSource(input.candidate, current)) throw new SkillSourceCandidateError("SKILL_SOURCE_CANDIDATE_CONFLICT");
    if (current.trust_status === "disabled") throw new SkillSourceCandidateError("SKILL_SOURCE_DISABLED");
    await input.assertLock();
    // Only re-observing the exact healthy published bytes may refresh live age.
    // A pending different candidate must never make the old publication look fresh.
    const sameLive = current.enabled && current.trust_status === "trusted"
      && current.catalog_snapshot_hash === input.hash
      && current.last_commit_sha === input.candidate.commit_sha
      && current.last_content_hash === input.candidate.content_hash
      && Array.isArray(current.catalog_json) && current.catalog_json.length === input.candidate.module_count;
    if (sameLive) {
      await tx`UPDATE skill_sources SET candidate_hash = NULL, candidate_json = NULL,
        synced_at = ${input.candidate.synced_at}, synced_by = ${input.candidate.synced_by},
        last_checked_at = ${input.candidate.synced_at}, last_sync_error = NULL WHERE id = ${current.id}`;
    } else {
      await tx`UPDATE skill_sources SET candidate_hash = ${input.hash}, candidate_json = ${tx.json(input.candidate as never)},
        last_checked_at = ${input.candidate.synced_at}, last_sync_error = NULL WHERE id = ${current.id}`;
      if (current.candidate_hash !== input.hash) {
        // SAFETY: the transaction exposes the tagged-query/json/insert helpers;
        // recordSystemAudit does not use pool operations through this view.
        await recordSystemAudit({ action: "skill_source.candidate_staged", resourceType: "skill_source", resourceId: current.id,
          actorId: input.candidate.synced_by ?? "skill-source-sync",
          after: { candidate_hash: input.hash, commit_sha: input.candidate.commit_sha, content_hash: input.candidate.content_hash,
            module_count: input.candidate.module_count, revocation_epoch: input.candidate.revocation_epoch } }, tx as unknown as typeof sql);
      }
    }
    await input.assertLock();
    assertSkillSourceSyncActive(input.signal);
    return sameLive ? null : input.hash;
  });
}

/** Safe fixed vocabulary only; never persist git stderr, credentials or URL queries. */
export function skillSourceSyncErrorCode(error: unknown): string {
  if (error instanceof SkillSourceCandidateError) {
    switch (error.error_code) {
      case "SKILL_SOURCE_SYNC_CANCELLED": return "sync_cancelled";
      case "SKILL_SOURCE_CANDIDATE_CONFLICT": return "source_changed";
      case "SKILL_SOURCE_DISABLED": return "source_disabled";
      case "SKILL_SOURCE_LOCK_LOST": return "lock_lost";
      case "SKILL_SOURCE_MANIFEST_INVALID": return "manifest_invalid";
    }
  }
  return "sync_failed";
}

export async function recordSkillSourceSyncFailure(captured: SkillSourceState, error: unknown, db: typeof sql = sql): Promise<void> {
  // Configuration changes fence both successes and failures from a stale clone.
  await db`UPDATE skill_sources SET last_checked_at = now(), last_sync_error = ${skillSourceSyncErrorCode(error)}
    WHERE id = ${captured.id} AND source_instance_id = ${captured.source_instance_id}
      AND repo_url = ${captured.repo_url} AND branch = ${captured.branch}
      AND revocation_epoch = ${String(captured.revocation_epoch)} AND trust_status <> 'disabled'`;
}

export async function approveSkillSourceCandidate(input: {
  sourceId: string; candidateHash: string; expectedEpoch: string; expectedSourceInstanceId: string; actorId: string; enabled?: boolean;
}, db: typeof sql = sql): Promise<{ candidate_hash: string; synced_at: string; selector_cleanup: Awaited<ReturnType<typeof healRoleConfigSelectorsAfterSync>> }> {
  if (!HASH_RE.test(input.candidateHash) || !/^(0|[1-9][0-9]*)$/.test(input.expectedEpoch)) {
    throw new SkillSourceCandidateError("SKILL_SOURCE_CANDIDATE_CONFLICT");
  }
  return await db.begin(async (tx) => {
    const [source] = await tx`SELECT * FROM skill_sources WHERE id = ${input.sourceId} FOR UPDATE` as SkillSourceState[];
    if (!source || source.source_instance_id !== input.expectedSourceInstanceId
      || source.candidate_hash !== input.candidateHash || String(source.revocation_epoch) !== input.expectedEpoch) {
      throw new SkillSourceCandidateError("SKILL_SOURCE_CANDIDATE_CONFLICT");
    }
    if (source.trust_status === "disabled") throw new SkillSourceCandidateError("SKILL_SOURCE_DISABLED");
    const c = parseSkillSourceCandidate(source.candidate_json);
    if (!c || !candidateMatchesSource(c, source)) throw new SkillSourceCandidateError("SKILL_SOURCE_CANDIDATE_CONFLICT");
    let catalog: SourceModule[];
    try { catalog = await readSkillSourceManifest({ hash: input.candidateHash, sourceId: source.id,
      commitSha: c.commit_sha, contentHash: c.content_hash, moduleCount: c.module_count }); }
    catch { throw new SkillSourceCandidateError("SKILL_SOURCE_MANIFEST_INVALID"); }
    const before = Array.isArray(source.catalog_json) ? source.catalog_json : [];
    const oldIds = new Set(before.map((m) => m.id));
    const newIds = new Set(catalog.map((m) => m.id));
    await tx`UPDATE skill_sources SET catalog_json = ${tx.json(catalog as never)},
      catalog_snapshot_hash = ${input.candidateHash}, last_commit_sha = ${c.commit_sha},
      last_content_hash = ${c.content_hash}, synced_at = ${c.synced_at}, synced_by = ${c.synced_by},
      trust_status = 'trusted', enabled = ${input.enabled ?? true}, candidate_hash = NULL, candidate_json = NULL
      WHERE id = ${source.id}`;
    // SAFETY: postgres.js transactions expose the same query/json/insert-helper
    // interface used here; no connection-pool method is called through this view.
    const transactionDb = tx as unknown as typeof sql;
    const recordAudit = async (entry: { action: string; resourceType: string; resourceId: string; projectId?: string | null; after: unknown }) => {
      await recordSystemAudit({ ...entry, actorId: input.actorId }, transactionDb);
    };
    const selectorCleanup = await healRoleConfigSelectorsAfterSync({ sourceId: source.id,
      newCatalogIds: newIds, db: transactionDb, recordAudit });
    await recordAudit({ action: "skill_source.candidate_approved", resourceType: "skill_source", resourceId: source.id,
      after: { candidate_hash: input.candidateHash, source_instance_id: input.expectedSourceInstanceId,
        revocation_epoch: input.expectedEpoch, enabled: input.enabled ?? true } });
    if (source.catalog_snapshot_hash !== input.candidateHash || contentHashOf(before) !== c.content_hash) {
      await recordAudit({ action: "skill_source.catalog_diff", resourceType: "skill_source", resourceId: source.id,
        after: { previous_manifest_hash: source.catalog_snapshot_hash, manifest_hash: input.candidateHash,
          previous_content_hash: source.last_content_hash, content_hash: c.content_hash,
          added_module_ids: [...newIds].filter((id) => !oldIds.has(id)),
          removed_module_ids: [...oldIds].filter((id) => !newIds.has(id)), selector_cleanup: selectorCleanup } });
    }
    return { candidate_hash: input.candidateHash, synced_at: c.synced_at, selector_cleanup: selectorCleanup };
  });
}
