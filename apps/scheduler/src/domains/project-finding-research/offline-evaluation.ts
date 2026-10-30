import { createHash } from 'node:crypto';
import { compareFindingFeatures, EXTRACTOR_VERSION, extractFindingFeatures, IDENTITY_FIELDS,
  NORMALIZATION_VERSION, rankLexicalCandidates, RELATION_RULE_VERSION, type RelationKind } from './model.js';
import { parseOfflineDataset, RELATION_LABELS, type OfflineDataset, type OfflineSource } from './offline-evaluation-input.js';

function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function offlineDigest(value:unknown):string{return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;}
const ratio=(numerator:number,denominator:number)=>({numerator,denominator,value:denominator?numerator/denominator:null});
interface Observation{label:RelationKind|null;prediction:RelationKind|null}
function classification(observations:Observation[]){
  const labeled=observations.filter(row=>row.label!==null);
  return {labeled_observations:labeled.length,missing_labels:observations.length-labeled.length,
    missing_label_rate:ratio(observations.length-labeled.length,observations.length),
    labeled_insufficient_rate:ratio(labeled.filter(row=>row.label==='insufficient_information').length,labeled.length),
    confusion_matrix:Object.fromEntries(RELATION_LABELS.map(label=>[label,Object.fromEntries([...RELATION_LABELS,'not_retrieved'].map(prediction=>
      [prediction,labeled.filter(row=>row.label===label&&(row.prediction??'not_retrieved')===prediction).length]))])),
    per_class:Object.fromEntries(RELATION_LABELS.map(kind=>{
      const tp=labeled.filter(row=>row.label===kind&&row.prediction===kind).length;
      const predicted=labeled.filter(row=>row.prediction===kind).length,actual=labeled.filter(row=>row.label===kind).length;
      return [kind,{true_positive:tp,false_positive:predicted-tp,false_negative:actual-tp,
        precision:ratio(tp,predicted),recall:ratio(tp,actual)}];
    })),accuracy:ratio(labeled.filter(row=>row.label===row.prediction).length,labeled.length),
    predicted_insufficient:labeled.filter(row=>row.prediction==='insufficient_information').length,
    predicted_insufficient_rate:ratio(labeled.filter(row=>row.prediction==='insufficient_information').length,labeled.length),
    predicted_insufficient_all_observations:ratio(observations.filter(row=>row.prediction==='insufficient_information').length,observations.length),
    not_retrieved:labeled.filter(row=>row.prediction===null).length,
    not_retrieved_rate:ratio(labeled.filter(row=>row.prediction===null).length,labeled.length)};
}
function coverage(sources:OfflineSource[]){
  return {declared_fields:Object.fromEntries((['title','location','summary','profile','category'] as const).map(field=>
    [field,ratio(sources.filter(row=>Boolean(row[field]?.trim())).length,sources.length)])),
    provided_identity_fields:Object.fromEntries(IDENTITY_FIELDS.map(field=>
      [field,ratio(sources.filter(row=>Boolean(row.identity_declarations?.[field]?.trim())).length,sources.length)])),
    authoritative_mapping:ratio(0,sources.length)};
}
function features(source:OfflineSource){
  // Offline adapter only. Group IDs and supplied identity declarations never populate authority fields.
  return extractFindingFeatures({id:source.id,project_id:source.project_id,job_id:source.job_id,canvas_id:source.job_id,
    artifact_id:null,artifact_revision:null,title:source.title,location:source.location,summary:source.summary,
    profile:source.profile,category:source.category,source_digest:source.digest??`revision:${source.revision}`,
    updated_at:'offline-declaration'});
}

