import type { FastifyInstance } from "fastify";
import { projectCredentialProvider } from "../../credentials.js";
import { sql } from "../../db.js";
import { parseBoundedLimit } from "../../pagination.js";

/** Audit `before_json` / `after_json` are free-form JSONB columns. */
type AuditPayload = null | undefined | boolean | number | string | unknown[] | Record<string, unknown>;

function projectCredentialAuditPayload(value: unknown): AuditPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // SAFETY: the guard above admits only JSON scalars, null/undefined and arrays,
    // all of which AuditPayload already covers; no credential keys to project.
    return value as AuditPayload;
  }
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
    const limit = parseBoundedLimit(query.limit, { max: 500, fallback: 100 });
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
