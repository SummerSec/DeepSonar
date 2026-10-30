/** Opt-in synthetic scale probe. Creates and drops its own disposable database. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; no default database is used');
  const adminUrl = new URL(process.env.TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `finding_feature_probe_${randomUUID().replaceAll('-', '')}`;
  const targetUrl = new URL(adminUrl); targetUrl.pathname = `/${name}`;
  let close: (() => Promise<void>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    process.env.DATABASE_URL = targetUrl.toString();
    const { migrate, sql } = await import('../../db.js');
    const { processFeatureBatch, requestFeatureRebuild } = await import('./store.js');
    close = () => sql.end({ timeout: 5 });
    await migrate();
    const results: unknown[] = [];
    for (const size of [1_000, 10_000, 100_000]) {
      const project = randomUUID(), canvas = randomUUID(), job = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${project},'synthetic feature probe')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'synthetic only')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${job},${project},${canvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,summary,profile)
        SELECT ${project}::uuid,${job}::uuid,n::text,'中文 search SQL injection ' || n,
          CASE WHEN n%3=0 THEN NULL ELSE 'synthetic repeated claim, unknown target identity' END,'security.vulnerability'
        FROM generate_series(1,${size}) n`;
      await sql`ANALYZE findings`;
      await requestFeatureRebuild(project);
      await sql`UPDATE project_finding_feature_work SET next_run_at=now()+interval '1 hour' WHERE project_id<>${project}`;
      const timings: number[] = [];
      for (let i=0;i<10;i++) {
        const start=performance.now(); const processed=await processFeatureBatch();
        if (processed!==20) throw new Error(`expected a 20-row batch, got ${processed}`);
        timings.push(performance.now()-start);
      }
      timings.sort((a,b)=>a-b);
      const [late] = await sql`SELECT id FROM findings WHERE project_id=${project}::uuid ORDER BY id OFFSET ${size-50} LIMIT 1`;
      const [plan] = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM findings
        WHERE project_id=${project}::uuid AND id > ${late.id}::uuid ORDER BY id LIMIT 20`;
      const [index] = await sql`SELECT pg_relation_size('findings_project_scan_idx') AS bytes`;
      results.push({ findings:size,batch_size:20,samples:timings.length,batch_ms_p50:timings[4],batch_ms_p95:timings[9],
        source_scan_index_bytes:Number(index.bytes),plan:plan['QUERY PLAN'],authoritative_identity_coverage:0,
        sample_kind:'synthetic, not human labeled; no relation quality metrics' });
    }
    console.log(JSON.stringify({node:process.version,arch:process.arch,cpu:cpus()[0]?.model,
      logical_cpus:cpus().length,host_memory_bytes:totalmem(),results},null,2));
  } finally {
    await close?.();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end({timeout:5});
  }
}
main().catch((error)=>{ console.error(error instanceof Error ? error.message : 'probe failed'); process.exitCode=1; });
