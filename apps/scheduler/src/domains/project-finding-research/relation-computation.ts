import type { TransactionSql } from "postgres";
import { sql } from "../../db.js";
import { maintenanceIdentityMatches } from "../../platform-maintenance.js";
import {
  compareAuthoritativeIdentity,
  STRONG_IDENTITY_FIELDS,
  STRONG_RELATION_QUALITY_GATE_STATUS,
  STRONG_RELATION_RULE_VERSION,
  type CurrentIdentitySnapshot,
} from "./identity.js";
import { loadCurrentIdentitySnapshot } from "./identity-mapping-store.js";
import { fail } from "./relation-errors.js";
import { requestStrongRelationRebuild } from "./relation-work.js";

type Db = typeof sql;

export const RELATION_BATCH_SIZE = 5;
export const RELATION_PROJECT_SCAN_SIZE = 25;
export const RELATION_PAIR_LIMIT = 256;

export interface FindingEnvelope {
  id: string;
  project_id: string;
  canvas_id: string;
  source_fingerprint: string;
}

export async function loadFindingEnvelope(
  db: Db,
  findingId: string,
  projectId?: string | null,
): Promise<FindingEnvelope | null> {
  const [row] = await db`
    SELECT f.id, f.project_id, j.canvas_id,
      'sha256:' || encode(sha256(convert_to(
        jsonb_build_array(f.source_digest, f.updated_at, f.title, f.location, f.summary,
          f.profile, f.category, f.artifact_id, f.evidence_refs_json)::text, 'UTF8')), 'hex') AS source_fingerprint
    FROM findings f
    JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
    JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
    WHERE f.id = ${findingId}::uuid
      AND (${projectId ?? null}::uuid IS NULL OR f.project_id = ${projectId ?? null}::uuid)`;
  return row ? {
    id: String(row.id),
    project_id: String(row.project_id),
    canvas_id: String(row.canvas_id),
    source_fingerprint: String(row.source_fingerprint),
  } : null;
}

async function scanRelationProjects(tx: TransactionSql): Promise<number> {
  const [scan] = await tx`SELECT cursor_id FROM project_finding_relation_scan
    WHERE id = 'global' FOR UPDATE SKIP LOCKED`;
  if (!scan) return 0;
  const projects = await tx`SELECT id FROM projects
    WHERE ${scan.cursor_id ? tx`id > ${scan.cursor_id}::uuid` : tx`true`}
    ORDER BY id LIMIT ${RELATION_PROJECT_SCAN_SIZE}`;
  for (const project of projects) {
    await tx`INSERT INTO project_finding_relation_work(project_id, rule_version)
      VALUES (${project.id}::uuid, ${STRONG_RELATION_RULE_VERSION})
      ON CONFLICT(project_id) DO UPDATE SET generation=gen_random_uuid(),
        rule_version=EXCLUDED.rule_version, cursor_id=NULL, status='pending', attempts=0,
        error_code=NULL, next_run_at=now(), updated_at=now()
      WHERE project_finding_relation_work.rule_version IS DISTINCT FROM EXCLUDED.rule_version`;
  }
  await tx`UPDATE project_finding_relation_scan SET cursor_id =
    ${projects.length < RELATION_PROJECT_SCAN_SIZE ? null : projects.at(-1)?.id}::uuid
    WHERE id = 'global'`;
  return projects.length;
}

async function saveTruncatedSource(
  tx: Db,
  projectId: string,
  generation: string,
  findingId: string,
  envelope: FindingEnvelope,
  snapshot: CurrentIdentitySnapshot,
): Promise<void> {
  await tx`INSERT INTO project_finding_relation_sources(
      project_id, generation, finding_id, source_fingerprint, identity_fingerprint,
      rule_version, examined, pair_truncated, read_status, read_reason
    ) VALUES (
      ${projectId}::uuid, ${generation}::uuid, ${findingId}::uuid,
      ${envelope.source_fingerprint}, ${snapshot.fingerprint},
      ${STRONG_RELATION_RULE_VERSION}, 0, true, 'truncated', 'IDENTITY_MAPPING_HISTORY_LIMIT'
    ) ON CONFLICT(project_id, generation, finding_id) DO UPDATE SET
      source_fingerprint=EXCLUDED.source_fingerprint, identity_fingerprint=EXCLUDED.identity_fingerprint,
      rule_version=EXCLUDED.rule_version, examined=EXCLUDED.examined,
      pair_truncated=EXCLUDED.pair_truncated, read_status=EXCLUDED.read_status,
      read_reason=EXCLUDED.read_reason, processed_at=now()`;
}

