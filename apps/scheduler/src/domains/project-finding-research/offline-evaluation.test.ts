import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { evaluateOfflineDataset,offlineDigest } from './offline-evaluation.js';
import { parseOfflineDataset,OfflineEvaluationError,OFFLINE_INPUT_BYTES,type OfflineDataset } from './offline-evaluation-input.js';

const uuid=(n:number)=>`77000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function fixture():OfflineDataset{
  return {schema_version:1,dataset_id:'synthetic-only',dataset_kind:'synthetic',metadata:{labelset_revision:'v1',annotator_ids:[],labeling_method:'synthetic'},
    config:{k:25,scan_limit:128,predeclared:true},sources:Array.from({length:4},(_,n)=>({id:uuid(n),project_id:uuid(100),job_id:uuid(200+n),
      split:n<2?'tuning':'holdout',asset_group:n<2?'asset-a':'asset-b',family_group:n<2?'family-a':'family-b',revision:'r1',digest:null,
      title:'中文 参数 注入',location:null,summary:'synthetic lexical claim',profile:'security.vulnerability',category:null})),
    pairs:[{left_id:uuid(0),right_id:uuid(1),label:'similar'},{left_id:uuid(2),right_id:uuid(3),label:'suspected_same_issue'}]};
}
function reject(value:unknown,code:string){assert.throws(()=>parseOfflineDataset(JSON.stringify(value)),(error:unknown)=>error instanceof OfflineEvaluationError&&error.code===code);}
test('strict deterministic normalized import and complete report hashes',()=>{
  const input=fixture(),report=evaluateOfflineDataset(input);
  const permuted=fixture();permuted.sources.reverse();permuted.pairs.reverse();
  [permuted.pairs[0].left_id,permuted.pairs[0].right_id]=[permuted.pairs[0].right_id,permuted.pairs[0].left_id];
  assert.deepEqual(report,evaluateOfflineDataset(permuted));
  const {report_digest,...body}=report;assert.equal(report_digest,offlineDigest(body));
  assert.equal(report.splits.holdout.pair_rule_metrics.per_class.suspected_same_issue.recall.value,0);
  assert.equal(report.splits.holdout.pair_rule_metrics.per_class.suspected_same_issue.precision.value,null);
  assert.equal(report.quality_gate_status,'not_assessed');assert.equal(report.independent_label_verification,false);
  assert.equal(report.execution_plane,'offline_local_corpus_window_simulation');assert.equal(report.experimental_configuration,false);
  assert.equal(report.coverage.declared_fields.location.value,0);assert.equal(report.coverage.declared_fields.title.value,1);
  assert.ok(!JSON.stringify(report).includes('synthetic lexical claim'));assert.ok(!JSON.stringify(report).includes('中文 参数'));
  const changed=fixture();changed.sources[0].revision='r2';assert.notEqual(evaluateOfflineDataset(changed).input_digest,report.input_digest);
  changed.config.k=50;assert.notEqual(evaluateOfflineDataset(changed).config_digest,report.config_digest);
  assert.equal(evaluateOfflineDataset(changed).experimental_configuration,true);
});
test('labels and identity declarations never change rule predictions or candidate ranking',()=>{
  const base=fixture(),changed=fixture();changed.pairs[0].label='distinct';
  changed.sources[0].identity_declarations={asset:'asserted-production-asset',root_cause:'alleged cause',version:'v1'};
  changed.sources[1].identity_declarations={asset:'different-asset',root_cause:'different cause',version:'v2'};
  const a=evaluateOfflineDataset(base),b=evaluateOfflineDataset(changed);
  assert.deepEqual(a.queries,b.queries);assert.deepEqual(a.pairs.map(p=>p.prediction),b.pairs.map(p=>p.prediction));
  assert.notEqual(a.report_digest,b.report_digest);assert.equal(b.identity_coverage.provided_fields.asset.numerator,2);
  assert.equal(b.identity_coverage.available_authoritative_mapping_fields,0);
  assert.equal(b.coverage.authoritative_mapping.value,0);
  const forged=fixture() as unknown as Record<string,unknown>;const source=(forged.sources as Record<string,unknown>[])[0];source.identity={asset:{value:'forged authority'}};
  reject(forged,'INVALID_FIELDS');
});
test('explicit null labels and absent pair labels never become negative examples',()=>{
  const input=fixture();input.pairs[0].label=null;
  const report=evaluateOfflineDataset(input),metrics=report.splits.tuning;
  assert.equal(metrics.pair_rule_metrics.missing_labels,1);assert.equal(metrics.pair_rule_metrics.missing_label_rate.value,1);
  assert.equal(metrics.pair_rule_metrics.per_class.similar.false_positive,0);assert.equal(metrics.pair_rule_metrics.per_class.similar.precision.value,null);
  assert.equal(metrics.candidate_pipeline_metrics.retrieved_with_null_label,2);
  assert.equal(metrics.candidate_pipeline_metrics.candidate_recall_at_k.value,null);
  input.pairs=[];const missing=evaluateOfflineDataset(input).splits.tuning.candidate_pipeline_metrics;
  assert.equal(missing.retrieved_without_pair_label,2);assert.equal(missing.per_class.similar.false_positive,0);
  const invalid=fixture();delete (invalid.pairs[0] as unknown as Record<string,unknown>).label;reject(invalid,'INVALID_FIELDS');
});
test('unretrieved positives remain end-to-end false negatives, separate from rule insufficiency',()=>{
  const input=fixture();input.config.scan_limit=1;
  const split=evaluateOfflineDataset(input).splits.tuning;
  assert.equal(split.pair_rule_metrics.per_class.similar.recall.value,1);
  assert.equal(split.candidate_pipeline_metrics.per_class.similar.true_positive,1);
  assert.equal(split.candidate_pipeline_metrics.per_class.similar.false_negative,1);
  assert.equal(split.candidate_pipeline_metrics.per_class.similar.recall.value,0.5);
  assert.equal(split.candidate_pipeline_metrics.candidate_recall_at_k.value,0.5);
  assert.equal(split.candidate_pipeline_metrics.not_retrieved_rate.value,0.5);
  input.sources[1].title='unrelated zzz';input.sources[1].summary=null;
  const unknown=evaluateOfflineDataset(input).splits.tuning;
  assert.equal(unknown.pair_rule_metrics.predicted_insufficient_rate.value,1);
  assert.equal(unknown.candidate_pipeline_metrics.not_retrieved,2);
});
test('declared human provenance is retained but never independently authenticated',()=>{
  const input=fixture();input.dataset_kind='human-labeled';input.metadata={labeling_method:'human-declared',labelset_revision:'review-2',annotator_ids:['anon-b','anon-a']};
  const report=evaluateOfflineDataset(input);assert.equal(report.independent_label_verification,false);
  assert.deepEqual(report.metadata.annotator_ids,['anon-a','anon-b']);
  input.metadata.annotator_ids=[];reject(input,'INVALID_ANNOTATORS');
  input.metadata.labeling_method='synthetic';reject(input,'LABEL_PROVENANCE_MISMATCH');
});
test('split leakage rejects same source, asset groups and family groups',()=>{
  const duplicate=fixture();duplicate.sources[2].id=duplicate.sources[0].id;reject(duplicate,'DUPLICATE_SOURCE');
  for(const group of ['asset_group','family_group'] as const){const input=fixture();input.sources[2][group]=input.sources[0][group];reject(input,'SPLIT_GROUP_LEAKAGE');}
  const noGroup=fixture();delete (noGroup.sources[0] as unknown as Record<string,unknown>).asset_group;reject(noGroup,'INVALID_FIELDS');
  const crossing=fixture();crossing.pairs[0].right_id=uuid(2);reject(crossing,'CROSS_SPLIT_PAIR');
});
test('pair scope, contradictory reverse labels, duplicate pairs and missing sources are rejected',()=>{
  const duplicate=fixture();duplicate.pairs.push({...duplicate.pairs[0],left_id:uuid(1),right_id:uuid(0)});reject(duplicate,'DUPLICATE_PAIR');
  duplicate.pairs[2].label='distinct';reject(duplicate,'CONTRADICTORY_PAIR');
  const missing=fixture();missing.pairs[0].right_id=uuid(99);reject(missing,'PAIR_SOURCE_MISSING');
  const same=fixture();same.sources[1].job_id=same.sources[0].job_id;reject(same,'SAME_JOB_PAIR');
  const project=fixture();project.sources[1].project_id=uuid(300);reject(project,'CROSS_PROJECT_PAIR');
  const job=fixture();job.sources[1].job_id=job.sources[0].job_id;job.sources[1].project_id=uuid(300);reject(job,'JOB_PROJECT_CONFLICT');
});
test('unknown enums, coerced array enums, extra fields and missing source revision fail closed',()=>{
  const relation=fixture();(relation.pairs[0] as unknown as Record<string,unknown>).label='same';reject(relation,'INVALID_RELATION_LABEL');
  const kind=fixture() as unknown as Record<string,unknown>;kind.dataset_kind=['synthetic'];reject(kind,'INVALID_DATASET_KIND');
  const split=fixture();(split.sources[0] as unknown as Record<string,unknown>).split=['tuning'];reject(split,'INVALID_SPLIT');
  const revision=fixture();revision.sources[0].revision=null;reject(revision,'SOURCE_REVISION_REQUIRED');
  const raw=fixture() as unknown as Record<string,unknown>;raw.api_token='not-accepted';reject(raw,'INVALID_FIELDS');
});
test('configuration is mandatory predeclared and input/count/text budgets are strict',()=>{
  for(const k of [0,51,1.5,'25']){const input=fixture();(input.config as unknown as Record<string,unknown>).k=k;reject(input,'INVALID_CONFIGURATION');}
  const undeclared=fixture();(undeclared.config as unknown as Record<string,unknown>).predeclared=false;reject(undeclared,'PREDECLARED_CONFIGURATION_REQUIRED');
  const missing=fixture();delete (missing.config as unknown as Record<string,unknown>).k;reject(missing,'INVALID_FIELDS');
  const text=fixture();text.sources[0].summary='x'.repeat(16000);reject(text,'SOURCE_TEXT_BUDGET_EXCEEDED');
  const count=fixture();count.sources=Array(1001).fill(count.sources[0]);reject(count,'DATASET_COUNT_BUDGET_EXCEEDED');
  const pairs=fixture();pairs.pairs=Array(10001).fill(pairs.pairs[0]);reject(pairs,'DATASET_COUNT_BUDGET_EXCEEDED');
  assert.throws(()=>parseOfflineDataset(' '.repeat(OFFLINE_INPUT_BYTES+1)),(error:unknown)=>error instanceof OfflineEvaluationError&&error.code==='INPUT_BUDGET_EXCEEDED');
});
test('real CLI has no DB/network/config dependencies and errors expose only stable codes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'770-offline-'));
  try{
    const input=join(dir,'fixture.json'),guard=join(dir,'guard.mjs'),cli=fileURLToPath(new URL('./offline-evaluation-cli.ts',import.meta.url));
    await writeFile(input,JSON.stringify(fixture()));await writeFile(join(dir,'.env'),'DATABASE_URL=secret-should-never-read');
    await writeFile(guard,`import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){if(/^(?:node:)?(?:net|http|https|dns|tls)$/.test(specifier)||/postgres|dotenv|(?:^|\\/)db\\.js$|(?:^|\\/)config\\.js$/.test(specifier))throw Error('FORBIDDEN_OFFLINE_IMPORT');return next(specifier,context);}});
