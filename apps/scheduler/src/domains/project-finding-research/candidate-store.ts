import type { TransactionSql } from 'postgres';
import { sql } from '../../db.js';
import { maintenanceIdentityMatches } from '../../platform-maintenance.js';
import { searchFindingLexicalSnapshot } from './lexical-search.js';
import { CANDIDATE_BATCH_SIZE, CANDIDATE_PROJECT_SCAN_SIZE, CANDIDATE_RULE_VERSION, loadCandidateSource } from './candidate-source.js';

type Db = typeof sql;
export async function requestCandidateRebuild(projectId: string, tx: TransactionSql): Promise<void> {
  await tx`INSERT INTO project_finding_candidate_work(project_id,rule_version) VALUES (${projectId}::uuid,${CANDIDATE_RULE_VERSION})
    ON CONFLICT(project_id) DO UPDATE SET generation=gen_random_uuid(),rule_version=EXCLUDED.rule_version,
      cursor_id=NULL,status='pending',attempts=0,error_code=NULL,next_run_at=now(),updated_at=now()`;
}

export async function scanCandidateProjects(tx: TransactionSql): Promise<number> {
  const [scan] = await tx`SELECT cursor_id FROM project_finding_candidate_scan WHERE id='global' FOR UPDATE SKIP LOCKED`;
  if (!scan) return 0;
  const projects = await tx`SELECT id FROM projects WHERE ${scan.cursor_id ? tx`id>${scan.cursor_id}::uuid` : tx`true`}
    ORDER BY id LIMIT ${CANDIDATE_PROJECT_SCAN_SIZE}`;
  for (const project of projects) {
    await tx`INSERT INTO project_finding_candidate_work(project_id,rule_version) VALUES (${project.id}::uuid,${CANDIDATE_RULE_VERSION})
      ON CONFLICT(project_id) DO UPDATE SET generation=gen_random_uuid(),rule_version=EXCLUDED.rule_version,
        cursor_id=NULL,status='pending',attempts=0,error_code=NULL,next_run_at=now(),updated_at=now()
      WHERE project_finding_candidate_work.rule_version IS DISTINCT FROM EXCLUDED.rule_version`;
  }
  await tx`UPDATE project_finding_candidate_scan SET cursor_id=${projects.length<CANDIDATE_PROJECT_SCAN_SIZE ? null : projects.at(-1)?.id}::uuid WHERE id='global'`;
  return projects.length;
}

async function computeSource(tx: TransactionSql, project: string, generation: string, id: string) {
  const initial = await loadCandidateSource(tx,id,project);
  if (!initial) return;
  const result = await searchFindingLexicalSnapshot(tx,id,undefined,project);
  if (!result || result.subject_digest !== initial.lexical_digest) return;
  for (const item of result.items) {
    const candidate = await loadCandidateSource(tx,item.finding_id,project);
    if (!candidate || candidate.lexical_digest !== item.lexical_digest) continue;
    const [left,right] = [id,item.finding_id].sort();
    // Compatible shared endpoint locks in canonical order; writers cannot change findings before checkpoint commit.
    await tx`SELECT id FROM findings WHERE project_id=${project}::uuid AND id IN (${left}::uuid,${right}::uuid) ORDER BY id FOR SHARE`;
    const current = await loadCandidateSource(tx,id,project), peer = await loadCandidateSource(tx,item.finding_id,project);
    if (!current || !peer || current.input_digest!==initial.input_digest || peer.input_digest!==candidate.input_digest
      || current.lexical_digest!==initial.lexical_digest || peer.lexical_digest!==candidate.lexical_digest) continue;
    const l = id===left ? current : peer, r = id===left ? peer : current;
    await tx`INSERT INTO project_finding_candidate_edges(project_id,generation,left_id,right_id,
      left_input_digest,right_input_digest,left_lexical_digest,right_lexical_digest,kind,matched_fields,score,rule_version)
      VALUES (${project}::uuid,${generation}::uuid,${left}::uuid,${right}::uuid,
        ${l.input_digest},${r.input_digest},${l.lexical_digest},${r.lexical_digest},${item.kind},${item.matched_fields},${item.score},${CANDIDATE_RULE_VERSION})
      ON CONFLICT(project_id,generation,left_id,right_id) DO UPDATE SET
        left_input_digest=EXCLUDED.left_input_digest,right_input_digest=EXCLUDED.right_input_digest,
        left_lexical_digest=EXCLUDED.left_lexical_digest,right_lexical_digest=EXCLUDED.right_lexical_digest,
        kind=EXCLUDED.kind,matched_fields=EXCLUDED.matched_fields,score=EXCLUDED.score,rule_version=EXCLUDED.rule_version,processed_at=now()`;
  }
  const current = await loadCandidateSource(tx,id,project);
  if (!current || current.input_digest!==initial.input_digest || current.lexical_digest!==initial.lexical_digest) return;
  await tx`INSERT INTO project_finding_candidate_sources(project_id,generation,finding_id,input_digest,lexical_digest,rule_version,examined,rank_truncated,window_limited)
    VALUES (${project}::uuid,${generation}::uuid,${id}::uuid,${current.input_digest},${current.lexical_digest},${CANDIDATE_RULE_VERSION},${result.examined},${result.rank_truncated},true)
    ON CONFLICT(project_id,generation,finding_id) DO UPDATE SET input_digest=EXCLUDED.input_digest,
      lexical_digest=EXCLUDED.lexical_digest,rule_version=EXCLUDED.rule_version,examined=EXCLUDED.examined,
      rank_truncated=EXCLUDED.rank_truncated,processed_at=now()`;
}

