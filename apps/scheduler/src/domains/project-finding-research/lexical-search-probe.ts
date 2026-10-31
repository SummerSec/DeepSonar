/** Opt-in synthetic retrieval probe; owns and drops an isolated database. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const adminUrl = new URL(process.env.TEST_DATABASE_URL); adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `lexical_probe_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let close: (() => Promise<void>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    process.env.DATABASE_URL = target.toString();
    const { migrate, sql } = await import('../../db.js');
    const { lexicalWindowQuery, searchFindingLexical } = await import('./lexical-search.js');
    close = () => sql.end({ timeout: 5 });
    await migrate();
    const results: unknown[] = [];
    for (const size of [1_000, 10_000, 100_000]) {
      const project = randomUUID(), canvas = randomUUID(), subjectJob = randomUUID(), candidateJob = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${project},'synthetic lexical probe')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'synthetic')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${subjectJob},${project},${canvas},'audit','succeeded','{}'),
        (${candidateJob},${project},${canvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,summary,profile)
        SELECT ${project}::uuid,CASE WHEN n%5=0 THEN ${subjectJob}::uuid ELSE ${candidateJob}::uuid END,
          n::text,'中文 search SQL injection ' || n,repeat('synthetic declaration unknown identity ',8),'security.vulnerability'
        FROM generate_series(1,${size}) n`;
      // Add realistic high-cardinality unrelated chains, rather than proving joins against two rows.
      await sql`INSERT INTO canvases(id,project_id,title)
        SELECT md5(${project} || ':canvas:' || n)::uuid,${project}::uuid,'synthetic canvas'
        FROM generate_series(1,${size}) n`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        SELECT md5(${project} || ':job:' || n)::uuid,${project}::uuid,
          md5(${project} || ':canvas:' || n)::uuid,'audit','succeeded','{}' FROM generate_series(1,${size}) n`;
      await sql`UPDATE findings SET job_id=md5(${project} || ':job:' || fingerprint)::uuid
        WHERE project_id=${project}::uuid AND job_id=${candidateJob}::uuid`;
      await sql`VACUUM ANALYZE findings`;
      await sql`ANALYZE findings`; await sql`ANALYZE jobs`; await sql`ANALYZE canvases`;
      const [subject] = await sql`SELECT id FROM findings WHERE project_id=${project}::uuid AND job_id=${subjectJob}::uuid LIMIT 1`;
      const [late] = await sql`SELECT id FROM findings WHERE project_id=${project}::uuid ORDER BY id OFFSET ${size-200} LIMIT 1`;
      const first = await searchFindingLexical(String(subject.id),undefined);
      if (!first?.next_cursor) throw new Error('missing cursor');
      const lateCursor = JSON.parse(Buffer.from(first.next_cursor,'base64url').toString('utf8'));
      lateCursor.after = late.id;
      const windows = [];
      for (const position of ['first','late'] as const) {
        const after = position === 'late' ? String(late.id) : null;
        const cursor = after ? Buffer.from(JSON.stringify(lateCursor)).toString('base64url') : undefined;
        const timings: number[] = [];
        for (let i=0;i<20;i++) {
          const start = performance.now();
          const response = await searchFindingLexical(String(subject.id),cursor);
          timings.push(performance.now()-start);
          if (!response || response.examined!==128 || response.items.length>25) throw new Error('window budget violated');
        }
        timings.sort((a,b)=>a-b);
        const plan = await sql.begin('isolation level repeatable read read only',async tx => {
          await tx`SET LOCAL statement_timeout='3000ms'`;
          const [row] = await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${lexicalWindowQuery(tx,project,after)}`;
          return row['QUERY PLAN'];
        });
        windows.push({position,samples:20,request_ms_p50:timings[9],request_ms_p95:timings[18],request_ms_samples:timings,plan});
      }
      const [index] = await sql`SELECT pg_relation_size('findings_project_scan_idx') AS bytes`;
      results.push({findings:size,source_window:128,lookahead:1,index_bytes:Number(index.bytes),windows});
    }
    const [version] = await sql`SELECT version() AS value`;
    console.log(JSON.stringify({sample_kind:'synthetic scale only; no labeled quality metrics',node:process.version,
      postgres:version.value,arch:process.arch,cpu:cpus()[0]?.model,logical_cpus:cpus().length,host_memory_bytes:totalmem(),client_resource_usage:process.resourceUsage(),client_memory:process.memoryUsage(),
      methodology:'One initial first-window warmup; 20 sequential samples per first/late window. Client resource metrics cover this process, not PostgreSQL. Index bytes are cumulative across fixture projects.',results},null,2));
  } finally {
    await close?.(); await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({timeout:5});
  }
}
main().catch(error=>{console.error(error instanceof Error ? error.message : 'probe failed');process.exitCode=1;});
