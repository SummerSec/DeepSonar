import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { lockCanvasForConvergence, normalizePendingJobPriority } from "../../core.js";
import { projectCredentialProviderError, projectJobEventPayload, projectJobPayload } from "../../credentials.js";
import { sql } from "../../db.js";
import { loadFindingTrace } from "../../finding-trace.js";
import { decodeCursor, cursorForRow, page, pageLimit } from "../../pagination.js";
import { markFindingNeedsHuman } from "../../verify.js";
import { createSqlJobLifecycleApplication } from "../job-lifecycle/index.js";

const FindingNeedsHumanBody = z
  .object({
    verify_status: z.literal("needs_human"),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

class FindingHumanResumeConflict extends Error {
  readonly code = "finding_human_resume_conflict";

  constructor() {
    super("人工收口时恢复 Hub Job 失败，状态未改变。");
  }
}

/** Finding/verification 路由注册。 */
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
             p.name AS project_name, j.canvas_id,
             EXISTS (
               SELECT 1 FROM jobs waiting_job
               WHERE waiting_job.canvas_id = j.canvas_id
                 AND waiting_job.status = 'waiting_human'
                 AND waiting_job.type = 'hub_reason'
             ) AS has_waiting_human
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

  app.patch("/findings/:id/verify-status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = FindingNeedsHumanBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "人工验证收口请求无效",
        error_code: "FINDING_VERIFY_STATUS_INVALID",
      });
    }
    const reason = parsed.data.reason ?? "人工收口";
    let result;
    try {
      result = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        const [initialFinding] = await tx`
          SELECT f.id, f.project_id, f.verify_status, f.node_id, origin.canvas_id
          FROM findings f
          JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
          WHERE f.id = ${id}`;
        if (!initialFinding) return { kind: "not_found" as const };
        if (initialFinding.verify_status === "confirmed") return { kind: "confirmed" as const };
        if (![
          "pending",
          "verifying",
          "false_positive",
          "needs_human",
        ].includes(String(initialFinding.verify_status))) {
          return { kind: "invalid_status" as const, verify_status: String(initialFinding.verify_status) };
        }
        const canvasId = (initialFinding.canvas_id as string | null) ?? null;
        if (!canvasId || !(await lockCanvasForConvergence(tx, canvasId))) {
          return { kind: "not_waiting_human" as const };
        }
        const [finding] = await tx`
          SELECT f.id, f.project_id, f.verify_status, f.node_id, origin.canvas_id
          FROM findings f
          JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
          WHERE f.id = ${id}
          FOR UPDATE`;
        if (!finding || finding.canvas_id !== canvasId) return { kind: "not_waiting_human" as const };
        if (finding.verify_status === "confirmed") return { kind: "confirmed" as const };
        if (!["pending", "verifying", "false_positive", "needs_human"].includes(String(finding.verify_status))) {
          return { kind: "invalid_status" as const, verify_status: String(finding.verify_status) };
        }
        const [waitingHub] = await tx`
          SELECT id
          FROM jobs
          WHERE canvas_id = ${canvasId}
            AND status = 'waiting_human'
            AND type = 'hub_reason'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`;
        if (!waitingHub) return { kind: "not_waiting_human" as const };
        const before = String(finding.verify_status);
        const updated = await markFindingNeedsHuman(
          tx,
          finding.id as string,
          reason,
          { requireWaitingHumanHub: true },
        );
        if (!updated) return { kind: "not_waiting_human" as const };
        const resumed = await createSqlJobLifecycleApplication(tx).transitionJob(
          waitingHub.id as string,
          "pending",
          {
            error: null,
            lease_expires_at: null,
            claimed_at: null,
            started_at: null,
            finished_at: null,
            heartbeat_at: null,
          },
        );
        if (!resumed) throw new FindingHumanResumeConflict();
        await normalizePendingJobPriority(waitingHub.id as string, tx as unknown as typeof sql);
        await tx`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${waitingHub.id as string} AND node_type IN ('job', 'intent')`;
        await tx`SELECT pg_notify('deepsonar_jobs', 'finding_needs_human')`;
        const [after] = await tx`
          SELECT id, project_id, node_id, verify_status, updated_at
          FROM findings
          WHERE id = ${finding.id as string}`;
        return {
          kind: "updated" as const,
          project_id: finding.project_id as string,
          finding: after,
          before,
          resumed_job_id: waitingHub.id as string,
        };
      });
    } catch (error) {
      if (error instanceof FindingHumanResumeConflict) {
        return reply.code(409).send({ error: "人工收口恢复 Hub 失败，状态未改变。", error_code: error.code });
      }
      throw error;
    }
    if (result.kind === "not_found") return reply.code(404).send({ error: "Finding 不存在", error_code: "FINDING_NOT_FOUND" });
    if (result.kind === "confirmed") {
      return reply.code(409).send({
        error: "该 Finding 已确认，技术状态只能由 Scheduler 收口",
        error_code: "FINDING_CONFIRMED_SCHEDULER_OWNED",
        verify_status: "confirmed",
      });
    }
    if (result.kind === "invalid_status") {
      return reply.code(409).send({
        error: "该 Finding 当前技术状态不可人工收口",
        error_code: "FINDING_VERIFY_STATUS_NOT_CHANGEABLE",
        verify_status: result.verify_status,
      });
    }
    if (result.kind === "not_waiting_human") {
      return reply.code(409).send({ error: "当前画布没有等待人工的 Hub Job", error_code: "FINDING_NOT_WAITING_HUMAN" });
    }
    await audit(req, {
      action: "finding.verify_status.needs_human",
      projectId: result.project_id,
      resourceType: "finding",
      resourceId: id,
      before: { verify_status: result.before },
      after: { verify_status: "needs_human" },
    });
    return { ...result.finding, resumed_job_id: result.resumed_job_id };
  });

  app.get("/findings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [finding] = await sql`
      SELECT f.*, p.name AS project_name, j.canvas_id, j.type AS source_job_type,
             j.status AS source_job_status, c.title AS canvas_title,
             EXISTS (
               SELECT 1 FROM jobs waiting_job
               WHERE waiting_job.canvas_id = j.canvas_id
                 AND waiting_job.status = 'waiting_human'
                 AND waiting_job.type = 'hub_reason'
             ) AS has_waiting_human
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
