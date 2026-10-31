import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
function withStrongMappings(input:OfflineDataset):OfflineDataset{
  const fields=['asset','tenant','environment','version','parameter','root_cause'] as const;
  for(const source of input.sources)source.authoritative_identity_mappings=fields.map((field,index)=>({
    field,identity_digest:`sha256:${['a','b','c','d','e','f'][index].repeat(64)}`,
    authority_version:field==='root_cause'?'root-cause/v1':'inventory/v1',
    source_revision:'rev-1',source_digest:`sha256:${'1'.repeat(64)}`,freshness_until:'2099-01-01T00:00:00.000Z',
  }));
  return input;
}
function tuningStrongFixture():OfflineDataset{
  const input=withStrongMappings(fixture());
  input.sources=input.sources.map(source=>({...source,split:'tuning' as const,asset_group:'asset-a',family_group:'family-a'}));
  return input;
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
  assert.equal(report.strong_relation_quality_gate.status,'not_evaluated');
  assert.equal(report.strong_relation_quality_gate.published,false);
  assert.equal(report.strong_relation_quality_gate.independent_human_labels_verified,false);
  assert.equal(report.strong_relation_quality_gate.thresholds_frozen_before_holdout,false);
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
test('offline authoritative mappings are digest-only and never publish strong relations',()=>{
  const input=fixture();
  const digest=(value:string)=>`sha256:${value.repeat(64).slice(0,64)}`;
  const strongFields=['asset','tenant','environment','version','parameter','root_cause'] as const;
  for(const source of input.sources.slice(0,2)) source.authoritative_identity_mappings=strongFields.map((field,index)=>({
    field,identity_digest:digest(['a','b','c','d','e','f'][index]),authority_version:field==='root_cause'?'root-cause/v1':'inventory/v1',
    source_revision:'rev-1',source_digest:digest(['1','2','3','4','5','6'][index]),freshness_until:'2099-01-01T00:00:00.000Z',
  }));
  const report=evaluateOfflineDataset(input);
  assert.equal(report.identity_coverage.available_authoritative_mapping_fields,6);
  assert.equal(report.strong_relation_quality_gate.published,false);
  assert.equal(report.strong_relation_quality_gate.status,'not_evaluated');
  assert.equal(report.pairs[0].strong_relation_prediction,'same_problem');
});
test('strong metrics canonicalize both same-issue labels without changing lexical metrics or quality gate',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='suspected_same_issue';input.pairs[1].label='same_problem';
  const report=evaluateOfflineDataset(input);
  for(const split of ['tuning','holdout']){
    const metrics=report.splits[split].strong_pair_rule_metrics;
    assert.equal(metrics.observations,1);assert.equal(metrics.scored_observations,1);
    assert.deepEqual(metrics.per_class.same_problem.precision,{numerator:1,denominator:1,value:1});
    assert.deepEqual(metrics.per_class.same_problem.recall,{numerator:1,denominator:1,value:1});
    assert.equal(metrics.label_mapping.suspected_same_issue,'same_problem');
    assert.equal(metrics.label_mapping.same_problem,'same_problem');
    assert.equal(metrics.confusion_matrix.same_problem.same_problem,1);
    assert.equal(metrics.execution_plane,'offline_caller_declared_identity_pair_comparison');
  }
  assert.equal(report.splits.tuning.pair_rule_metrics.per_class.suspected_same_issue.false_negative,1);
  assert.equal(report.pairs[0].prediction,'similar');assert.equal(report.pairs[0].strong_relation_prediction,'same_problem');
  assert.equal(report.versions.strong_metric,'offline-strong-metrics/v1');
  assert.equal(report.strong_relation_quality_gate.status,'not_evaluated');assert.equal(report.strong_relation_quality_gate.published,false);
  const permuted=structuredClone(input);permuted.sources.reverse();permuted.pairs.reverse();
  for(const pair of permuted.pairs)[pair.left_id,pair.right_id]=[pair.right_id,pair.left_id];
  assert.deepEqual(report,evaluateOfflineDataset(permuted));
  const {report_digest,...body}=report;assert.equal(report_digest,offlineDigest(body));
});
test('strong precision and recall count genuine false positives and false negatives independently of lexical matches',()=>{
  const input=tuningStrongFixture();
  input.pairs=[{left_id:uuid(0),right_id:uuid(1),label:'suspected_same_issue'},
    {left_id:uuid(0),right_id:uuid(2),label:'distinct'},{left_id:uuid(0),right_id:uuid(3),label:'same_problem'}];
  input.sources[3].authoritative_identity_mappings!.find(row=>row.field==='root_cause')!.identity_digest=`sha256:${'2'.repeat(64)}`;
  const report=evaluateOfflineDataset(input),metrics=report.splits.tuning.strong_pair_rule_metrics;
  assert.equal(metrics.scored_observations,3);
  assert.deepEqual(metrics.per_class.same_problem,{true_positive:1,false_positive:1,false_negative:1,
    precision:{numerator:1,denominator:2,value:0.5},recall:{numerator:1,denominator:2,value:0.5}});
  assert.equal(metrics.confusion_matrix.distinct.same_problem,1);assert.equal(metrics.confusion_matrix.same_problem.distinct,1);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.per_class.same_problem.true_positive,2);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.per_class.same_problem.false_positive,2);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.per_class.same_problem.false_negative,2);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.per_class.same_problem.recall.value,0.5);
});
test('strong root-cause continuation and explicit distinct labels retain separate classes',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='same_root_cause_different_instance';input.pairs[1].label='distinct';
  input.sources[1].authoritative_identity_mappings!.find(row=>row.field==='version')!.identity_digest=`sha256:${'2'.repeat(64)}`;
  input.sources[3].authoritative_identity_mappings!.find(row=>row.field==='root_cause')!.identity_digest=`sha256:${'2'.repeat(64)}`;
  const report=evaluateOfflineDataset(input);
  assert.equal(report.pairs[0].strong_relation_prediction,'same_root_cause_different_instance');
  assert.equal(report.pairs[1].strong_relation_prediction,'distinct');
  assert.equal(report.splits.tuning.strong_pair_rule_metrics.per_class.same_root_cause_different_instance.true_positive,1);
  assert.equal(report.splits.tuning.strong_pair_rule_metrics.per_class.same_root_cause_different_instance.precision.value,1);
  assert.equal(report.splits.tuning.strong_pair_rule_metrics.per_class.same_problem.recall.value,null);
  assert.equal(report.splits.holdout.strong_pair_rule_metrics.per_class.distinct.true_positive,1);
});
test('strong metrics preserve missing and weak or insufficient labels outside scored denominators',()=>{
  const input=tuningStrongFixture();
  input.pairs=[{left_id:uuid(0),right_id:uuid(1),label:null},{left_id:uuid(0),right_id:uuid(2),label:'similar'},
    {left_id:uuid(0),right_id:uuid(3),label:'insufficient_information'},{left_id:uuid(1),right_id:uuid(2),label:'distinct'}];
  const report=evaluateOfflineDataset(input),metrics=report.splits.tuning.strong_pair_rule_metrics;
  assert.equal(metrics.observations,4);assert.equal(metrics.labeled_observations,3);assert.equal(metrics.scored_observations,1);
  assert.equal(metrics.missing_labels,1);assert.equal(metrics.ambiguous_labels,2);assert.equal(metrics.weak_similarity_labels,1);
  assert.equal(metrics.labeled_insufficient,1);assert.equal(metrics.predicted_strong_with_missing_label,1);
  assert.equal(metrics.predicted_strong_with_ambiguous_label,2);
  assert.equal(metrics.per_class.same_problem.false_positive,1);
  assert.deepEqual(metrics.per_class.same_problem.precision,{numerator:0,denominator:1,value:0});
  assert.deepEqual(metrics.per_class.same_problem.recall,{numerator:0,denominator:0,value:null});
  assert.equal(metrics.confusion_matrix.missing_label.same_problem,1);
  assert.equal(metrics.confusion_matrix.ambiguous_weak_similarity.same_problem,1);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.missing_labels,2);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.ambiguous_labels,4);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.candidate_recall_at_k.value,null);
  assert.equal(report.splits.tuning.strong_candidate_pipeline_metrics.retrieved_without_pair_label,4);
});
test('empty or entirely unknown strong populations never manufacture precision or recall',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='similar';input.pairs[1].label=null;
  const report=evaluateOfflineDataset(input);
  for(const split of ['tuning','holdout']){
    const metrics=report.splits[split].strong_pair_rule_metrics;
    assert.equal(metrics.scored_observations,0);assert.equal(metrics.accuracy.value,null);
    assert.equal(metrics.per_class.same_problem.precision.value,null);assert.equal(metrics.per_class.same_problem.recall.value,null);
    assert.equal(report.splits[split].strong_candidate_pipeline_metrics.candidate_recall_at_k.value,null);
  }
  input.pairs=[];const empty=evaluateOfflineDataset(input).splits.tuning.strong_pair_rule_metrics;
  assert.equal(empty.observations,0);assert.equal(empty.missing_label_rate.value,null);assert.equal(empty.ambiguous_label_rate.value,null);
});
test('missing and stale identity mappings count as strong abstentions and positive false negatives',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='same_problem';input.pairs[1].label='same_problem';
  input.sources[0].authoritative_identity_mappings=input.sources[0].authoritative_identity_mappings!.filter(row=>row.field!=='root_cause');
  for(const mapping of input.sources[2].authoritative_identity_mappings!)mapping.freshness_until='2000-01-01T00:00:00.000Z';
  const report=evaluateOfflineDataset(input);
  for(const split of ['tuning','holdout']){
    const metrics=report.splits[split].strong_pair_rule_metrics;
    assert.equal(metrics.predicted_insufficient,1);assert.equal(metrics.per_class.same_problem.false_negative,1);
    assert.equal(metrics.per_class.same_problem.recall.value,0);assert.equal(metrics.per_class.same_problem.precision.value,null);
    assert.equal(metrics.confusion_matrix.same_problem.insufficient_information,1);
  }
  assert.ok(report.pairs.every(pair=>pair.strong_relation_prediction==='insufficient_information'));
});
test('strong pipeline includes both same-issue label aliases and lexical-window misses in its denominator',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='same_problem';input.pairs[1].label='suspected_same_issue';input.config.scan_limit=1;
  const report=evaluateOfflineDataset(input);
  for(const split of ['tuning','holdout']){
    const direct=report.splits[split].strong_pair_rule_metrics,pipeline=report.splits[split].strong_candidate_pipeline_metrics;
    assert.equal(direct.per_class.same_problem.recall.value,1);
    assert.equal(pipeline.observations,2);assert.equal(pipeline.scored_observations,2);
    assert.deepEqual(pipeline.candidate_recall_at_k,{numerator:1,denominator:2,value:0.5});
    assert.equal(pipeline.per_class.same_problem.true_positive,1);assert.equal(pipeline.per_class.same_problem.false_negative,1);
    assert.equal(pipeline.per_class.same_problem.recall.value,0.5);assert.equal(pipeline.not_retrieved,1);
    assert.equal(pipeline.not_retrieved_positive,1);assert.equal(pipeline.confusion_matrix.same_problem.not_retrieved,1);
    assert.equal(pipeline.execution_plane,'offline_local_lexical_corpus_window_then_identity_comparison');
    assert.ok(pipeline.retrieval_scope.includes('not SQL identity/root-cause worker'));
  }
  assert.equal(report.splits.tuning.candidate_pipeline_metrics.candidate_recall_at_k.value,null,'existing lexical label population is unchanged');
});
test('strong direct identity matches can remain entirely unretrieved by lexical simulation',()=>{
  const input=withStrongMappings(fixture());input.pairs[0].label='same_problem';
  input.sources[1].title='unrelated zzz';input.sources[1].summary=null;
  const report=evaluateOfflineDataset(input),direct=report.splits.tuning.strong_pair_rule_metrics,pipeline=report.splits.tuning.strong_candidate_pipeline_metrics;
  assert.equal(direct.per_class.same_problem.true_positive,1);assert.equal(direct.per_class.same_problem.recall.value,1);
  assert.equal(pipeline.candidate_recall_at_k.value,0);assert.equal(pipeline.not_retrieved_positive,2);
  assert.equal(pipeline.per_class.same_problem.false_negative,2);assert.equal(pipeline.per_class.same_problem.recall.value,0);
  assert.equal(pipeline.per_class.same_problem.precision.value,null);
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
    const run=(args:string[])=>promisify(execFile)(process.execPath,['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,'--import',pathToFileURL(guard).href,cli,...args],
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
