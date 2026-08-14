import type { FastifyInstance, FastifyReply } from "fastify";
import { audit } from "../../audit.js";
import { sql } from "../../db.js";
import { cursorForRow, decodeCursor, page } from "../../pagination.js";
import { FactListQuery, FactVerificationPatch } from "./fact-contract.js";

type FactDatabase = typeof sql;

function invalidQuery(reply: FastifyReply) {
  return reply.code(400).send({ error: "Fact 查询参数无效", error_code: "INVALID_FACT_QUERY" });
}

async function loadFactSummary(db: FactDatabase, canvasId: string, nodeId: string) {
  const [fact] = await db`
    SELECT n.id, n.canvas_id, n.title,
           LEFT(COALESCE(n.body_json->>'description', ''), 500) AS description,
           n.verification_status, n.job_id, n.created_at, n.updated_at,
           CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
             'finding_id', f.id,
             'evidence_kind', n.body_json->'verification'->>'evidence_kind',
             'outcome', n.body_json->'verification'->>'outcome',
             'subject_revision', n.body_json->'verification'->>'subject_revision'
           ) END AS verification,
           CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', f.id, 'node_id', f.node_id, 'title', LEFT(f.title, 300),
             'severity', f.severity, 'verify_status', f.verify_status
           ) END AS finding,
           CASE WHEN source_job.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', source_job.id, 'type', source_job.type, 'status', source_job.status
           ) END AS job
    FROM canvas_nodes n
    JOIN canvases c ON c.id = n.canvas_id
    LEFT JOIN jobs source_job ON source_job.id = n.job_id
      AND source_job.canvas_id = c.id AND source_job.project_id = c.project_id
    LEFT JOIN LATERAL (
      SELECT finding.id, finding.node_id, finding.title, finding.severity, finding.verify_status
      FROM findings finding
      JOIN jobs origin ON origin.id = finding.job_id
      JOIN canvas_nodes source ON source.id = finding.node_id
      WHERE jsonb_typeof(n.body_json->'verification') = 'object'
        AND n.body_json->'verification'->>'finding_id' = finding.id::text
        AND n.body_json->'verification'->>'evidence_kind' IN ('review','test')
        AND n.body_json->'verification'->>'outcome' IN ('supports','refutes','inconclusive')
        AND char_length(trim(COALESCE(n.body_json->'verification'->>'subject_revision', ''))) BETWEEN 1 AND 500
        AND finding.project_id = c.project_id
        AND origin.project_id = c.project_id
        AND origin.canvas_id = c.id
        AND source.canvas_id = c.id
        AND source.node_type = 'finding'
        AND EXISTS (
          SELECT 1 FROM canvas_edges evidence_edge
          WHERE evidence_edge.canvas_id = c.id
            AND evidence_edge.from_node_id = source.id
            AND evidence_edge.to_node_id = n.id
            AND evidence_edge.edge_type = CASE n.body_json->'verification'->>'evidence_kind'
              WHEN 'review' THEN 'reviewed_by'
              WHEN 'test' THEN 'tested_by'
            END
        )
      LIMIT 1
    ) f ON true
    WHERE n.id = ${nodeId} AND n.canvas_id = ${canvasId} AND n.node_type = 'fact'`;
  return fact;
}

