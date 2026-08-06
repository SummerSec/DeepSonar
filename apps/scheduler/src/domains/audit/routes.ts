import type { FastifyInstance } from "fastify";
import { projectCredentialProvider } from "../../credentials.js";
import { sql } from "../../db.js";

function projectCredentialAuditPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  if (payload.provider !== undefined && payload.provider !== null && payload.provider !== "") {
    Object.assign(payload, projectCredentialProvider(payload.kind ?? "llm_provider", payload.provider));
  }
  if (payload.credential_provider !== undefined && payload.credential_provider !== null && payload.credential_provider !== "") {
    const projection = projectCredentialProvider("llm_provider", payload.credential_provider);
    payload.credential_provider = projection.provider;
    payload.credential_provider_valid = projection.provider_valid;
  }
  return payload;
}

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get("/audit-logs", async (req) => {
    const query = req.query as { project_id?: string; action?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const rows = await sql`
      SELECT id, at, actor_type, actor_id, action, project_id, resource_type, resource_id,
             request_id, ip, result, error_code, before_json, after_json
      FROM audit_logs
      WHERE (${query.project_id ?? null}::uuid IS NULL OR project_id = ${query.project_id ?? null}::uuid)
        AND (${query.action ?? null}::text IS NULL OR action = ${query.action ?? null})
      ORDER BY at DESC, id DESC
      LIMIT ${limit}`;
    return rows.map((row) => {
      const credentialAudit = row.resource_type === "credential";
      return {
        ...row,
        before_json: credentialAudit ? projectCredentialAuditPayload(row.before_json) : row.before_json,
        after_json: credentialAudit ? projectCredentialAuditPayload(row.after_json) : row.after_json,
      };
    });
  });
}
