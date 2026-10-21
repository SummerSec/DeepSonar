import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {dc, docker, query, health} from './platform-upgrade-maintenance.fixture.mjs';

export async function rehearseKnowledgeFence({config, fixture, evidence, marker, actors, approved, execute, assertActive, stateOf, secretsOf}) {
  assert.equal(config.oldSchema,61); assert.equal(config.newSchema,62);
  const compose=join(fixture.directory,'compose.yml'), text=await readFile(compose,'utf8');
  assert.equal(text.split('      AGENT_MODE: fake').length,2);
  await writeFile(compose,text.replace('      AGENT_MODE: fake','      AGENT_MODE: fake\n      DEEPSONAR_DISPATCH_POLL_SEC: "1"'),{mode:0o600});
  dc(fixture,['up','-d','--no-deps','--wait','scheduler']); await health(fixture,config.oldVersion);
  const ids=Object.fromEntries(['job','attempt','canvas','item','version','receipt','work'].map(key=>[key,randomUUID()]));
  const governance=docker(['exec',dc(fixture,['ps','-q','scheduler']),'node','--input-type=module','-e',"const m=await import('/app/apps/scheduler/dist/domains/project-knowledge/platform-skills.js');console.log(m.PROJECT_KNOWLEDGE_GOVERNANCE_HASH)"]);
  assert.match(governance,/^[a-f0-9]{64}$/); const digest='a'.repeat(64);
  query(fixture,`INSERT INTO canvases(id,project_id,title) VALUES('${ids.canvas}','${marker}','knowledge history');
INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES('${ids.job}','${marker}','${ids.canvas}','explore','succeeded','{"historical":"immutable"}');
INSERT INTO job_attempts(id,job_id,attempt_no,status) VALUES('${ids.attempt}','${ids.job}',1,'succeeded');
INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri) VALUES('${digest}',1,'text/plain','fixture/knowledge');
INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title) VALUES('${ids.item}','${marker}','skill','migration/skill','preserved knowledge');
INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash) VALUES('${ids.version}','${marker}','${ids.item}',1,'${digest}','${ids.job}','${ids.attempt}','[]','${governance}');
UPDATE project_knowledge_items SET active_version_id='${ids.version}',status='active' WHERE id='${ids.item}';
INSERT INTO project_knowledge_receipts(project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json) VALUES('${marker}','${ids.job}','${ids.attempt}','request_project_knowledge','${ids.receipt}','${digest}','${randomUUID()}','{"preserved":true}');
INSERT INTO project_knowledge_work(id,project_id,origin_job_id,canvas_id,trigger_key,governance_hash,reason,next_attempt_at) VALUES('${ids.work}','${marker}','${ids.job}','${ids.canvas}','fixture-${ids.work}','${governance}','fixture','2099-01-01');`);
  const rowsSql=`SELECT json_build_object('item',(SELECT to_jsonb(t) FROM project_knowledge_items t WHERE id='${ids.item}'),'version',(SELECT to_jsonb(t) FROM project_knowledge_versions t WHERE id='${ids.version}'),'receipt',(SELECT to_jsonb(t) FROM project_knowledge_receipts t WHERE idempotency_key='${ids.receipt}'),'work',(SELECT to_jsonb(t) FROM project_knowledge_work t WHERE id='${ids.work}'),'job',(SELECT to_jsonb(t) FROM jobs t WHERE id='${ids.job}'))`;
  const sourceRows=query(fixture,rowsSql), io=actors(config,fixture), hash=await approved(io,config), activate=io.activate;
  let preparingRows;
  io.activate=async state=>{
    const saved=await secretsOf(fixture,state), db={role:saved.admin.role,database:saved.candidateDatabase};
    assert.equal(query(fixture,rowsSql,db),sourceRows,'real dump/rebuild must preserve knowledge and history');
    assert.throws(()=>query(fixture,`UPDATE project_knowledge_work SET reason='forbidden old writer' WHERE id='${ids.work}'`,{role:saved.source.role,database:saved.source.database}));
    query(fixture,`UPDATE project_knowledge_work SET next_attempt_at=now() WHERE id='${ids.work}'`,db);
    preparingRows=query(fixture,rowsSql,db);
    await new Promise(resolve=>setTimeout(resolve,3500));
    assert.equal(query(fixture,rowsSql,db),preparingRows,'real maintenance Scheduler must not claim or write due knowledge work');
    evidence.preparingKnowledgeUnchanged=true; return activate(state);
  };
  evidence.activation=await assertActive(config,fixture,await execute(io,config,'apply',hash),marker);
  const state=await stateOf(fixture), saved=await secretsOf(fixture,state), db={role:saved.admin.role,database:saved.candidateDatabase};
  const deadline=Date.now()+15000;
  while(query(fixture,rowsSql,db)===preparingRows && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,500));
  assert.notEqual(query(fixture,rowsSql,db),preparingRows,'actual background dispatcher must progress knowledge after activation');
  assert.equal(query(fixture,rowsSql,{role:saved.admin.role,database:saved.source.database}),sourceRows,'fenced source knowledge must remain intact');
  evidence.knowledgePreserved=true; evidence.oldKnowledgeWriterRejected=true; evidence.activeBackgroundProgressed=true;
}
