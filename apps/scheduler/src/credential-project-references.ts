import type { sql } from "./db.js";

/** DELETE and settings writes hold these rows until their transaction commits. */
export async function lockCredentialProjectReferences(query: typeof sql, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query`
    SELECT id FROM credentials
    WHERE id = ANY(${[...new Set(ids)]}::uuid[])
    ORDER BY id FOR UPDATE`;
}

export async function credentialProjectReferences(
  query: typeof sql,
  id: string,
  actorProjectId: string | null = null,
) {
  const credentialId = id.toLowerCase();
  const rows = await query`
    SELECT p.id, p.name, COUNT(*) OVER()::int AS total,
           refs.enabled,
           COALESCE(lower(p.config_json->>'default_credential_id') = ${credentialId}, false) AS is_default
    FROM projects p
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(p.config_json->'enabled_credential_ids') = 'array'
               THEN p.config_json->'enabled_credential_ids' ELSE '[]'::jsonb END
        ) AS ids(value) WHERE lower(ids.value) = ${credentialId}
      ) AS enabled
    ) refs
    WHERE (refs.enabled OR lower(p.config_json->>'default_credential_id') = ${credentialId})
      AND (${actorProjectId}::uuid IS NULL OR p.id = ${actorProjectId})
    ORDER BY p.name, p.id
    LIMIT 50`;
  return {
    count: Number(rows[0]?.total ?? 0),
    items: rows.map((row) => ({
      project_id: String(row.id),
      project_name: row.name as string | null,
      enabled: row.enabled === true,
      default: row.is_default === true,
    })),
  };
}
