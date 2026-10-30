/** Synthetic performance only; isolated DB, no model or quality conclusions. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { cpus,totalmem } from 'node:os';

async function main(){
  if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL required');
  const adminUrl=new URL(process.env.TEST_DATABASE_URL);adminUrl.pathname='/postgres';
  const admin=postgres(adminUrl.toString(),{max:1}),name=`candidate_probe_${randomUUID().replaceAll('-','')}`;
  const target=new URL(adminUrl);target.pathname=`/${name}`;let close:(()=>Promise<void>)|undefined;
  try{
    await admin.unsafe(`CREATE DATABASE "${name}"`);process.env.DATABASE_URL=target.toString();
    const {sql,migrate}=await import('../../db.js');close=()=>sql.end({timeout:5});await migrate();
    const {processCandidateBatch,requestCandidateRebuild}=await import('./candidate-store.js');
    const {candidateWindowQuery,readCandidatePage}=await import('./candidate-read.js');
    const results=[];
    for(const size of [1_000,10_000,100_000]){
      const project=randomUUID(),canvas=randomUUID(),job1=randomUUID(),job2=randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${project},'synthetic candidate throughput')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'synthetic')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${job1},${project},${canvas},'audit','succeeded','{}'),(${job2},${project},${canvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,summary,profile)
        SELECT ${project}::uuid,CASE WHEN n%2=0 THEN ${job1}::uuid ELSE ${job2}::uuid END,n::text,
          '中文 参数 注入',repeat('synthetic claim without verified identity ',8),'security.vulnerability' FROM generate_series(1,${size}) n`;
      await sql`VACUUM ANALYZE findings`;
      await sql.begin(tx=>requestCandidateRebuild(project,tx));
      await sql`UPDATE project_finding_candidate_work SET next_run_at=now()+interval '1 day' WHERE project_id<>${project}`;
      const timings:number[]=[];let sources=0;
      // First batch is warmup. Samples measure actual commits/checkpoints, never a simulated full sweep.
      await processCandidateBatch(sql);
      for(let n=0;n<20;n++){const start=performance.now();const count=await processCandidateBatch(sql);
        if(count!==5)throw new Error('unexpected source batch size');sources+=count;timings.push(performance.now()-start);}
      const [work]=await sql`SELECT generation,cursor_id,active_generation FROM project_finding_candidate_work WHERE project_id=${project}`;
      if(work.active_generation!==null)throw new Error('partial sweep was unexpectedly published');
      const [subject]=await sql`SELECT id FROM findings WHERE project_id=${project} ORDER BY id OFFSET 24 LIMIT 1`;
      const [lateSource]=await sql`SELECT id FROM findings WHERE project_id=${project} ORDER BY id OFFSET ${size-50} LIMIT 1`;
      await sql`ANALYZE project_finding_candidate_edges`;
      const plans=await sql.begin(async tx=>{
        const [source]=await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM findings
          WHERE project_id=${project}::uuid AND id>${work.cursor_id}::uuid ORDER BY id LIMIT 5`;
        const [edges]=await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${candidateWindowQuery(tx,project,String(work.generation),String(subject.id),null)}`;
        const [late]=await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM findings
          WHERE project_id=${project}::uuid AND id>${lateSource.id}::uuid ORDER BY id LIMIT 5`;
        const firstEdges=await candidateWindowQuery(tx,project,String(work.generation),String(subject.id),null);
        const [next]=await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${candidateWindowQuery(tx,project,String(work.generation),String(subject.id),String(firstEdges[24].peer_id))}`;
        return {source:source['QUERY PLAN'],late_source:late['QUERY PLAN'],edges:edges['QUERY PLAN'],next_edges:next['QUERY PLAN']};
      });
      const [counts]=await sql`SELECT (SELECT count(*) FROM project_finding_candidate_sources WHERE project_id=${project}) AS sources,
        (SELECT count(*) FROM project_finding_candidate_edges WHERE project_id=${project}) AS edges`;
      const indexes=await sql`SELECT indexrelname,pg_relation_size(indexrelid) AS bytes FROM pg_stat_user_indexes
        WHERE relname IN ('project_finding_candidate_work','project_finding_candidate_sources','project_finding_candidate_edges') ORDER BY indexrelname`;
      const sorted=[...timings].sort((a,b)=>a-b),elapsed=timings.reduce((a,b)=>a+b,0);
      results.push({findings:size,samples:20,batch_size:5,batch_ms_samples:timings,p50_ms:sorted[9],p95_ms:sorted[18],
        measured_sources:sources,measured_sources_per_second:sources*1000/elapsed,
        theoretical_scheduler_minimum_seconds:size/5*2,full_sweep_completed:false,derived_rows:counts,indexes,plans});
    }
    // A separate small genuine completed sweep measures the read path including freshness checks.
    const project=randomUUID(),canvas=randomUUID();await sql`INSERT INTO projects(id,name) VALUES (${project},'candidate read probe')`;
    await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'read probe')`;
    for(let n=0;n<36;n++){const job=randomUUID();await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES (${job},${project},${canvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,profile) VALUES (${project},${job},${String(n)},'中文 参数 注入','security.vulnerability')`;}
    await sql.begin(tx=>requestCandidateRebuild(project,tx));
    await sql`UPDATE project_finding_candidate_work SET next_run_at=now()+interval '1 day' WHERE project_id<>${project}`;
    for(let n=0;n<10;n++){await processCandidateBatch(sql);const [w]=await sql`SELECT status FROM project_finding_candidate_work WHERE project_id=${project}`;if(w.status==='succeeded')break;}
    const [subject]=await sql`SELECT id FROM findings WHERE project_id=${project} ORDER BY id LIMIT 1`;
    await readCandidatePage(String(subject.id),undefined);const readTimes:number[]=[];
    for(let n=0;n<20;n++){const start=performance.now(),page=await readCandidatePage(String(subject.id),undefined);
      if(page?.status!=='succeeded'||page.items.length!==25)throw new Error('read fixture incomplete');readTimes.push(performance.now()-start);}
    readTimes.sort((a,b)=>a-b);
    const [version]=await sql`SELECT version() AS value`;
    console.log(JSON.stringify({sample_kind:'synthetic performance; no human-labeled accuracy evaluation',node:process.version,postgres:version.value,
      cpu:cpus()[0]?.model,logical_cpus:cpus().length,host_memory_bytes:totalmem(),client_resource_usage:process.resourceUsage(),
      method:'One batch warmup then 20 sequential committed five-source batches per size. Two Jobs per scale project. No full scale sweep. Index bytes cumulative. Client resources exclude PostgreSQL.',
      results,completed_36_source_read:{samples:20,p50_ms:readTimes[9],p95_ms:readTimes[18],samples_ms:readTimes}},null,2));
  }finally{await close?.();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end({timeout:5});}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'candidate probe failed');process.exitCode=1;});
