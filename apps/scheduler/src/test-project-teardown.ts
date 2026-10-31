/**
 * Integration teardown for projects that may be referenced by append-only
 * `audit_logs.project_id`. Finding verify-gate writes (and disposition audits)
 * cannot be deleted or nulled; leave those project shells.
 */
export type ProjectTeardownSql = typeof import("./db.js").sql;

export async function deleteProjectsLeavingAuditShells(
  db: ProjectTeardownSql,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return;
  const ids = [...projectIds];
  await db`
    DELETE FROM projects p
    WHERE p.id = ANY(${ids}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.project_id = p.id)`;
}
