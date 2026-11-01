import { sql } from "./db.js";

/** Revoke under the caller's Job lock, atomically with terminal state. */
export async function revokeJobTokensInTransaction(
  tx: typeof sql,
  jobId: string,
  reason: string,
): Promise<void> {
  await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  const revoked = await tx`
    UPDATE job_tokens SET status = 'revoked', revoked_at = now(), revoke_reason = ${reason}
    WHERE job_id = ${jobId} AND status = 'active'
    RETURNING id, project_id`;
  for (const token of revoked) {
    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, project_id, resource_type, resource_id, after_json, result)
      VALUES ('system', 'scheduler', 'job_token.revoke', ${token.project_id as string}, 'job_token',
        ${token.id as string}, ${tx.json({ job_id: jobId, reason })}, 'ok')`;
  }
}
