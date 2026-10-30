import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const testUrl=process.env.TEST_DATABASE_URL;
test('durable candidate generations, bounded pages, invalidation, recovery and management authorization', {skip:!testUrl},async()=>{
  const adminUrl=new URL(testUrl!);adminUrl.pathname='/postgres';
  const admin=postgres(adminUrl.toString(),{max:1}),name=`candidate_fixture_${randomUUID().replaceAll('-','')}`;
  const target=new URL(adminUrl);target.pathname=`/${name}`;
  let close:(()=>Promise<void>)|undefined,appClose:(()=>Promise<void>)|undefined;
  try{
    await admin.unsafe(`CREATE DATABASE "${name}"`);process.env.DATABASE_URL=target.toString();process.env.DEEPSONAR_AUTH_REQUIRED='true';
    const [{sql,migrate},store,{readCandidatePage},{CANDIDATE_RULE_VERSION,loadCandidateSource},{default:Fastify},{default:websocket},{registerRoutes},{generateToken},{CursorError,QueryParameterError}]=await Promise.all([
      import('../../db.js'),import('./candidate-store.js'),import('./candidate-read.js'),import('./candidate-source.js'),import('fastify'),import('@fastify/websocket'),import('../../routes.js'),import('../../auth.js'),import('../../pagination.js'),
    ]);
    close=()=>sql.end({timeout:5});await migrate();
    const app=Fastify({logger:false});await app.register(websocket);registerRoutes(app);await app.ready();appClose=()=>app.close();
    const project=randomUUID(),other=randomUUID(),canvas=randomUUID(),otherCanvas=randomUUID();
    const ids=Array.from({length:36},(_,n)=>`77100000-0000-0000-0000-${String(n).padStart(12,'0')}`);
    const jobs=ids.map(()=>randomUUID());const subject=ids[0];
    await sql`INSERT INTO projects(id,name) VALUES (${project},'candidate fixture'),(${other},'other')`;
    await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'candidate task'),(${otherCanvas},${other},'other')`;
    for(let n=0;n<ids.length;n++){
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES (${jobs[n]},${project},${canvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
        VALUES (${ids[n]},${project},${jobs[n]},${ids[n]},${n===35?'完全孤立zzz':'中文 搜索 参数 注入'},${n===35?'xyzabc':'相同的声明'},'security.vulnerability','confirmed','resolved')`;
    }
    const before=await sql`SELECT id,verify_status,disposition FROM findings ORDER BY id`;
    const work=async()=> (await sql`SELECT * FROM project_finding_candidate_work WHERE project_id=${project}`)[0];
    const finish=async()=>{
      for(let n=0;n<50;n++){
        const row=await work();if(row?.status==='succeeded')return row;
        await store.processCandidateBatch(sql);
      }
      assert.fail(`candidate sweep not finished: ${JSON.stringify(await work())}`);
    };
    const rebuild=()=>sql.begin(tx=>store.requestCandidateRebuild(project,tx));
    const invokeCLI=(extra:string[]=[])=>promisify(execFile)(process.execPath,
      ['--import','tsx',fileURLToPath(new URL('./candidate-rebuild-cli.ts',import.meta.url)),'--project-id',project,...extra],
      {cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:target.toString()}});
    assert.equal((await readCandidatePage(subject,undefined))?.status,'pending');
    assert.equal(await store.processCandidateBatch(sql,()=>false),0);
    await sql`UPDATE platform_upgrade_state SET phase='preparing',generation='77000000-0000-0000-0000-000000000099',runtime_role='postgres',target_version='0.0.1',worker_generation_token_hash=repeat('a',64) WHERE id='global'`;
    assert.equal(await store.processCandidateBatch(sql),0);
    await assert.rejects(invokeCLI(),(error:unknown)=>{
      const stderr=String((error as {stderr?:string}).stderr);assert.ok(stderr.includes('CANDIDATE_REBUILD_MAINTENANCE_DENIED'));
      assert.ok(!stderr.includes(target.toString()));return true;
    });
    await sql`UPDATE platform_upgrade_state SET phase='active',generation='',runtime_role='',target_version='',worker_generation_token_hash='' WHERE id='global'`;
    const cliRebuild=JSON.parse((await invokeCLI()).stdout);assert.equal(cliRebuild.project_id,project);
    const initialGeneration=(await work()).generation;
    assert.equal(await store.processCandidateBatch(sql),5);
    assert.equal((await readCandidatePage(subject,undefined))?.status,'running');
    assert.equal((await work()).active_generation,null);
    await Promise.all([store.processCandidateBatch(sql),store.processCandidateBatch(sql)]);
    const completed=await finish();assert.equal(completed.active_generation,initialGeneration);
    const page=(await readCandidatePage(subject,undefined))!;
    assert.equal(page.status,'succeeded');assert.equal(page.items.length,25);assert.ok(page.next_cursor);
    assert.equal(page.source_window.examined,36);assert.equal(page.source_window.rank_truncated,true);
    const next=(await readCandidatePage(subject,page.next_cursor))!;
    assert.equal(next.items.length,9);assert.equal(next.next_cursor,null);
    assert.equal(new Set([...page.items,...next.items].map(x=>x.finding_id)).size,34,'incoming edges remain accessible');
    assert.equal((await readCandidatePage(ids[35],undefined))?.status,'succeeded');
    assert.equal((await readCandidatePage(ids[35],undefined))?.items.length,0,'successfully computed zero differs from pending');
    const duplicates=await sql`SELECT left_id,right_id,count(*) FROM project_finding_candidate_edges GROUP BY generation,left_id,right_id HAVING count(*)>1`;
    assert.equal(duplicates.length,0);
    assert.equal(Number((await sql`SELECT count(*) AS n FROM project_finding_candidate_edges WHERE left_id>=right_id`)[0].n),0);
    // New work keeps the complete prior generation visible until atomic publication.
    await rebuild();const newGeneration=(await work()).generation;assert.notEqual(newGeneration,initialGeneration);
    await store.processCandidateBatch(sql);const building=(await readCandidatePage(subject,undefined))!;
    assert.equal(building.active_generation,initialGeneration);assert.equal(building.rebuilding,true);assert.equal(building.items.length,25);
    await finish();assert.equal((await work()).active_generation,newGeneration);
    await assert.rejects(readCandidatePage(subject,page.next_cursor),error=>error instanceof CursorError&&error.code==='CURSOR_GAP');
    // Transaction rollback does not lose the published generation or checkpoint.
    await assert.rejects(sql.begin(async tx=>{await store.requestCandidateRebuild(project,tx);throw new Error('simulated crash');}),/simulated crash/);
    assert.equal((await work()).generation,newGeneration);
    const stoppedBefore=await work();let checks=0;
    await sql`UPDATE project_finding_candidate_work SET next_run_at=now() WHERE project_id=${project}`;
    await store.processCandidateBatch(sql,()=>++checks<3);
    assert.equal((await work()).active_generation,stoppedBefore.active_generation);
    // Stop rolls back derived savepoint; unfinished generation is resumable.
    await finish();
    const token=async(scopes:string[],projectId:string)=>{const t=generateToken();await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
      VALUES ('candidate test',${projectId},${t.prefix},${t.hash},${scopes})`;return t;};
    const reader=await token(['findings:read'],project),denied=await token(['projects:read'],project),foreign=await token(['findings:read'],other);
    const path=`/findings/${subject}/candidates`,get=(t:{plaintext:string},suffix='')=>app.inject({method:'GET',url:path+suffix,headers:{authorization:`Bearer ${t.plaintext}`}});
    assert.equal((await get(reader)).statusCode,200);assert.equal((await get(denied)).statusCode,403);assert.equal((await get(foreign)).statusCode,403);
    assert.equal(await readCandidatePage(subject,undefined,sql,other),null);
    assert.equal((await get(reader,'?cursor=invalid!')).statusCode,400);
    await assert.rejects(readCandidatePage(subject,123),QueryParameterError);
    const current=(await readCandidatePage(subject,undefined))!;
    await sql`UPDATE findings SET summary='已修改声明' WHERE id=${ids[1]}`;
    const filtered=(await readCandidatePage(subject,undefined))!;
    assert.equal(filtered.status,'stale');assert.equal(filtered.stale_results_omitted,true);assert.equal(filtered.examined,25);
    assert.equal(filtered.items.length,24);assert.ok(filtered.next_cursor,'invalid peers do not trigger unbounded refill');
    await sql`UPDATE findings SET summary='主体改动' WHERE id=${subject}`;
    assert.equal((await get(reader,`?cursor=${current.next_cursor}`)).statusCode,409);
    assert.equal((await readCandidatePage(subject,undefined))?.items.length,0);
    // Evidence metadata invalidates immediately, without returning evidence or raw input digests.
    await sql`UPDATE findings SET summary='相同的声明' WHERE id=${subject}`;
    const artifact=randomUUID();
    await sql`INSERT INTO artifacts(id,project_id,canvas_id,job_id,artifact_key,kind,source_operation)
      VALUES (${artifact},${project},${canvas},${jobs[0]},'candidate-artifact','security.finding','emit_finding')`;
    await sql`INSERT INTO artifact_evidence(artifact_id,ordinal,statement) VALUES (${artifact},1,'secret evidence statement')`;
    await sql`UPDATE findings SET artifact_id=${artifact} WHERE id=${subject}`;
    await rebuild();await finish();const evidenced=(await readCandidatePage(subject,undefined))!;assert.ok(evidenced.items.length);assert.ok(evidenced.next_cursor);
    const internal=await sql.begin(tx=>loadCandidateSource(tx,subject));
    assert.ok(!JSON.stringify(evidenced).includes(internal!.input_digest));assert.ok(!JSON.stringify(evidenced).includes('secret evidence'));
    await sql`UPDATE artifact_evidence SET statement='changed secret evidence' WHERE artifact_id=${artifact}`;
    assert.equal((await readCandidatePage(subject,undefined))?.items.length,0);
    await assert.rejects(readCandidatePage(subject,evidenced.next_cursor),CursorError);
    await sql`INSERT INTO artifact_evidence(artifact_id,ordinal,statement) SELECT ${artifact}::uuid,n,'bounded evidence' FROM generate_series(2,129) n`;
    await rebuild();
    for(let n=1;n<=3;n++){await sql`UPDATE project_finding_candidate_work SET next_run_at=now() WHERE project_id=${project}`;await store.processCandidateBatch(sql);assert.equal((await work()).attempts,n);}
    assert.equal((await work()).status,'failed');assert.equal((await work()).error_code,'CANDIDATE_EVIDENCE_BUDGET_EXCEEDED');
    await store.processCandidateBatch(sql);assert.equal((await work()).attempts,3,'same-version failed work never auto-resets');
    assert.equal((await readCandidatePage(subject,undefined))?.error_code,'CANDIDATE_EVIDENCE_BUDGET_EXCEEDED');
    await sql`DELETE FROM artifact_evidence WHERE artifact_id=${artifact} AND ordinal>1`;
    await sql`UPDATE project_finding_candidate_work SET rule_version='obsolete' WHERE project_id=${project}`;
    for(let n=0;n<3&&(await work()).rule_version!==CANDIDATE_RULE_VERSION;n++)await store.processCandidateBatch(sql);
    assert.equal((await work()).rule_version,CANDIDATE_RULE_VERSION);await finish();
    // Wrong-generation/prior-rule edges never become visible as current conclusions.
    await sql`UPDATE project_finding_candidate_edges SET rule_version='obsolete' WHERE project_id=${project}`;
    assert.equal((await readCandidatePage(subject,undefined))?.items.length,0);
    await rebuild();await finish();
    // A concurrent writer wins before the worker's shared endpoint lock: old inputs cannot publish.
    const oldInput=(await sql.begin(tx=>loadCandidateSource(tx,subject)))!.input_digest;
    await rebuild();const raceGeneration=(await work()).generation;
    let releaseWriter!:()=>void,writerReady!:()=>void;
    const release=new Promise<void>(resolve=>{releaseWriter=resolve;}),ready=new Promise<void>(resolve=>{writerReady=resolve;});
    const writer=sql.begin(async tx=>{await tx`SELECT id FROM findings WHERE id=${subject} FOR UPDATE`;writerReady();await release;
      await tx`UPDATE findings SET summary='并发来源修改' WHERE id=${subject}`;});
    await ready;const batch=store.processCandidateBatch(sql);let blocked=false;
    for(let n=0;n<100;n++){
      const [row]=await sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
      if(Number(row.n)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    const overlappingRebuild=rebuild();
    releaseWriter();await writer;await batch;await overlappingRebuild;
    assert.ok(blocked,'fixture exercised the actual database endpoint lock race');
    assert.notEqual((await work()).generation,raceGeneration,'concurrent rebuild supersedes old work after its checkpoint');
    assert.notEqual((await work()).active_generation,raceGeneration,'partial superseded generation was never published');
    assert.equal(Number((await sql`SELECT count(*) AS n FROM project_finding_candidate_edges WHERE project_id=${project}
      AND generation=${raceGeneration} AND ((left_id=${subject} AND left_input_digest=${oldInput}) OR (right_id=${subject} AND right_input_digest=${oldInput}))`)[0].n),0);
    await finish();await rebuild();await finish();
    const deleted=ids[2];await sql`DELETE FROM findings WHERE id=${deleted}`;
    assert.equal(Number((await sql`SELECT count(*) AS n FROM project_finding_candidate_edges WHERE left_id=${deleted} OR right_id=${deleted}`)[0].n),0);
    assert.equal(await readCandidatePage(deleted,undefined),null);
    assert.ok(!(await readCandidatePage(subject,undefined))!.items.some(x=>x.finding_id===deleted));
    const prune=JSON.parse((await invokeCLI(['--prune-inactive'])).stdout).pruned_count;assert.ok(prune>0&&prune<=500);
    assert.ok((await readCandidatePage(subject,undefined))!.items.length>0);
    await sql`UPDATE jobs SET canvas_id=${otherCanvas} WHERE id=${jobs[3]}`;
    assert.ok(!(await readCandidatePage(subject,undefined))!.items.some(x=>x.finding_id===ids[3]));
    const shortTokens=Array.from({length:2100},(_,n)=>`t${n}`).join(' ');assert.ok(shortTokens.length<16000);
    await sql`UPDATE findings SET summary=${shortTokens} WHERE id=${ids[35]}`;
    assert.equal((await sql.begin(tx=>loadCandidateSource(tx,ids[35])))?.text_truncated,true,'token clipping is explicit below the text-character limit');
    const capJob=randomUUID();
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
      VALUES (${capJob},${project},${canvas},'audit','provisioning','{"platform_tools":["emit_progress"]}',now(),3600,now()+interval '1 hour')`;
    const {createAttempt}=await import('../job-attempt/application.js');await sql.begin(tx=>createAttempt(tx as unknown as typeof sql,capJob));
    const {mintJobCapabilityToken}=await import('../platform-api/tokens.js');const grant=await mintJobCapabilityToken(capJob);
    assert.equal((await app.inject({method:'GET',url:path,headers:{authorization:`Bearer ${grant.token}`}})).statusCode,401);
    await sql`UPDATE api_tokens SET revoked_at=now() WHERE token_hash=${reader.hash}`;
    assert.equal((await get(reader)).statusCode,401);
    assert.deepEqual(Array.from(await sql`SELECT id,verify_status,disposition FROM findings ORDER BY id`),before.filter(row=>row.id!==deleted));
    // Registry scan checkpoints at 25 projects and wraps only after the remaining window.
    await sql`INSERT INTO projects(name) SELECT 'bounded registry fixture '||n FROM generate_series(1,28) n`;
    await sql`UPDATE project_finding_candidate_scan SET cursor_id=NULL WHERE id='global'`;
    assert.equal(await sql.begin(tx=>store.scanCandidateProjects(tx)),25);
    const [registry]=await sql`SELECT cursor_id FROM project_finding_candidate_scan WHERE id='global'`;
    const [twentyFifth]=await sql`SELECT id FROM projects ORDER BY id OFFSET 24 LIMIT 1`;
    assert.equal(registry.cursor_id,twentyFifth.id);
    assert.equal(await sql.begin(tx=>store.scanCandidateProjects(tx)),5);
    assert.equal((await sql`SELECT cursor_id FROM project_finding_candidate_scan WHERE id='global'`)[0].cursor_id,null);
  }finally{await appClose?.();await close?.();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end({timeout:5});}
});
