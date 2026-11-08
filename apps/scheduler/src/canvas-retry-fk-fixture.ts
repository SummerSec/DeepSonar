import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

type TestSql = typeof import("./db.js").sql;
const REFERENCES = [
  ["canvas_edges", "from_node_id", "canvas_edges_from_node_idx"],
  ["canvas_edges", "to_node_id", "canvas_edges_to_node_idx"],
  ["human_messages", "human_node_id", "human_messages_human_node_idx"],
  ["human_messages", "target_node_id", "human_messages_target_node_idx"],
] as const;
async function references(db: TestSql, canvas: string): Promise<string> {
  const rows = [];
  for (const table of ["canvas_nodes", "canvas_edges", "human_messages", "jobs"]) {
    rows.push([...await db.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE canvas_id=$1 ORDER BY id`, [canvas])]);
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Synthetic planner/atomicity evidence, not a production capacity benchmark. */
export async function prepareCanvasRetryFkFixture(db: TestSql, canvas: string, job: string) {
  const project = randomUUID(), otherCanvas = randomUUID(), otherJob = randomUUID();
  const human = randomUUID(), target = randomUUID(), otherHuman = randomUUID(), otherTarget = randomUUID();
  await db`INSERT INTO projects(id,name) VALUES(${project},'unrelated retry references')`;
  await db`INSERT INTO canvases(id,project_id,title) VALUES(${otherCanvas},${project},'unrelated retry references')`;
  await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
    VALUES(${otherJob},${project},${otherCanvas},'explore','succeeded','{}'::jsonb)`;
  for (const [id, owner, kind] of [[human, canvas, 'human'], [target, canvas, 'analysis'],
    [otherHuman, otherCanvas, 'human'], [otherTarget, otherCanvas, 'analysis']] as const) {
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title) VALUES(${id},${owner},${kind},'retry reference')`;
  }
  await db`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type)
    VALUES(${canvas},${human},${target},'retry-fixture')`;
  await db`INSERT INTO human_messages(id,canvas_id,human_node_id,target_kind,target_node_id,target_job_id,body)
    VALUES(${randomUUID()},${canvas},${human},'job',${target},${job},'retry fixture')`;
  await db`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type)
    SELECT ${otherCanvas},${otherHuman}::uuid,${otherTarget}::uuid,'unrelated-fixture' FROM generate_series(1,2048)`;
  await db`INSERT INTO human_messages(id,canvas_id,human_node_id,target_kind,target_node_id,target_job_id,body)
    SELECT gen_random_uuid(),${otherCanvas},${otherHuman}::uuid,'job',${otherTarget}::uuid,${otherJob}::uuid,
      'unrelated fixture' FROM generate_series(1,2048)`;
  await db.unsafe("ANALYZE canvas_edges; ANALYZE human_messages");
  const probe = randomUUID(); // FK check after the task's references are gone: no matching row.
  await db.begin(async raw => {
    const tx = raw as unknown as TestSql;
    const plan = async (table: string, column: string): Promise<string> => {
      const [row] = await tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ONLY public.${table} x WHERE ${column}=$1 FOR KEY SHARE OF x`, [probe]);
      return JSON.stringify(row?.["QUERY PLAN"]);
    };
    await tx.unsafe("SAVEPOINT old_fk_layout");
    for (const [, , index] of REFERENCES) await tx.unsafe(`DROP INDEX ${index}`);
    for (const [table, column] of REFERENCES) {
      assert.match(await plan(table, column), /"Node Type":"Seq Scan"/, `${table}.${column}: unindexed reference check scans unrelated rows`);
    }
    await tx.unsafe("ROLLBACK TO SAVEPOINT old_fk_layout");
    for (const [table, column, index] of REFERENCES) {
      assert.ok((await plan(table, column)).includes(`"Index Name":"${index}"`), `${table}.${column}: reference check must use its leading-column index`);
    }
  });
  return { canvas, otherCanvas, human, target, before: await references(db, canvas), unrelated: await references(db, otherCanvas) };
}

export async function assertCanvasRetryReferences(db: TestSql, fixture: Awaited<ReturnType<typeof prepareCanvasRetryFkFixture>>, reset: boolean): Promise<void> {
  assert.equal(await references(db, fixture.otherCanvas), fixture.unrelated, "retry cannot change another project's node/message/edge/Job rows");
  if (!reset) {
    assert.equal(await references(db, fixture.canvas), fixture.before, "failure after reset must roll back every task reference and Job");
    return;
  }
  const [nodes] = await db`SELECT count(*)::int AS n FROM canvas_nodes WHERE id IN (${fixture.human},${fixture.target})`;
  const [edges] = await db`SELECT count(*)::int AS n FROM canvas_edges WHERE canvas_id=${fixture.canvas}`;
  const [messages] = await db`SELECT count(*)::int AS n FROM human_messages WHERE canvas_id=${fixture.canvas}`;
  assert.equal(nodes.n, 0);
  assert.equal(edges.n, 0);
  assert.equal(messages.n, 0);
}
