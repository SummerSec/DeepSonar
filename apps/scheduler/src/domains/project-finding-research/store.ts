import type { TransactionSql } from "postgres";
import { sql } from "../../db.js";
import { EXTRACTOR_VERSION, extractFindingFeatures, sourceInputDigest, type FindingFeatureSource } from "./model.js";
import { maintenanceIdentityMatches } from "../../platform-maintenance.js";

export const FEATURE_BATCH_SIZE = 20;
export const FEATURE_PROJECT_SCAN_SIZE = 25;
export const FEATURE_RESCAN_SECONDS = 30;
type Db = typeof sql;

/** Evidence metadata participates in freshness, but is never exposed as proof. */
export async function loadFeatureSource(db: Db, findingId: string): Promise<FindingFeatureSource | null> {
  const [row] = await db`
    SELECT f.id, f.project_id, f.job_id, j.canvas_id, f.artifact_id, a.revision AS artifact_revision,
      f.title, f.location, f.summary, f.profile, f.category, f.source_digest,
      to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
      f.evidence_refs_json,
      jsonb_build_object('artifact_status', a.status, 'artifact_updated_at', a.updated_at,
        'evidence', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.ordinal), '[]'::jsonb)
          FROM (SELECT id, ordinal, kind, polarity, uri, sha256, md5(statement) AS statement_digest, md5(payload_json::text) AS payload_digest
            FROM artifact_evidence WHERE artifact_id = a.id ORDER BY ordinal LIMIT 129) e)) AS artifact_evidence
    FROM findings f JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
    JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
    LEFT JOIN artifacts a ON a.id = f.artifact_id AND a.project_id = f.project_id AND a.job_id = f.job_id AND a.canvas_id = j.canvas_id
    WHERE (f.artifact_id IS NULL OR a.id IS NOT NULL) AND f.id = ${findingId}::uuid`;
  return row ? row as unknown as FindingFeatureSource : null;
}

/** Explicit rebuild creates a new generation; callers must already own management authorization. */
export async function requestFeatureRebuild(projectId: string, db: Db = sql): Promise<void> {
  await db`
    INSERT INTO project_finding_feature_work (project_id, extractor_version)
    VALUES (${projectId}::uuid, ${EXTRACTOR_VERSION})
    ON CONFLICT (project_id) DO UPDATE SET generation = gen_random_uuid(), extractor_version = ${EXTRACTOR_VERSION},
      cursor_id = NULL, status = 'pending', attempts = 0, error_code = NULL, next_run_at = now(), updated_at = now()`;
}

/** Durable, bounded registration also recovers obsolete failures without scanning
 * failed rows in every due-work query. Current-version work keeps its retry budget. */
export async function scanFeatureProjects(tx: TransactionSql): Promise<number> {
  const [scan] = await tx`SELECT cursor_id FROM project_finding_feature_scan WHERE id = 'global' FOR UPDATE SKIP LOCKED`;
  if (!scan) return 0;
  const projects = await tx`SELECT id FROM projects WHERE ${scan.cursor_id ? tx`id > ${scan.cursor_id}::uuid` : tx`true`}
    ORDER BY id LIMIT ${FEATURE_PROJECT_SCAN_SIZE}`;
  for (const project of projects) {
    await tx`INSERT INTO project_finding_feature_work (project_id, extractor_version)
      VALUES (${project.id}::uuid, ${EXTRACTOR_VERSION})
      ON CONFLICT (project_id) DO UPDATE SET generation = gen_random_uuid(), extractor_version = EXCLUDED.extractor_version,
        cursor_id = NULL, status = 'pending', attempts = 0, error_code = NULL, next_run_at = now(), updated_at = now()
      WHERE project_finding_feature_work.extractor_version IS DISTINCT FROM EXCLUDED.extractor_version`;
  }
  await tx`UPDATE project_finding_feature_scan
    SET cursor_id = ${projects.length < FEATURE_PROJECT_SCAN_SIZE ? null : projects.at(-1)?.id}::uuid WHERE id = 'global'`;
  return projects.length;
}