globalThis.fetch=()=>{throw Error('FORBIDDEN_OFFLINE_NETWORK');};
const environment=process.env;process.env=new Proxy(environment,{get(target,key){if(key==='DATABASE_URL'||key==='DEEPSONAR_AUTH_REQUIRED')throw Error('FORBIDDEN_OFFLINE_ENV');return Reflect.get(target,key);}});
`);
    const run=(args:string[])=>promisify(execFile)(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--import',guard,cli,...args],
      {cwd:dir,env:{...process.env,DATABASE_URL:'postgres://secret:private@127.0.0.1:1/forbidden'},maxBuffer:4*1024*1024});
    const success=await run(['--input',input]);assert.equal(success.stderr,'');
    assert.deepEqual(JSON.parse(success.stdout),evaluateOfflineDataset(fixture()));
    const errorCode=async(args:string[],expected:string)=>{await assert.rejects(run(args),(error:unknown)=>{
      assert.equal((error as {stderr:string}).stderr.trim(),expected);assert.equal((error as {stdout:string}).stdout,'');return true;
    });};
    await errorCode([],'INVALID_ARGUMENTS');await errorCode(['--input',join(dir,'secret-password')],'INPUT_READ_FAILED');
    await writeFile(input,'{"password":"private-input"');await errorCode(['--input',input],'INVALID_JSON');
    await writeFile(input,Buffer.from([0xff]));await errorCode(['--input',input],'INVALID_UTF8');
    await writeFile(input,'x'.repeat(OFFLINE_INPUT_BYTES+1));await errorCode(['--input',input],'INPUT_BUDGET_EXCEEDED');
    await errorCode(['--input',dir],'REGULAR_INPUT_FILE_REQUIRED');
  }finally{await rm(dir,{recursive:true,force:true});}
});