/** 画布内 Fact 的有界列表、完整详情和人工验证动作。 */
export function registerCanvasFactRoutes(app: FastifyInstance): void {
  app.get("/canvases/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = FactListQuery.safeParse(req.query);
    if (!parsed.success) return invalidQuery(reply);
    const query = parsed.data;
    const cursor = query.after ? decodeCursor(query.after, "facts") : null;
    if (query.after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "Fact 游标无效", error_code: "INVALID_CURSOR" });
    }
    const limit = query.limit ?? 50;
    const verificationStatuses = query.verification_status ?? [];
    const evidenceKinds = query.evidence_kind ?? [];
    const findingIds = query.finding_id ?? [];
    const jobIds = query.job_id ?? [];
    const [canvas] = await sql`SELECT id FROM canvases WHERE id = ${id}`;
    if (!canvas) {
      return reply.code(404).send({ error: "canvas not found", error_code: "CANVAS_NOT_FOUND" });
    }

    const rows = await sql`
      SELECT n.id, n.canvas_id, n.title,
             LEFT(COALESCE(n.body_json->>'description', ''), 500) AS description,
             n.verification_status, n.job_id, n.created_at, n.updated_at,
             CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
               'finding_id', f.id,
               'evidence_kind', n.body_json->'verification'->>'evidence_kind',
               'outcome', n.body_json->'verification'->>'outcome',
               'subject_revision', n.body_json->'verification'->>'subject_revision'
             ) END AS verification,
             CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', f.id, 'node_id', f.node_id, 'title', LEFT(f.title, 300),
               'severity', f.severity, 'verify_status', f.verify_status
             ) END AS finding,
             CASE WHEN source_job.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', source_job.id, 'type', source_job.type, 'status', source_job.status
             ) END AS job
      FROM canvas_nodes n
      JOIN canvases c ON c.id = n.canvas_id
      LEFT JOIN jobs source_job ON source_job.id = n.job_id
        AND source_job.canvas_id = c.id AND source_job.project_id = c.project_id
      LEFT JOIN LATERAL (
        SELECT finding.id, finding.node_id, finding.title, finding.severity, finding.verify_status
        FROM findings finding
        JOIN jobs origin ON origin.id = finding.job_id
        JOIN canvas_nodes source ON source.id = finding.node_id
        WHERE jsonb_typeof(n.body_json->'verification') = 'object'
          AND n.body_json->'verification'->>'finding_id' = finding.id::text
          AND n.body_json->'verification'->>'evidence_kind' IN ('review','test')
          AND n.body_json->'verification'->>'outcome' IN ('supports','refutes','inconclusive')
          AND char_length(trim(COALESCE(n.body_json->'verification'->>'subject_revision', ''))) BETWEEN 1 AND 500
          AND finding.project_id = c.project_id
          AND origin.project_id = c.project_id
          AND origin.canvas_id = c.id
          AND source.canvas_id = c.id
          AND source.node_type = 'finding'
          AND EXISTS (
            SELECT 1 FROM canvas_edges evidence_edge
            WHERE evidence_edge.canvas_id = c.id
              AND evidence_edge.from_node_id = source.id
              AND evidence_edge.to_node_id = n.id
              AND evidence_edge.edge_type = CASE n.body_json->'verification'->>'evidence_kind'
                WHEN 'review' THEN 'reviewed_by'
                WHEN 'test' THEN 'tested_by'
              END
          )
        LIMIT 1
      ) f ON true
      WHERE n.canvas_id = ${id}
        AND n.node_type = 'fact'
        AND (${verificationStatuses.length} = 0 OR n.verification_status = ANY(${verificationStatuses}::text[]))
        AND (${evidenceKinds.length} = 0 OR (
          f.id IS NOT NULL AND n.body_json->'verification'->>'evidence_kind' = ANY(${evidenceKinds}::text[])
        ))
        AND (${findingIds.length} = 0 OR f.id = ANY(${findingIds}::uuid[]))
        AND (${jobIds.length} = 0 OR source_job.id = ANY(${jobIds}::uuid[]))
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR n.created_at < ${cursor?.created_at ?? null}::timestamptz
          OR (n.created_at = ${cursor?.created_at ?? null}::timestamptz AND n.id < ${cursor?.id ?? null}::uuid))
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    const hasMore = rows.length > limit;
    return page(items, {
      after: query.after ?? null,
      nextCursor: hasMore && last ? cursorForRow("facts", last) : null,
      hasMore,
      live: false,
    });
  });

  app.get("/canvases/:id/facts/:nodeId", async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const [fact] = await sql`
      SELECT n.id, n.canvas_id, n.title,
             COALESCE(n.body_json->>'description', '') AS description,
             n.body_json, n.verification_status, n.job_id, n.created_at, n.updated_at,
             CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
               'finding_id', f.id,
               'evidence_kind', n.body_json->'verification'->>'evidence_kind',
               'outcome', n.body_json->'verification'->>'outcome',
               'subject_revision', n.body_json->'verification'->>'subject_revision'
             ) END AS verification,
             CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', f.id, 'node_id', f.node_id, 'title', f.title,
               'severity', f.severity, 'verify_status', f.verify_status
             ) END AS finding,
             CASE WHEN source_job.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', source_job.id, 'type', source_job.type, 'status', source_job.status
             ) END AS job
      FROM canvas_nodes n
      JOIN canvases c ON c.id = n.canvas_id
      LEFT JOIN jobs source_job ON source_job.id = n.job_id
        AND source_job.canvas_id = c.id AND source_job.project_id = c.project_id
      LEFT JOIN LATERAL (
        SELECT finding.id, finding.node_id, finding.title, finding.severity, finding.verify_status
        FROM findings finding
        JOIN jobs origin ON origin.id = finding.job_id
        JOIN canvas_nodes source ON source.id = finding.node_id
        WHERE jsonb_typeof(n.body_json->'verification') = 'object'
          AND n.body_json->'verification'->>'finding_id' = finding.id::text
          AND n.body_json->'verification'->>'evidence_kind' IN ('review','test')
          AND n.body_json->'verification'->>'outcome' IN ('supports','refutes','inconclusive')
          AND char_length(trim(COALESCE(n.body_json->'verification'->>'subject_revision', ''))) BETWEEN 1 AND 500
          AND finding.project_id = c.project_id
          AND origin.project_id = c.project_id
          AND origin.canvas_id = c.id
          AND source.canvas_id = c.id
          AND source.node_type = 'finding'
          AND EXISTS (
            SELECT 1 FROM canvas_edges evidence_edge
            WHERE evidence_edge.canvas_id = c.id
              AND evidence_edge.from_node_id = source.id
              AND evidence_edge.to_node_id = n.id
              AND evidence_edge.edge_type = CASE n.body_json->'verification'->>'evidence_kind'
                WHEN 'review' THEN 'reviewed_by'
                WHEN 'test' THEN 'tested_by'
              END
          )
        LIMIT 1
      ) f ON true
      WHERE n.id = ${nodeId} AND n.canvas_id = ${id} AND n.node_type = 'fact'`;
    if (!fact) {
      return reply.code(404).send({ error: "Fact not found", error_code: "FACT_NOT_FOUND" });
    }
    const [traceNodes, traceEdges] = await Promise.all([
      sql`
        SELECT DISTINCT adjacent.id, adjacent.node_type, LEFT(adjacent.title, 300) AS title,
               adjacent.status, adjacent.job_id
        FROM canvas_nodes adjacent
        WHERE adjacent.canvas_id = ${id}
          AND (
            adjacent.id = ${nodeId}::uuid
            OR adjacent.id IN (
              SELECT CASE WHEN edge.from_node_id = ${nodeId}::uuid THEN edge.to_node_id ELSE edge.from_node_id END
              FROM canvas_edges edge
              WHERE edge.canvas_id = ${id}
                AND (${nodeId}::uuid = edge.from_node_id OR ${nodeId}::uuid = edge.to_node_id)
              ORDER BY edge.created_at, edge.id
              LIMIT 100
            )
          )
        ORDER BY adjacent.id
        LIMIT 101`,
      sql`
        SELECT id, from_node_id, to_node_id, edge_type
        FROM canvas_edges
        WHERE canvas_id = ${id}
          AND (${nodeId}::uuid = from_node_id OR ${nodeId}::uuid = to_node_id)
        ORDER BY created_at, id
        LIMIT 100`,
    ]);
    const { finding, job, ...factBody } = fact;
    return { fact: factBody, finding, job, trace: { nodes: traceNodes, edges: traceEdges } };
  });

  app.patch("/canvases/:id/facts/:nodeId/verification", async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const parsed = FactVerificationPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Fact 验证请求无效", error_code: "INVALID_FACT_VERIFICATION" });
    }
    const actor = req.actor?.name ?? "anonymous";
    const result = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      const [node] = await tx`
        SELECT n.id, n.node_type, n.verification_status, c.project_id
        FROM canvas_nodes n
        JOIN canvases c ON c.id = n.canvas_id
        WHERE n.id = ${nodeId} AND n.canvas_id = ${id}
        FOR UPDATE`;
      if (!node) return { kind: "not_found" as const };
      if (node.node_type !== "fact") return { kind: "not_fact" as const };
      const manualVerification = {
        note: parsed.data.note ?? null,
        actor,
        updated_at: new Date().toISOString(),
      };
      await tx`
        UPDATE canvas_nodes
        SET verification_status = ${parsed.data.status},
            body_json = jsonb_set(body_json, '{manual_verification}', ${tx.json(manualVerification)}, true),
            updated_at = now()
        WHERE id = ${nodeId} AND canvas_id = ${id} AND node_type = 'fact'`;
      return {
        kind: "ok" as const,
        fact: await loadFactSummary(tx, id, nodeId),
        projectId: String(node.project_id),
        beforeStatus: String(node.verification_status),
      };
    });
    if (result.kind === "not_found") {
      return reply.code(404).send({ error: "canvas node not found", error_code: "NODE_NOT_FOUND" });
    }
    if (result.kind === "not_fact") {
      return reply.code(409).send({ error: "仅 Fact 节点可人工验证", error_code: "FACT_NODE_REQUIRED" });
    }
    await audit(req, {
      action: "canvas.fact.verification",
      projectId: result.projectId,
      resourceType: "canvas_fact",
      resourceId: nodeId,
      before: { status: result.beforeStatus },
      after: { status: parsed.data.status, note_present: parsed.data.note !== undefined },
    });
    return { fact: result.fact };
  });
}
