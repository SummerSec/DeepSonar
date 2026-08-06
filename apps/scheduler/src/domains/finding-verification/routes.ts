import type { FastifyInstance } from "fastify";
import { projectCredentialProviderError, projectJobEventPayload, projectJobPayload } from "../../credentials.js";
import { sql } from "../../db.js";
import { loadFindingTrace } from "../../finding-trace.js";
import { decodeCursor, cursorForRow, page, pageLimit } from "../../pagination.js";

/** Read-only Finding/verification route registrar. */
export function registerFindingVerificationRoutes(app: FastifyInstance): void {
  app.get("/findings", async (req, reply) => {
    const q = req.query as {
      project_id?: string;
      severity?: string;
      profile?: string;
      category?: string;
      verify_status?: string;
      disposition?: string;
      canvas_id?: string;
      cursor?: string;
      after?: string;
      limit?: string;
    };
    const projectId = q.project_id || req.actor?.projectId || null;
    const severity = q.severity || null;
    const profile = q.profile || null;
    const category = q.category || null;
    const verifyStatus = q.verify_status || null;
    const canvasId = q.canvas_id || null;
    const disposition = q.disposition || null;
    const after = q.cursor ?? q.after ?? null;
    const paginated = Boolean(canvasId || after || q.limit || q.cursor);
    const cursor = after ? decodeCursor(after, "findings") : null;
    if (after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "invalid findings cursor", error_code: "INVALID_CURSOR" });
    }
    const limit = paginated ? pageLimit(q.limit) : 500;
    const rows = await sql`
      SELECT f.id, f.project_id, f.job_id, f.node_id, f.fingerprint, f.title, f.severity,
             f.profile, f.category, f.tags_json, f.evidence_refs_json, f.scoring_json,
             f.location, f.summary, f.verify_status, f.disposition, f.disposition_note,
             f.disposition_by, f.disposition_at, f.created_at, f.updated_at,
             p.name AS project_name, j.canvas_id
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
        AND (${severity}::text IS NULL OR f.severity = ${severity})
        AND (${profile}::text IS NULL OR f.profile = ${profile})
        AND (${category}::text IS NULL OR f.category = ${category})
        AND (${verifyStatus}::text IS NULL OR f.verify_status = ${verifyStatus})
        AND (${disposition}::text IS NULL OR f.disposition = ${disposition})
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId})
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR f.created_at < ${cursor?.created_at ?? null}::timestamptz
          OR (f.created_at = ${cursor?.created_at ?? null}::timestamptz AND f.id < ${cursor?.id ?? null}::uuid))
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${paginated ? limit + 1 : limit}`;
    const items = rows.slice(0, limit);
    if (!paginated) return items;
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    const hasMore = rows.length > limit;
    return page(items, {
      after,
      nextCursor: hasMore && last ? cursorForRow("findings", last) : null,
      hasMore,
      live: false,
    });
  });

  app.get("/findings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [finding] = await sql`
      SELECT f.*, p.name AS project_name, j.canvas_id, j.type AS source_job_type,
             j.status AS source_job_status, c.title AS canvas_title
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE f.id = ${id}`;
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    const [verification_jobs, source_events, comments, links, verification_rounds] = await Promise.all([
      sql`SELECT id, type, status, error, started_at, finished_at, created_at, payload_json
          FROM jobs WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, job_seq, type, payload_json, created_at
          FROM events WHERE job_id = ${finding.job_id as string} ORDER BY id LIMIT 1000`,
      sql`SELECT id, finding_id, body, author_type, author_id, author_name, created_at
          FROM finding_comments WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, finding_id, url, title, link_type, created_by, created_at
          FROM finding_links WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, attempt, verify_job_id, status, proposed_verdict, final_outcome,
                 requirements_json, evidence_snapshot_json, summary, error, created_at, finished_at
          FROM finding_verification_rounds WHERE finding_id = ${id} ORDER BY attempt LIMIT 1001`,
    ]);
    const trace = await loadFindingTrace(sql, finding, verification_rounds);
    return {
      finding,
      verification_jobs: verification_jobs.map((verificationJob) => ({
        ...verificationJob,
        error: projectCredentialProviderError(verificationJob.error),
        payload_json: projectJobPayload(verificationJob.payload_json),
      })),
      source_events: source_events.map((event) => ({
        ...event,
        payload_json: projectJobEventPayload(event.payload_json),
      })),
      comments,
      links,
      verification_rounds: verification_rounds.slice(0, 1000),
      trace,
    };
  });
}
