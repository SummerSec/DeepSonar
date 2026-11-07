import { parseSkillSourceCandidate } from "../../skill-source-catalog-lifecycle.js";

/** A management projection, never a way to read candidate module contents. */
export function skillSourceMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const candidate = parseSkillSourceCandidate(row.candidate_json);
  return {
    id: row.id, name: row.name, repo_url: row.repo_url, branch: row.branch,
    synced_at: row.synced_at, created_at: row.created_at,
    trust_status: row.trust_status, enabled: row.enabled,
    last_commit_sha: row.last_commit_sha, last_content_hash: row.last_content_hash,
    synced_by: row.synced_by, source_instance_id: row.source_instance_id,
    revocation_epoch: row.revocation_epoch === undefined ? null : String(row.revocation_epoch),
    catalog_snapshot_hash: row.catalog_snapshot_hash, candidate_hash: row.candidate_hash,
    last_checked_at: row.last_checked_at, last_sync_error: row.last_sync_error,
    module_count: row.module_count ?? (Array.isArray(row.catalog_json) ? row.catalog_json.length : null),
    candidate_json: candidate ? {
      schema: candidate.schema, source_instance_id: candidate.source_instance_id,
      repo_url: candidate.repo_url, branch: candidate.branch, revocation_epoch: candidate.revocation_epoch,
      commit_sha: candidate.commit_sha, content_hash: candidate.content_hash,
      module_count: candidate.module_count, synced_at: candidate.synced_at, synced_by: candidate.synced_by,
    } : null,
  };
}

export function safeSkillSourceCandidate(value: unknown) {
  return skillSourceMetadata({ candidate_json: value }).candidate_json;
}

export function sourceVersionMatches(row: Record<string, unknown>, instanceId: string, epoch: string): boolean {
  return row.source_instance_id === instanceId && String(row.revocation_epoch) === epoch;
}

export function skillSourcePolicyReply(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!error || typeof error !== "object" || !("error_code" in error)) return null;
  const code = String(error.error_code);
  if (!/^SKILL_SOURCE_(CANDIDATE_CONFLICT|DISABLED|MANIFEST_INVALID|SYNC_CANCELLED|LOCK_LOST)$/.test(code)) return null;
  return { status: code === "SKILL_SOURCE_LOCK_LOST" ? 503 : 409,
    body: { error_code: code, error: "源或候选状态已变化；请刷新平台目录并重新核对版本，不会自动批准其它内容。" } };
}