/** One locked batch is atomic: process crashes roll back to its durable checkpoint. */
export async function processFeatureBatch(db: Db = sql, enabled = () => true): Promise<number> {
  if (!enabled()) return 0;
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    await tx`SET LOCAL statement_timeout = '3000ms'`;
    const [maintenance] = await tx`SELECT phase, generation, runtime_role, target_version, CURRENT_USER AS current_role
      FROM platform_upgrade_state WHERE id = 'global' FOR SHARE`;
    if (!enabled() || !maintenance || maintenance.phase !== 'active' || !maintenanceIdentityMatches(maintenance as never, {
      generation: process.env.DEEPSONAR_UPGRADE_GENERATION ?? '', version: process.env.DEEPSONAR_VERSION ?? '',
    })) return 0;
    await scanFeatureProjects(raw);
    const [work] = await tx`SELECT * FROM project_finding_feature_work
      WHERE status <> 'failed' AND next_run_at <= now()
      ORDER BY next_run_at, project_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!work) return 0;
    const projectId = String(work.project_id);
    if (work.extractor_version !== EXTRACTOR_VERSION) {
      await requestFeatureRebuild(projectId, tx);
      return 0;
    }
    // Savepoint isolates derivation failures; neither source writes nor the checkpoint are lost.
    try {
      return await raw.savepoint(async (rawSavepoint) => {
        const batch = rawSavepoint as unknown as Db;
        const ids = await batch`SELECT id FROM findings WHERE project_id = ${projectId}::uuid
          ${work.cursor_id ? batch`AND id > ${work.cursor_id}::uuid` : batch``}
          ORDER BY id LIMIT ${FEATURE_BATCH_SIZE}`;
        await batch`UPDATE project_finding_feature_work SET status = 'running', updated_at = now() WHERE project_id = ${projectId}::uuid`;
        for (const item of ids) {
          const source = await loadFeatureSource(batch, String(item.id));
          if (!source) {
            await batch`DELETE FROM project_finding_features WHERE finding_id = ${item.id}::uuid`;
            continue;
          }
          const evidence = (source.artifact_evidence as { evidence?: unknown[] } | undefined)?.evidence;
          if (Array.isArray(evidence) && evidence.length >= 129) throw new Error('source_evidence_budget_exceeded');
          const features = extractFindingFeatures(source);
          // Re-read before publishing; read paths also check current source, even after commit.
          const current = await loadFeatureSource(batch, String(item.id));
          if (!current || sourceInputDigest(current) !== sourceInputDigest(source)) continue;
          await batch`INSERT INTO project_finding_features (finding_id, project_id, generation, extractor_version, input_digest, features_json)
            VALUES (${item.id}::uuid, ${projectId}::uuid, ${work.generation}::uuid, ${EXTRACTOR_VERSION}, ${sourceInputDigest(source)}, ${batch.json(features as never)})
            ON CONFLICT (finding_id, generation) DO UPDATE SET extractor_version = EXCLUDED.extractor_version,
              input_digest = EXCLUDED.input_digest, features_json = EXCLUDED.features_json, processed_at = now()
            WHERE project_finding_features.input_digest IS DISTINCT FROM EXCLUDED.input_digest
              OR project_finding_features.extractor_version IS DISTINCT FROM EXCLUDED.extractor_version`;
        }
        if (!enabled()) throw new Error('maintenance_stopped');
        const done = ids.length < FEATURE_BATCH_SIZE;
        await batch`UPDATE project_finding_feature_work SET cursor_id = ${done ? null : ids.at(-1)?.id}::uuid,
          status = ${done ? 'succeeded' : 'pending'}, active_generation = CASE WHEN ${done} THEN generation ELSE active_generation END,
          attempts = 0, error_code = NULL, updated_at = now(), next_run_at = now() + ${done ? FEATURE_RESCAN_SECONDS : 0} * interval '1 second'
          WHERE project_id = ${projectId}::uuid AND generation = ${work.generation}::uuid`;
        return ids.length;
      });
    } catch {
      if (!enabled()) return 0;
      await tx`UPDATE project_finding_feature_work SET attempts = LEAST(attempts + 1, 3),
        status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
        error_code = 'FEATURE_EXTRACTION_FAILED', next_run_at = now() + interval '30 seconds', updated_at = now()
        WHERE project_id = ${projectId}::uuid AND generation = ${work.generation}::uuid`;
      return 0;
    }
  });
}

/** No evidence body or derived titles leak here. Authorization precedes this call. */
export async function readFeatureStatus(findingId: string, projectId: string, db: Db = sql) {
  const source = await loadFeatureSource(db, findingId);
  if (!source || source.project_id !== projectId) return null;
  const [row] = await db`SELECT w.status, w.generation, w.active_generation, w.error_code, w.attempts,
      p.extractor_version, p.input_digest, p.processed_at, p.features_json
    FROM project_finding_feature_work w
    LEFT JOIN project_finding_features p ON p.finding_id = ${findingId}::uuid AND p.project_id = w.project_id
      AND p.generation = w.active_generation
    WHERE w.project_id = ${projectId}::uuid`;
  const current = await loadFeatureSource(db, findingId);
  const fresh = current && row?.input_digest === sourceInputDigest(current) && row.extractor_version === EXTRACTOR_VERSION;
  return {
    status: row?.status === 'failed' ? 'failed' : !row?.input_digest ? 'pending' : fresh ? 'succeeded' : 'stale',
    rebuilding: Boolean(row && row.generation !== row.active_generation),
    generation: fresh ? row?.active_generation : null,
    extractor_version: EXTRACTOR_VERSION,
    processed_at: fresh ? row?.processed_at : null,
    error_code: row?.error_code ?? null,
    attempts: row?.attempts ?? 0,
    // V1 has no authority adapter: never suggest identity from matching unknowns.
    identity_status: 'insufficient_information',
    authoritative_identity_fields: 0,
    declared_field_coverage: fresh ? { profile: Boolean(current.profile), category: Boolean(current.category), location: Boolean(current.location) } : null,
    relationship_status: 'quality_gate_not_evaluated',
  };
}

/** Operator-only bounded pruning. The caller must hold one transaction through deletion. */
export async function pruneInactiveFeatureBatch(projectId: string, db: TransactionSql): Promise<number> {
  const [work] = await db`SELECT generation, active_generation FROM project_finding_feature_work
    WHERE project_id = ${projectId}::uuid FOR UPDATE`;
  if (!work) return 0;
  const removed = await db`DELETE FROM project_finding_features WHERE (finding_id, generation) IN (
    SELECT finding_id, generation FROM project_finding_features WHERE project_id = ${projectId}::uuid
      AND generation <> ${work.generation}::uuid
      AND generation IS DISTINCT FROM ${work.active_generation}::uuid
    ORDER BY generation, finding_id LIMIT 500
  ) RETURNING finding_id`;
  return removed.length;
}