async function computeRelationSource(
  tx: Db,
  projectId: string,
  generation: string,
  findingId: string,
): Promise<void> {
  const envelope = await loadFindingEnvelope(tx, findingId, projectId);
  if (!envelope) return;
  const snapshot = await loadCurrentIdentitySnapshot(findingId, projectId, tx);
  await tx`DELETE FROM project_finding_relations
    WHERE project_id = ${projectId}::uuid AND generation = ${generation}::uuid
      AND left_id = ${findingId}::uuid`;
  await tx`DELETE FROM project_finding_relation_sources
    WHERE project_id = ${projectId}::uuid AND generation = ${generation}::uuid
      AND finding_id = ${findingId}::uuid`;
  if (snapshot.history_truncated) {
    await saveTruncatedSource(tx, projectId, generation, findingId, envelope, snapshot);
    return;
  }

  const root = snapshot.fields.root_cause;
  let candidates: Array<{ finding_id: string }> = [];
  if (root.status === "valid" && root.identity_digest) {
    candidates = await tx`SELECT DISTINCT m.finding_id
      FROM project_finding_identity_mappings m
      JOIN project_finding_identity_sources s
        ON s.project_id = m.project_id AND s.source_id = m.source_id
       AND s.finding_id = m.finding_id
      JOIN project_finding_identity_source_revisions r
        ON r.project_id = m.project_id AND r.source_id = m.source_id
       AND r.finding_id = m.finding_id AND r.revision = m.source_revision
      WHERE m.project_id = ${projectId}::uuid AND m.field = 'root_cause'
        AND r.identity_fields_json ->> 'root_cause' = ${root.identity_digest}
        AND m.revoked_at IS NULL AND s.revoked_at IS NULL
        AND s.current_revision = m.source_revision AND r.freshness_until > now()
        AND m.finding_id > ${findingId}::uuid
      ORDER BY m.finding_id LIMIT ${RELATION_PAIR_LIMIT + 1}` as Array<{ finding_id: string }>;
  }
  const pairTruncated = candidates.length > RELATION_PAIR_LIMIT;
  const peers = new Map<string, FindingEnvelope>();
  const peerSnapshots = new Map<string, CurrentIdentitySnapshot>();
  for (const candidate of candidates.slice(0, RELATION_PAIR_LIMIT)) {
    const peerId = String(candidate.finding_id);
    const peerEnvelope = await loadFindingEnvelope(tx, peerId, projectId);
    if (!peerEnvelope) continue;
    const peerSnapshot = await loadCurrentIdentitySnapshot(peerId, projectId, tx);
    if (peerSnapshot.history_truncated) continue;
    const decision = compareAuthoritativeIdentity(snapshot, peerSnapshot);
    if (decision.kind !== "same_problem" && decision.kind !== "same_root_cause_different_instance") continue;
    peers.set(peerId, peerEnvelope);
    peerSnapshots.set(peerId, peerSnapshot);
    const [leftId, rightId] = [findingId, peerId].sort();
    const left = leftId === findingId ? envelope : peerEnvelope;
    const right = rightId === findingId ? envelope : peerEnvelope;
    const leftIdentity = leftId === findingId ? snapshot : peerSnapshot;
    const rightIdentity = rightId === findingId ? snapshot : peerSnapshot;
    await tx`INSERT INTO project_finding_relations(
      project_id, generation, left_id, right_id, left_source_fingerprint,
      right_source_fingerprint, left_identity_fingerprint, right_identity_fingerprint,
      relation_kind, matched_fields, different_fields, root_cause_continuation,
      rule_version, quality_gate_status, published
    ) VALUES (
      ${projectId}::uuid, ${generation}::uuid, ${leftId}::uuid, ${rightId}::uuid,
      ${left.source_fingerprint}, ${right.source_fingerprint},
      ${leftIdentity.fingerprint}, ${rightIdentity.fingerprint}, ${decision.kind},
      ${decision.matched_fields}, ${decision.different_fields}, ${decision.root_cause_continuation},
      ${STRONG_RELATION_RULE_VERSION}, ${STRONG_RELATION_QUALITY_GATE_STATUS}, false
    ) ON CONFLICT(project_id, generation, left_id, right_id) DO UPDATE SET
      left_source_fingerprint=EXCLUDED.left_source_fingerprint,
      right_source_fingerprint=EXCLUDED.right_source_fingerprint,
      left_identity_fingerprint=EXCLUDED.left_identity_fingerprint,
      right_identity_fingerprint=EXCLUDED.right_identity_fingerprint,
      relation_kind=EXCLUDED.relation_kind, matched_fields=EXCLUDED.matched_fields,
      different_fields=EXCLUDED.different_fields,
      root_cause_continuation=EXCLUDED.root_cause_continuation,
      rule_version=EXCLUDED.rule_version, quality_gate_status=EXCLUDED.quality_gate_status,
      published=EXCLUDED.published, processed_at=now()`;
  }

  const current = await loadFindingEnvelope(tx, findingId, projectId);
  if (!current || current.source_fingerprint !== envelope.source_fingerprint) fail("RELATION_SOURCE_CHANGED");
  for (const [peerId, before] of peers) {
    const after = await loadFindingEnvelope(tx, peerId, projectId);
    if (!after || after.source_fingerprint !== before.source_fingerprint) fail("RELATION_SOURCE_CHANGED");
  }
  await tx`INSERT INTO project_finding_relation_sources(
    project_id, generation, finding_id, source_fingerprint, identity_fingerprint,
    rule_version, examined, pair_truncated, read_status, read_reason
  ) VALUES (
    ${projectId}::uuid, ${generation}::uuid, ${findingId}::uuid,
    ${envelope.source_fingerprint}, ${snapshot.fingerprint},
    ${STRONG_RELATION_RULE_VERSION}, ${Math.min(candidates.length, RELATION_PAIR_LIMIT)},
    ${pairTruncated}, 'complete', NULL
  ) ON CONFLICT(project_id, generation, finding_id) DO UPDATE SET
    source_fingerprint=EXCLUDED.source_fingerprint, identity_fingerprint=EXCLUDED.identity_fingerprint,
    rule_version=EXCLUDED.rule_version, examined=EXCLUDED.examined,
    pair_truncated=EXCLUDED.pair_truncated, read_status=EXCLUDED.read_status,
    read_reason=EXCLUDED.read_reason, processed_at=now()`;
}