/** Pure local simulation. Revalidation prevents callers from bypassing the import contract. */
export function evaluateOfflineDataset(input:OfflineDataset){
  const dataset=parseOfflineDataset(JSON.stringify(input));
  const byId=new Map(dataset.sources.map(row=>[row.id,row]));
  const projected=new Map(dataset.sources.map(row=>[row.id,features(row)]));
  const versions={extractor:EXTRACTOR_VERSION,normalization:NORMALIZATION_VERSION,relation_rule:RELATION_RULE_VERSION,evaluator:'offline-evaluation/v1'};
  const inputDigest=offlineDigest(dataset),configDigest=offlineDigest({config:dataset.config,versions});
  const selected=new Map<string,Set<string>>();
  const queries=dataset.sources.map(subject=>{
    // Sort/window first, then exclude the same source/Job, matching the declared local simulation contract.
    const corpus=dataset.sources.filter(peer=>peer.project_id===subject.project_id&&peer.split===subject.split);
    const window=corpus.slice(0,dataset.config.scan_limit);
    const eligible=window.filter(peer=>peer.id!==subject.id&&peer.job_id!==subject.job_id);
    const ranked=rankLexicalCandidates(projected.get(subject.id)!,eligible.map(peer=>projected.get(peer.id)!),{
      limit:dataset.config.k,scanBudget:dataset.config.scan_limit,
    });
    selected.set(subject.id,new Set(ranked.candidates.map(peer=>peer.finding_id)));
    return {source_id:subject.id,split:subject.split,examined:window.length,window_limited:corpus.length>window.length,
      rank_truncated:ranked.truncated,candidates:ranked.candidates};
  });
  const pairs=dataset.pairs.map(pair=>{
    const decision=compareFindingFeatures(projected.get(pair.left_id)!,projected.get(pair.right_id)!);
    return {...pair,split:byId.get(pair.left_id)!.split,prediction:decision.kind,reason:decision.reason,
      matched_fields:decision.matched_fields,left_retrieves_right:selected.get(pair.left_id)!.has(pair.right_id),
      right_retrieves_left:selected.get(pair.right_id)!.has(pair.left_id)};
  });
  const pairLookup=new Map(dataset.pairs.map(pair=>[`${pair.left_id}|${pair.right_id}`,pair.label]));
  const splits=Object.fromEntries((['tuning','holdout'] as const).map(split=>{
    const subset=pairs.filter(pair=>pair.split===split);
    const direct=subset.map(pair=>({label:pair.label,prediction:pair.prediction}));
    const directed=subset.flatMap(pair=>[pair.left_retrieves_right,pair.right_retrieves_left]
      .map(retrieved=>({label:pair.label,prediction:retrieved?pair.prediction:null,retrieved})));
    const positive=directed.filter(row=>row.label!==null&&['suspected_same_issue','same_root_cause_different_instance','similar'].includes(row.label));
    let retrievedUnlabeled=0,retrievedWithoutPair=0,retrievedNullLabel=0,retrievedLabeled=0;
    for(const query of queries.filter(row=>row.split===split))for(const candidate of query.candidates){
      const key=[query.source_id,candidate.finding_id].sort().join('|');
      if(!pairLookup.has(key)){retrievedUnlabeled++;retrievedWithoutPair++;}
      else if(pairLookup.get(key)===null){retrievedUnlabeled++;retrievedNullLabel++;}
      else retrievedLabeled++;
    }
    return [split,{sources:dataset.sources.filter(row=>row.split===split).length,pairs:subset.length,coverage:coverage(dataset.sources.filter(row=>row.split===split)),
      pair_rule_metrics:classification(direct),candidate_pipeline_metrics:{...classification(directed),
        unit:'directed labeled pair opportunities',candidate_recall_at_k:ratio(positive.filter(row=>row.retrieved).length,positive.length),
        candidate_recall_population:'only supplied labels suspected_same_issue/same_root_cause_different_instance/similar; not corpus-wide recall',
        retrieved_labeled:retrievedLabeled,retrieved_unlabeled:retrievedUnlabeled,
        retrieved_unlabeled_rate:ratio(retrievedUnlabeled,retrievedUnlabeled+retrievedLabeled),
        retrieved_with_null_label:retrievedNullLabel,retrieved_without_pair_label:retrievedWithoutPair,
        not_retrieved_positive:positive.filter(row=>!row.retrieved).length,
        not_retrieved_positive_rate:ratio(positive.filter(row=>!row.retrieved).length,positive.length)}}];
  }));
  const body={schema_version:1,dataset_id:dataset.dataset_id,dataset_kind:dataset.dataset_kind,metadata:dataset.metadata,
    input_digest:inputDigest,config_digest:configDigest,versions,configuration:dataset.config,
    configuration_predeclaration_verified:false,independent_label_verification:false,split_group_truth_verified:false,
    production_k:25,production_scan:128,experimental_configuration:dataset.config.k!==25||dataset.config.scan_limit!==128,
    execution_plane:'offline_local_corpus_window_simulation',quality_gate_status:'not_assessed',
    interpretation:'No SQL/live recall measurement, automatic parameter selection, relation clustering, or strong-relation quality certification.',
    canonicalization:'source/pair/annotator sorting, lowercase UUIDs, recursively sorted object keys; raw declaration text preserved',
    coverage:coverage(dataset.sources),
    identity_coverage:{provided_fields:coverage(dataset.sources).provided_identity_fields,
      available_authoritative_mapping_fields:0,sources_with_authoritative_mapping:0},
    sources:dataset.sources.map(row=>({id:row.id,project_id:row.project_id,job_id:row.job_id,split:row.split,revision:row.revision,
      digest:row.digest,input_digest:offlineDigest(row)})),splits,pairs,queries};
  return {...body,report_digest:offlineDigest(body)};
}