/** Durable checkpoint and atomic generation publication; no source mutation. */
export async function processCandidateBatch(db: Db = sql, enabled=()=>true): Promise<number> {
  if (!enabled()) return 0;
  return db.begin(async tx=>{
    await tx`SET LOCAL statement_timeout='3000ms'`;
    const [maintenance] = await tx`SELECT phase,generation,runtime_role,target_version,CURRENT_USER AS current_role
      FROM platform_upgrade_state WHERE id='global' FOR SHARE`;
    if (!enabled() || !maintenance || maintenance.phase!=='active' || !maintenanceIdentityMatches(maintenance as never,{
      generation:process.env.DEEPSONAR_UPGRADE_GENERATION??'',version:process.env.DEEPSONAR_VERSION??'',
    })) return 0;
    await scanCandidateProjects(tx);
    let [work] = await tx`SELECT * FROM project_finding_candidate_work WHERE status<>'failed' AND next_run_at<=now()
      ORDER BY next_run_at,project_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!work) return 0;
    const project=String(work.project_id);
    if (work.rule_version!==CANDIDATE_RULE_VERSION || work.status==='succeeded') {
      await requestCandidateRebuild(project,tx);
      [work]=await tx`SELECT * FROM project_finding_candidate_work WHERE project_id=${project}::uuid`;
    }
    try {
      return await tx.savepoint(async batch=>{
        const ids=await batch`SELECT id FROM findings WHERE project_id=${project}::uuid
          ${work.cursor_id ? batch`AND id>${work.cursor_id}::uuid` : batch``} ORDER BY id LIMIT ${CANDIDATE_BATCH_SIZE}`;
        await batch`UPDATE project_finding_candidate_work SET status='running',updated_at=now() WHERE project_id=${project}::uuid`;
        for (const row of ids) await computeSource(batch,project,String(work.generation),String(row.id));
        if (!enabled()) throw new Error('maintenance_stopped');
        const done=ids.length<CANDIDATE_BATCH_SIZE;
        await batch`UPDATE project_finding_candidate_work SET cursor_id=${done?null:ids.at(-1)?.id}::uuid,
          status=${done?'succeeded':'running'},active_generation=CASE WHEN ${done} THEN generation ELSE active_generation END,
          attempts=0,error_code=NULL,updated_at=now(),next_run_at=now()+${done?30:0}*interval '1 second'
          WHERE project_id=${project}::uuid AND generation=${work.generation}::uuid`;
        return ids.length;
      });
    } catch(error) {
      if (!enabled()) return 0;
      const code=error instanceof Error && error.message==='CANDIDATE_EVIDENCE_BUDGET_EXCEEDED' ? error.message : 'CANDIDATE_COMPUTATION_FAILED';
      await tx`UPDATE project_finding_candidate_work SET attempts=LEAST(attempts+1,3),
        status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'pending' END,error_code=${code},
        next_run_at=now()+interval '30 seconds',updated_at=now() WHERE project_id=${project}::uuid AND generation=${work.generation}::uuid`;
      return 0;
    }
  });
}

/** Explicit operator cleanup, at most 500 derived rows; never active/build generations. */
export async function pruneInactiveCandidateBatch(project: string,tx: TransactionSql): Promise<number> {
  const [work]=await tx`SELECT generation,active_generation FROM project_finding_candidate_work WHERE project_id=${project}::uuid FOR UPDATE`;
  if (!work) return 0;
  const edges=await tx`DELETE FROM project_finding_candidate_edges WHERE (project_id,generation,left_id,right_id) IN (
    SELECT project_id,generation,left_id,right_id FROM project_finding_candidate_edges WHERE project_id=${project}::uuid
      AND generation<>${work.generation}::uuid AND generation IS DISTINCT FROM ${work.active_generation}::uuid
    ORDER BY generation,left_id,right_id LIMIT 500) RETURNING left_id`;
  const sources=await tx`DELETE FROM project_finding_candidate_sources WHERE (project_id,generation,finding_id) IN (
    SELECT project_id,generation,finding_id FROM project_finding_candidate_sources WHERE project_id=${project}::uuid
      AND generation<>${work.generation}::uuid AND generation IS DISTINCT FROM ${work.active_generation}::uuid
    ORDER BY generation,finding_id LIMIT ${500-edges.length}) RETURNING finding_id`;
  return edges.length+sources.length;
}
