import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

type TestSql = typeof import("./db.js").sql;
const REFERENCES = [
  ["project_finding_candidate_sources", "finding_id", "project_finding_candidate_sources_finding_idx"],
  ["project_finding_candidate_edges", "left_id", "project_finding_candidate_edges_left_finding_idx"],
  ["project_finding_candidate_edges", "right_id", "project_finding_candidate_edges_right_finding_idx"],
] as const;

async function snapshot(db: TestSql, project: string, job: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(JSON.stringify([...await db`SELECT to_jsonb(f) AS row FROM findings f WHERE job_id=${job} ORDER BY id`]));
  for (const table of ["project_finding_candidate_sources", "project_finding_candidate_edges"]) {
    digest.update(JSON.stringify([...await db.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE project_id=$1 ORDER BY to_jsonb(t)::text`, [project])]));
  }
  return digest.digest("hex");
}

/** Multi-generation FK probes are synthetic engineering evidence, not a production capacity benchmark. */
export async function prepareFindingCandidateRetryFixture(db: TestSql, job: string, otherJob: string) {
  const [owner] = await db`SELECT project_id FROM jobs WHERE id=${job}`;
  const [otherOwner] = await db`SELECT project_id FROM jobs WHERE id=${otherJob}`;
  const project = String(owner.project_id), otherProject = String(otherOwner.project_id);
  for (const [scope, sourceJob] of [[project, job], [otherProject, otherJob]]) {
    await db`INSERT INTO findings(project_id,job_id,fingerprint,title,severity)
      SELECT ${scope},${sourceJob},gen_random_uuid()::text,'synthetic retry Finding','medium'
      FROM generate_series(1,2048)`;
    const generations = Array.from({ length: 4 }, () => randomUUID());
    await db`INSERT INTO project_finding_candidate_sources(project_id,generation,finding_id,input_digest,lexical_digest,rule_version,examined,rank_truncated)
      SELECT ${scope},g.generation,f.id,'synthetic-input','synthetic-lexical','retry-fixture',0,false
      FROM findings f CROSS JOIN unnest(${db.array(generations)}::uuid[]) g(generation)
      WHERE f.job_id=${sourceJob}`;
    await db`WITH pairs AS (
        SELECT id AS left_id,lead(id) OVER (ORDER BY id) AS right_id FROM findings WHERE job_id=${sourceJob}
      ) INSERT INTO project_finding_candidate_edges(project_id,generation,left_id,right_id,left_input_digest,right_input_digest,left_lexical_digest,right_lexical_digest,kind,score,matched_fields,rule_version)
      SELECT ${scope},g.generation,p.left_id,p.right_id,'synthetic-input','synthetic-input','synthetic-lexical','synthetic-lexical','similar',0.5,ARRAY['title'],'retry-fixture'
      FROM pairs p CROSS JOIN unnest(${db.array(generations)}::uuid[]) g(generation)
      WHERE p.right_id IS NOT NULL`;
  }
  await db.unsafe("ANALYZE findings; ANALYZE project_finding_candidate_sources; ANALYZE project_finding_candidate_edges");
  const probe = randomUUID();
  await db.begin(async raw => {
    const tx = raw as unknown as TestSql;
    const plan = async (table: string, column: string) => {
      // The same no-match DELETE shape used by ON DELETE CASCADE; no row is removed.
      const [row] = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM ONLY public.${table} WHERE project_id=$1 AND ${column}=$2`, [project, probe]);
      const root = row["QUERY PLAN"][0].Plan;
      return { text: JSON.stringify(root), buffers: Number(root["Shared Hit Blocks"] ?? 0) + Number(root["Shared Read Blocks"] ?? 0) };
    };
    await tx.unsafe("SAVEPOINT generation_gap_layout");
    for (const [, , index] of REFERENCES) await tx.unsafe(`DROP INDEX ${index}`);
    const old = [];
    for (const [table, column] of REFERENCES) old.push(await plan(table, column));
    await tx.unsafe("ROLLBACK TO SAVEPOINT generation_gap_layout");
    for (const [ordinal, [table, column, index]] of REFERENCES.entries()) {
      const current = await plan(table, column);
      assert.ok(current.text.includes(`\"Index Name\":\"${index}\"`), `${table}.${column}: use the complete FK prefix without an intervening generation`);
      assert.ok(old[ordinal].buffers > current.buffers, `${table}.${column}: ${old[ordinal].buffers} old vs ${current.buffers} indexed buffers; no forced planner settings or wall-time threshold`);
      console.info(`[retry-fk] ${table}.${column}: ${old[ordinal].buffers} old vs ${current.buffers} indexed buffers`);
    }
  });
  return { project, otherProject, job, otherJob, before: await snapshot(db, project, job), unrelated: await snapshot(db, otherProject, otherJob) };
}

export async function assertFindingCandidateRetryReferences(db: TestSql, fixture: Awaited<ReturnType<typeof prepareFindingCandidateRetryFixture>>, reset: boolean): Promise<void> {
  assert.equal(await snapshot(db, fixture.otherProject, fixture.otherJob), fixture.unrelated, "retry cannot mutate another project's Finding or multi-generation candidate rows");
  if (!reset) {
    assert.equal(await snapshot(db, fixture.project, fixture.job), fixture.before, "failed HTTP retry must roll back Finding and candidate cascades in full");
    return;
  }
  const [findings] = await db`SELECT count(*)::int AS n FROM findings WHERE job_id=${fixture.job}`;
  assert.equal(findings.n, 0);
  for (const table of ["project_finding_candidate_sources", "project_finding_candidate_edges"]) {
    const [rows] = await db.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`, [fixture.project]);
    assert.equal(rows.n, 0, `${table}: old Finding references must be removed by the existing cascade`);
  }
}