/** Durable, restartable derivation. It remains gated by the maintenance fence. */
export async function processStrongRelationBatch(db: Db = sql, enabled = () => true): Promise<number> {
  if (!enabled()) return 0;
  return db.begin("isolation level repeatable read", async (raw) => {
    const tx = raw as unknown as Db;
    await tx`SET LOCAL statement_timeout = '3000ms'`;
    const [maintenance] = await tx`SELECT phase, generation, runtime_role, target_version,
      CURRENT_USER AS current_role FROM platform_upgrade_state WHERE id = 'global' FOR SHARE`;
    if (!enabled() || !maintenance || maintenance.phase !== "active" || !maintenanceIdentityMatches(maintenance as never, {
      generation: process.env.DEEPSONAR_UPGRADE_GENERATION ?? "",
      version: process.env.DEEPSONAR_VERSION ?? "",
    })) return 0;
    await scanRelationProjects(raw);
    let [work] = await tx`SELECT * FROM project_finding_relation_work
      WHERE status <> 'failed' AND next_run_at <= now()
      ORDER BY next_run_at, project_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!work) return 0;
    const project = String(work.project_id);
    if (work.rule_version !== STRONG_RELATION_RULE_VERSION || work.status === "succeeded") {
      await requestStrongRelationRebuild(project, tx);
      [work] = await tx`SELECT * FROM project_finding_relation_work WHERE project_id = ${project}::uuid`;
    }
    try {
      return await raw.savepoint(async (savepoint) => {
        const batch = savepoint as unknown as Db;
        const ids = await batch`SELECT id FROM findings WHERE project_id = ${project}::uuid
          ${work.cursor_id ? batch`AND id > ${work.cursor_id}::uuid` : batch``}
          ORDER BY id LIMIT ${RELATION_BATCH_SIZE}`;
        await batch`UPDATE project_finding_relation_work SET status = 'running', updated_at = now()
          WHERE project_id = ${project}::uuid`;
        for (const row of ids) await computeRelationSource(batch, project, String(work.generation), String(row.id));
        if (!enabled()) throw new Error("maintenance_stopped");
        const done = ids.length < RELATION_BATCH_SIZE;
        await batch`UPDATE project_finding_relation_work SET cursor_id =
          ${done ? null : ids.at(-1)?.id}::uuid, status = ${done ? "succeeded" : "running"},
          active_generation = CASE WHEN ${done} THEN generation ELSE active_generation END,
          attempts = 0, error_code = NULL, updated_at = now(),
          next_run_at = now() + ${done ? 30 : 0} * interval '1 second'
          WHERE project_id = ${project}::uuid AND generation = ${work.generation}::uuid`;
        return ids.length;
      });
    } catch (error) {
      if (!enabled()) return 0;
      const code = error instanceof Error && error.message === "RELATION_SOURCE_CHANGED"
        ? error.message : "STRONG_RELATION_COMPUTATION_FAILED";
      await tx`UPDATE project_finding_relation_work SET attempts = LEAST(attempts + 1, 3),
        status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
        error_code = ${code}, next_run_at = now() + interval '30 seconds', updated_at = now()
        WHERE project_id = ${project}::uuid AND generation = ${work.generation}::uuid`;
      return 0;
    }
  });
}
