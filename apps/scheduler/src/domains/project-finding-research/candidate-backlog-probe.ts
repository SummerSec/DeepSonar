/** Opt-in local synthetic complete-sweep probe. Never opens the supplied database itself. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';
import postgres from 'postgres';
import { counterDelta, summarizeBacklog, type BacklogSample } from './candidate-backlog-probe-metrics.js';

type Db = ReturnType<typeof postgres>;
const tables = ['project_finding_candidate_scan', 'project_finding_candidate_work', 'project_finding_candidate_sources', 'project_finding_candidate_edges'];
const counters = ['xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted', 'temp_files', 'temp_bytes', 'deadlocks', 'blk_read_time', 'blk_write_time'];
async function resources(db: Db, observer: Db, name: string) {
  // Flush this probe's single worker connection; do not reset shared server statistics.
  await db`SELECT pg_stat_force_next_flush()`;
  await observer`SELECT pg_stat_clear_snapshot()`;
  const [stats] = await observer`SELECT * FROM pg_stat_database WHERE datname=${name}`;
  const [size] = await db`SELECT pg_database_size(current_database()) AS bytes`;
  const [connections] = await observer`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${name}`;
  const relations = await db`SELECT relname,pg_table_size(relid)::float8 AS table_bytes,pg_indexes_size(relid)::float8 AS index_bytes,
    pg_total_relation_size(relid)::float8 AS total_bytes FROM pg_stat_user_tables WHERE relname=ANY(${tables}) ORDER BY relname`;
  const indexes = await db`SELECT indexrelname,pg_relation_size(indexrelid)::float8 AS bytes FROM pg_stat_user_indexes
    WHERE relname=ANY(${tables}) ORDER BY indexrelname`;
  return { counters: Object.fromEntries(counters.map(key => [key, Number(stats[key])])), stats_reset: stats.stats_reset,
    database_bytes: Number(size.bytes), observed_connections: Number(connections.n), relations: [...relations], indexes: [...indexes] };
}

export async function runCandidateBacklogProbe(testUrl: string, sourceCount = 45, cadenceMs = 25) {
  if (!testUrl.trim()) throw new Error('TEST_DATABASE_URL_REQUIRED');
  if (!Number.isInteger(sourceCount) || sourceCount < 30 || sourceCount > 100
    || !Number.isInteger(cadenceMs) || cadenceMs < 0 || cadenceMs > 1000) throw new Error('INVALID_PROBE_OPTIONS');
  const adminUrl = new URL(testUrl); adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const name = `candidate_backlog_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  const db = postgres(target.toString(), { max: 1, onnotice: () => {} });
  const previousUrl = process.env.DATABASE_URL;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    process.env.DATABASE_URL = target.toString();
    await db.unsafe(readFileSync(new URL('../../../../../database/schema.sql', import.meta.url), 'utf8'));
    const { processCandidateBatch, requestCandidateRebuild } = await import('./candidate-store.js');
    const { readCandidatePage } = await import('./candidate-read.js');
    const { CANDIDATE_RULE_VERSION } = await import('./candidate-source.js');
    const project = randomUUID(), canvas = randomUUID(), ids: string[] = [];
    await db`INSERT INTO projects(id,name) VALUES (${project},'synthetic backlog probe')`;
    await db`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'probe only')`;
    const addSource = async (n: number) => {
      const id = `77200000-0000-0000-0000-${String(n).padStart(12, '0')}`, job = randomUUID(); ids.push(id);
      const group = n % 10 < 6 ? 'hotspot' : n % 10 < 8 ? 'sparse' : 'missing';
      const title = group === 'hotspot' ? '中文 参数 注入 相似声明' : `${group}${n} 独立声明${n}`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES (${job},${project},${canvas},'audit','succeeded','{}')`;
      await db`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,location,category,profile)
        VALUES (${id},${project},${job},${String(n)},${title},${group === 'missing' ? null : group === 'hotspot' ? 'matching synthetic input without identity evidence' : `uniquetext${n}`},
          ${group === 'missing' ? null : group === 'hotspot' ? 'src/shared.ts' : `src/file${n}.ts`},${group === 'hotspot' ? 'synthetic-hotspot' : null},'security.vulnerability')`;
    };
    for (let n = 0; n < sourceCount; n++) await addSource(n);
    const distribution = await db`SELECT count(*)::int AS sources,count(DISTINCT job_id)::int AS jobs,
      count(*) FILTER(WHERE category='synthetic-hotspot')::int AS hotspot_sources,
      count(*) FILTER(WHERE category IS NULL AND summary IS NOT NULL)::int AS sparse_sources,
      count(*) FILTER(WHERE summary IS NULL)::int AS missing_summary,
      count(*) FILTER(WHERE location IS NULL)::int AS missing_location,
      count(*) FILTER(WHERE category IS NULL)::int AS missing_category,
      count(*) FILTER(WHERE artifact_id IS NULL)::int AS missing_artifact FROM findings`;
    const [server] = await db`SELECT version() AS version,current_setting('track_io_timing') AS track_io_timing`;
    const before = await resources(db, admin, name), clientBefore = process.resourceUsage();
    const origin = performance.now();
    const snapshot = async (phase: string, tick: number, processed = 0, workerMs = 0, waitMs = 0): Promise<BacklogSample> => {
      const [work] = await db`SELECT * FROM project_finding_candidate_work WHERE project_id=${project}`;
      const [counts] = await db`SELECT count(*)::int AS total,count(s.finding_id)::int AS recorded FROM findings f
        LEFT JOIN project_finding_candidate_sources s ON s.project_id=f.project_id AND s.finding_id=f.id AND s.generation=${work.generation}
        WHERE f.project_id=${project}`;
      return { phase,tick,elapsed_ms:performance.now()-origin,worker_ms:workerMs,requested_wait_ms:tick > 0 ? cadenceMs : 0,actual_wait_ms:waitMs,
        processed,total_sources:counts.total,recorded_sources:counts.recorded,pending_sources:counts.total-counts.recorded,
        status:work.status,generation:work.generation,active_generation:work.active_generation,cursor_id:work.cursor_id };
    };
    const phases: Array<{ name: string; samples: BacklogSample[]; summary: ReturnType<typeof summarizeBacklog> }> = [];
    let pause: { before: BacklogSample; after: BacklogSample } | undefined;
    const sweep = async (phase: string, pauseOnce: boolean) => {
      await db.begin(tx => requestCandidateRebuild(project, tx));
      const samples = [await snapshot(phase, 0)];
      for (let tick = 1; tick <= Math.ceil((sourceCount + 1) / 5) + 3; tick++) {
        const waiting = performance.now(); await new Promise(resolve => setTimeout(resolve, cadenceMs));
        const actualWait = performance.now() - waiting, started = performance.now();
        const processed = await processCandidateBatch(db), workerMs = performance.now() - started;
        const sample = await snapshot(phase,tick,processed,workerMs,actualWait); samples.push(sample);
        assert.notEqual(sample.status,'failed','probe generation failed');
        if (pauseOnce && tick === 1) {
          const beforePause = sample, startPause = performance.now();
          assert.equal(await processCandidateBatch(db, () => false),0);
          const afterPause = await snapshot('scheduler_stop_gate',0,0,performance.now()-startPause);
          for (const key of ['generation','active_generation','cursor_id','status','recorded_sources','pending_sources'] as const) assert.equal(afterPause[key],beforePause[key]);
          pause = { before:beforePause, after:afterPause };
        }
        if (sample.status === 'succeeded') break;
      }
      const summary = summarizeBacklog(samples); assert.equal(summary.complete,true,'must finish a real full generation');
      phases.push({name:phase,samples,summary});
    };
    await sweep('initial_complete_generation',true);
    const initial = await readCandidatePage(ids[0],undefined,db,project); assert.equal(initial?.status,'succeeded'); assert.ok(initial.items.length > 0);
    await db`UPDATE findings SET title='changed isolated declaration',summary='new source after publication' WHERE id=${ids[0]}`;
    await addSource(sourceCount);
    const invalidated = await readCandidatePage(ids[0],undefined,db,project);
    assert.equal(invalidated?.status,'stale'); assert.equal(invalidated.items.length,0);
    await sweep('explicit_rebuild_after_edit_and_insert',false);
    const rebuilt = await readCandidatePage(ids[0],undefined,db,project);
    assert.equal(rebuilt?.status,'succeeded'); assert.notEqual(rebuilt.active_generation,initial.active_generation);
    const after = await resources(db,admin,name), clientAfter = process.resourceUsage();
    assert.deepEqual(after.stats_reset,before.stats_reset,'statistics reset during measurement');
    return { sample_kind:'synthetic complete candidate generations; no quality or identity labels', node:process.version, postgres:server.version,
      client_host:{cpu_model:cpus()[0]?.model??null,logical_cpus:cpus().length,total_memory_bytes:totalmem(),
        scope:'client host OS-visible resources; not PostgreSQL allocation, container quota or peak usage'},
      rule_version:CANDIDATE_RULE_VERSION, measured_scenario_wall_ms:performance.now()-origin, input_distribution:distribution[0], initial_sources:sourceCount, rebuilt_sources:sourceCount+1,
      cadence:{probe_wait_ms:cadenceMs,production_worker_wait_ms:2000,production_resweep_delay_seconds:30,
        mode:'explicit rebuild, sequential candidate-only worker; feature worker omitted; not production cadence'},
      phases,pause,source_change:{old_items:initial.items.length,invalidated_status:invalidated.status,invalidated_items:invalidated.items.length,
        rebuilt_status:rebuilt.status,new_generation_published:rebuilt.active_generation!==initial.active_generation},
      database_resources:{before,after,delta:counterDelta(before.counters,after.counters),track_io_timing:server.track_io_timing},
      client_resources:{user_cpu_us:clientAfter.userCPUTime-clientBefore.userCPUTime,system_cpu_us:clientAfter.systemCPUTime-clientBefore.systemCPUTime,
        max_rss_kib_process_lifetime:clientAfter.maxRSS,includes:'Node client only; excludes PostgreSQL'},
      limitations:['One small single-project synthetic workload; no scale or quality inference.',
        'Single measured run without deliberate warmup; shared host contention is uncontrolled, not a percentile benchmark.',
        'Synthetic sources have no Artifact/Evidence rows or authoritative identity fields; evidence-heavy cost is not measured.',
        'Database counters include probe reads, snapshot queries and writes, with PostgreSQL asynchronous statistics timing.',
        'Single probe backend requests its stats flush; no shared statistics reset or privileged monitoring.',
        'Database sizes are allocated bytes including retained inactive generation, not peak memory or disk throughput.',
        'Connection count is sampled, not a peak. Container CPU/RSS and cluster-wide pg_stat_io are not measured.',
        'enabled=false tests Scheduler stop gate, not platform-maintenance transition or process crash.',
        'Full source counts are probe-only observation queries. Runtime LIMIT bounds returned rows, not physical database work.',
        'Timing includes instrumentation and deliberately shortened cadence; not a production SLA.'],
    };
  } finally {
    await db.end({timeout:5});
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({timeout:5});
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCandidateBacklogProbe(process.env.TEST_DATABASE_URL ?? '').then(result => console.log(JSON.stringify(result,null,2))).catch(() => {
    console.error('CANDIDATE_BACKLOG_PROBE_FAILED'); process.exitCode=1;
  });
}
