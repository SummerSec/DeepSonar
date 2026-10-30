/** Opt-in synthetic work-queue probe; creates/drops a private database, never uses a default. */
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';

type PlanNode = Record<string, unknown>;
function planNodes(plan: unknown): PlanNode[] {
  const roots = plan as Array<{ Plan: PlanNode }>;
  const visit = (node: PlanNode): PlanNode[] => [node, ...((node.Plans ?? []) as PlanNode[]).flatMap(visit)];
  return visit(roots[0].Plan);
}
function summarize(plan: unknown) {
  return planNodes(plan).map((node) => ({
    node: node['Node Type'], index: node['Index Name'] ?? null,
    actual_rows: node['Actual Rows'], actual_loops: node['Actual Loops'],
    rows_removed_by_filter: node['Rows Removed by Filter'] ?? 0,
    rows_removed_by_index_recheck: node['Rows Removed by Index Recheck'] ?? 0,
    shared_hit_blocks: node['Shared Hit Blocks'] ?? 0, shared_read_blocks: node['Shared Read Blocks'] ?? 0,
    sort_method: node['Sort Method'] ?? null,
  }));
}

async function main() {
  if (!process.env.TEST_DATABASE_URL?.trim()) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const adminUrl = new URL(process.env.TEST_DATABASE_URL); adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `feature_queue_probe_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let created = false;
  let close: (() => Promise<void>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    process.env.DATABASE_URL = target.toString();
    const { migrate, sql } = await import('../../db.js');
    const { scanFeatureProjects, FEATURE_PROJECT_SCAN_SIZE } = await import('./store.js');
    const { EXTRACTOR_VERSION } = await import('./model.js');
    close = () => sql.end({ timeout: 5 });
    await migrate();
    const [server] = await sql`SELECT version() AS version`;
    const results: unknown[] = [];
    let previousSize = 0;
    for (const size of [1_000, 10_000, 100_000]) {
      await sql`INSERT INTO projects (id, name)
        SELECT md5('feature-queue-probe:' || n)::uuid, 'queue synthetic ' || n
        FROM generate_series(${previousSize + 1}::int, ${size}::int) n`;
      // Deterministic proportions: 1% due pending, 94% current failed, 5% obsolete failed.
      // Failed rows are older than all pending rows, exposing full-index/filter work.
      await sql`INSERT INTO project_finding_feature_work (project_id, extractor_version, status, attempts, next_run_at)
        SELECT md5('feature-queue-probe:' || n)::uuid,
          CASE WHEN n % 100 BETWEEN 1 AND 5 THEN 'obsolete/v0' ELSE ${EXTRACTOR_VERSION} END,
          CASE WHEN n % 100 = 0 THEN 'pending' ELSE 'failed' END,
          CASE WHEN n % 100 = 0 THEN 0 ELSE 3 END,
          CASE WHEN n % 100 = 0 THEN now() - interval '1 minute'
            WHEN n % 100 BETWEEN 1 AND 5 THEN now() - interval '1 hour' ELSE now() - interval '2 hours' END
        FROM generate_series(1, ${size}) n
        ON CONFLICT (project_id) DO UPDATE SET extractor_version=EXCLUDED.extractor_version,
          status=EXCLUDED.status, attempts=EXCLUDED.attempts, next_run_at=EXCLUDED.next_run_at`;
      await sql`ANALYZE projects`; await sql`ANALYZE project_finding_feature_work`;
      const distribution = await sql`SELECT status, extractor_version, COUNT(*)::int AS count
        FROM project_finding_feature_work GROUP BY status, extractor_version ORDER BY status, extractor_version`;
      const [oldPlan] = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT * FROM project_finding_feature_work
        WHERE (status <> 'failed' OR extractor_version <> ${EXTRACTOR_VERSION}) AND next_run_at <= now()
        ORDER BY next_run_at, project_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const [newPlan] = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT * FROM project_finding_feature_work
        WHERE status <> 'failed' AND next_run_at <= now()
        ORDER BY next_run_at, project_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const oldRaw = oldPlan['QUERY PLAN'], newRaw = newPlan['QUERY PLAN'];
      assert.ok(planNodes(newRaw).some((node) => node['Index Name'] === 'project_finding_feature_work_due'), 'new query must actually use the existing partial index');
      assert.ok(!planNodes(newRaw).some((node) => node['Node Type'] === 'Sort'), 'new due query must not sort the project queue');
      assert.ok(planNodes(newRaw).every((node) => Number(node['Rows Removed by Filter'] ?? 0) === 0), 'current failed work must not be scanned then filtered');

      const [late] = await sql`SELECT id FROM projects ORDER BY id OFFSET ${size - 50} LIMIT 1`;
      const [registryPlan] = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id FROM projects WHERE id > ${late.id}::uuid ORDER BY id LIMIT ${FEATURE_PROJECT_SCAN_SIZE}`;
      const window = await sql`SELECT id FROM projects WHERE id > ${late.id}::uuid ORDER BY id LIMIT ${FEATURE_PROJECT_SCAN_SIZE}`;
      const ids = window.map((row) => row.id as string);
      const before = await sql`SELECT * FROM project_finding_feature_work WHERE project_id = ANY(${ids}::uuid[]) ORDER BY project_id`;
      const [oldCount] = await sql`SELECT COUNT(*)::int AS count FROM project_finding_feature_work WHERE extractor_version <> ${EXTRACTOR_VERSION}`;
      await sql`UPDATE project_finding_feature_scan SET cursor_id=${late.id}::uuid WHERE id='global'`;
      const start = performance.now();
      const scanned = await sql.begin(scanFeatureProjects);
      const registryMs = performance.now() - start;
      assert.equal(scanned, FEATURE_PROJECT_SCAN_SIZE);
      const after = await sql`SELECT * FROM project_finding_feature_work WHERE project_id = ANY(${ids}::uuid[]) ORDER BY project_id`;
      const expectedRecovered = before.filter((row) => row.extractor_version !== EXTRACTOR_VERSION).length;
      for (let index = 0; index < before.length; index += 1) {
        if (before[index].extractor_version === EXTRACTOR_VERSION) assert.deepEqual(after[index], before[index]);
        else {
          assert.equal(after[index].status, 'pending'); assert.equal(after[index].attempts, 0);
          assert.notEqual(after[index].generation, before[index].generation);
          assert.equal(after[index].active_generation, before[index].active_generation);
        }
      }
      const [remainingOld] = await sql`SELECT COUNT(*)::int AS count FROM project_finding_feature_work WHERE extractor_version <> ${EXTRACTOR_VERSION}`;
      assert.equal(Number(oldCount.count) - Number(remainingOld.count), expectedRecovered, 'only the registered window may recover old failures');
      const [checkpoint] = await sql`SELECT cursor_id FROM project_finding_feature_scan WHERE id='global'`;
      assert.equal(checkpoint.cursor_id, ids.at(-1));
      const [indexSize] = await sql`SELECT pg_relation_size('project_finding_feature_work_due') AS bytes`;
      results.push({ projects: size, distribution, queue_index_bytes: Number(indexSize.bytes),
        old_query: { summary: summarize(oldRaw), plan: oldRaw }, new_query: { summary: summarize(newRaw), plan: newRaw },
        registry: { budget: FEATURE_PROJECT_SCAN_SIZE, scanned, recovered: expectedRecovered, ms: registryMs,
          current_work_preserved: true, out_of_window_recovery: 0, persisted_checkpoint: true,
          summary: summarize(registryPlan['QUERY PLAN']), plan: registryPlan['QUERY PLAN'] } });
      previousSize = size;
    }
    console.log(JSON.stringify({ sample_kind: 'synthetic project queue, not human labels or association quality',
      node: process.version, arch: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length,
      host_memory_bytes: totalmem(), postgres: server.version, results }, null, 2));
  } finally {
    await close?.();
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof assert.AssertionError ? error.message : JSON.stringify({ error: 'FEATURE_QUEUE_PROBE_FAILED', code: (error as { code?: string })?.code ?? null }));
  process.exitCode = 1;
});
