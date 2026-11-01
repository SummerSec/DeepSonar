import test from "node:test";
import assert from "node:assert/strict";
import { computeQualityMetrics, assessQualityGate, QUALITY_METRICS_MODULE_URL, type QualityMetricReport } from "./quality-metrics.js";
import { qualityDigest,qualityDatasetDigests,QualityDatasetBodySchema,QualityProtocolBodySchema,
  QUALITY_METRIC_VERSION,QUALITY_POPULATION_VERSION,QUALITY_LABEL_MAPPING_VERSION,QUALITY_TRUTH_LABELS,
  type QualityDatasetBody,type QualityGateHostContext } from "./quality-contract.js";
import { validateQualityRecord } from "./quality-ledger.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";
import { RELATION_PAIR_LIMIT } from "./strong-candidate-selector.js";

// SYNTHETIC unit fixtures only, including fake host records. Human-kind metadata
// below exercises abstract gate branches, NOT genuine labels, SQL or quality.
const id=(n:number)=>`10000000-0000-4000-8000-${n.toString().padStart(12,"0")}`;
const d=qualityDigest("fake evidence");
const source=(n:number,split:"holdout"|"tuning"="holdout")=>({id:id(n),source_digest:qualityDigest([n,"finding"]),
  identity_digest:qualityDigest([n,"snapshot"]),provenance_digest:d,asset_group_digest:qualityDigest(n),family_group_digest:qualityDigest(n),split});
function dataset(): QualityDatasetBody { return QualityDatasetBodySchema.parse({schema_version:1,kind:"human_labeled",
  sources:[source(1),source(2),source(3),source(900,"tuning"),source(901,"tuning")],pairs:[
    {left_id:id(1),right_id:id(2),label:"same_problem",label_evidence_digest:d},
    {left_id:id(1),right_id:id(3),label:"same_root_cause_different_instance",label_evidence_digest:d},
    {left_id:id(2),right_id:id(3),label:"distinct",label_evidence_digest:d},
  ]}); }
const trace=(n:number,peers:number[]=[])=>({finding_id:id(n),peerIds:peers.map(id),observedCount:peers.length,truncated:false,countKind:"exact" as "exact"|"lower_bound"});
const decision=(a:number,b:number,prediction:typeof QUALITY_TRUTH_LABELS[number])=>({left_id:id(a),right_id:id(b),prediction});
function packet(data=dataset()) {
  const scope={project_id:id(99),code_digest:d,config_digest:d,selector_digest:d,normalization_digest:d,strong_rule_digest:d,extractor_version:"fake/v1",normalization_version:"fake/v1",
    strong_rule_version:STRONG_RELATION_RULE_VERSION,metric_version:QUALITY_METRIC_VERSION,population_version:QUALITY_POPULATION_VERSION,
    label_mapping_version:QUALITY_LABEL_MAPPING_VERSION,corpus_digest:d,...qualityDatasetDigests(data)};
  const protocol=QualityProtocolBodySchema.parse({schema_version:1,scope,valid_until:"2026-12-01T00:00:00Z",
    thresholds:{same_problem:{precision:1,recall:1},same_root_cause_different_instance:{precision:1,recall:1}}});
  return {protocol,input:{binding:{protocol_id:id(70),run_id:id(71),dataset_id:id(72),protocol_digest:qualityDigest(protocol),scope,evaluated_at:"2026-11-01T00:03:00Z"},
    dataset:data,selections:[trace(1,[2,3]),trace(2,[3]),trace(3)],
    decisions:[decision(1,2,"same_problem"),decision(1,3,"same_root_cause_different_instance"),decision(2,3,"distinct")]}};
}
function writerDigest(row: Record<string,unknown>) {
  return qualityDigest({id:row.id,project_id:row.project_id,protocol_id:row.protocol_id,kind:row.kind,
    subject_record_id:row.subject_record_id,actor:{type:row.actor_type,id:row.actor_id,name:row.actor_name},body:row.body_json});
}
function reviewRow(record: QualityGateHostContext["record"]) {
  const row={id:record.review_id,project_id:record.scope.project_id,protocol_id:record.protocol_id,kind:"review",
    record_digest:d,subject_record_id:record.evaluation_id,request_key:null,actor_type:"user",
    actor_id:record.reviewer_id,actor_name:"synthetic reviewer",created_at:record.reviewed_at,
    body_json:{protocol_digest:record.protocol_digest,scope_digest:qualityDigest(record.scope),run_id:record.run_id,
      dataset_id:record.dataset_id,report_digest:record.report_digest,evidence_digest:record.evidence_digest,expires_at:record.expires_at}};
  row.record_digest=writerDigest(row);
  return row;
}
function reseal(context:QualityGateHostContext) {
  const row=reviewRow(context.record);context.review_row=row;context.record.review_digest=row.record_digest;return context;
}
function contextFor(report:QualityMetricReport):QualityGateHostContext {
  const b=report.binding; return reseal({current_scope:structuredClone(b.scope),current_time:"2026-11-01T00:05:00Z",review_row:null,record:{
    review_id:id(80),review_digest:d,evaluation_id:id(79),protocol_id:b.protocol_id,run_id:b.run_id,dataset_id:b.dataset_id,
    protocol_digest:b.protocol_digest,report_digest:report.report_digest,scope:structuredClone(b.scope),evidence_digest:d,
    reviewer_id:"operator-reviewer",maker_ids:["operator-maker"],tuner_ids:["operator-tuner"],
    registrar_ids:["operator-registrar"],custodian_ids:["operator-custodian"],reviewer_alias_ids:["principal:reviewer"],forbidden_alias_ids:["principal:maker"],
    reviewer_authenticated:true,aliases_resolved:"verified",conflicts_cleared:"verified",independent_reviewer:"verified",
    independent_human_labels:"verified",source_provenance:"verified",split_isolation:"verified",denominator_complete:"verified",
    observations_complete:"verified",thresholds_adopted:"verified",current_sources:"verified",
    frozen_at:"2026-11-01T00:00:00Z",thresholds_adopted_at:"2026-11-01T00:00:01Z",first_holdout_access_at:"2026-11-01T00:01:00Z",
    dataset_admitted_at:"2026-11-01T00:02:00Z",reviewed_at:"2026-11-01T00:04:00Z",expires_at:"2026-12-01T00:00:00Z",revoked_at:null,
  }});
}
const classify=(p:ReturnType<typeof packet>,report=computeQualityMetrics(p.input),context=contextFor(report))=>assessQualityGate(p.protocol,report,context);
test("synthetic exact writer review envelope binds without inventing a derived-context hash", () => {
  const p=packet(),r=computeQualityMetrics(p.input),c=contextFor(r);
  const row=c.review_row as ReturnType<typeof reviewRow>,receipt=validateQualityRecord(row);
  assert.equal(receipt.kind,"review");assert.equal(receipt.record_digest,writerDigest(row));
  assert.equal(receipt.record_digest,c.record.review_digest);
  const {review_digest,...derived}=c.record;
  assert.notEqual(review_digest,qualityDigest(derived));
  assert.equal(classify(p,r,c).status,"passed"); // Synthetic algorithm branch, not SQL/human evidence.
  const sqlShape=contextFor(r),raw=sqlShape.review_row as ReturnType<typeof reviewRow>;
  sqlShape.review_row={...raw,created_at:new Date(raw.created_at),body_json:JSON.stringify(raw.body_json)};
  assert.equal(classify(p,r,sqlShape).status,"passed");
  const invented=contextFor(r),{review_digest:ignored,...inventedBody}=invented.record;
  invented.record.review_digest=qualityDigest(inventedBody);
  assert.equal(classify(p,r,invented).status,"not_evaluated");
  const absent=contextFor(r);delete (absent as Partial<QualityGateHostContext>).review_row;
  assert.equal(classify(p,r,absent).status,"not_evaluated");
});
test("writer receipt digest protects body, IDs, scope, project, subject and exact actor envelope", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  const mutations:Array<(row:ReturnType<typeof reviewRow>)=>void>=[
    row=>{row.record_digest=qualityDigest("tampered");},row=>{row.id=id(999);},
    row=>{row.project_id=id(999);},row=>{row.protocol_id=id(999);},row=>{row.subject_record_id=id(999);},
    row=>{row.actor_id="different-principal";},row=>{row.actor_name="different display name";},
    row=>{row.body_json.scope_digest=qualityDigest("other scope");},
    row=>{row.body_json.report_digest=qualityDigest("other report");},
    row=>{row.body_json.evidence_digest=qualityDigest("other evidence");},
    row=>{row.body_json.run_id=id(999);},row=>{row.body_json.dataset_id=id(999);},
  ];
  for(const mutate of mutations) {
    const c=contextFor(r);mutate(c.review_row as ReturnType<typeof reviewRow>);
    assert.equal(classify(p,r,c).status,"not_evaluated");
  }
});
test("even valid writer receipts must bind kind, evaluation subject, scope, reviewer and all report fields", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  const changes:Array<(row:ReturnType<typeof reviewRow>)=>void>=[
    row=>{row.id=id(999);},row=>{row.project_id=id(999);},row=>{row.protocol_id=id(999);},
    row=>{row.subject_record_id=id(999);},row=>{row.actor_id="other-reviewer";},row=>{row.actor_type="api_token";},
    row=>{row.body_json.protocol_digest=qualityDigest("other protocol");},
    row=>{row.body_json.scope_digest=qualityDigest("other scope");},
    row=>{row.body_json.run_id=id(999);},row=>{row.body_json.dataset_id=id(999);},
    row=>{row.body_json.report_digest=qualityDigest("other report");},
    row=>{row.body_json.evidence_digest=qualityDigest("other evidence");},
  ];
  for(const change of changes) {
    const c=contextFor(r),row=c.review_row as ReturnType<typeof reviewRow>;
    change(row);row.record_digest=writerDigest(row);c.record.review_digest=row.record_digest;
    assert.doesNotThrow(()=>validateQualityRecord(row));
    assert.ok(classify(p,r,c).reasons.includes("UNBOUND_EVIDENCE"));
  }
  const c=contextFor(r),row=c.review_row as ReturnType<typeof reviewRow>;
  const evaluation={...row,kind:"evaluation",body_json:{protocol_digest:r.binding.protocol_digest,
    scope_digest:qualityDigest(r.binding.scope),binding:r.binding,report_digest:r.report_digest}};
  evaluation.record_digest=writerDigest(evaluation);c.record.review_digest=evaluation.record_digest;c.review_row=evaluation;
  assert.equal(validateQualityRecord(evaluation).kind,"evaluation");
  assert.equal(classify(p,r,c).status,"not_evaluated");
  for(const field of ["review_id","evaluation_id","reviewer_id"] as const) {
    const mismatched=contextFor(r);mismatched.record[field]=id(999);
    assert.ok(classify(p,r,mismatched).reasons.includes("UNBOUND_EVIDENCE"),field);
  }
});
test("SQL-created review time and body expiry bind separately; hashed client booleans cannot qualify", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  const at=contextFor(r),row=at.review_row as ReturnType<typeof reviewRow>;
  row.created_at="2026-11-01T00:04:01Z";
  assert.equal(validateQualityRecord(row).record_digest,at.record.review_digest); // Writer does NOT hash SQL time.
  assert.ok(classify(p,r,at).reasons.includes("UNBOUND_EVIDENCE"));
  const expires=contextFor(r),expiryRow=expires.review_row as ReturnType<typeof reviewRow>;
  expiryRow.body_json.expires_at="2026-11-30T00:00:00Z";
  expiryRow.record_digest=writerDigest(expiryRow);expires.record.review_digest=expiryRow.record_digest;
  assert.doesNotThrow(()=>validateQualityRecord(expiryRow));
  assert.ok(classify(p,r,expires).reasons.includes("UNBOUND_EVIDENCE"));
  for(const field of ["reviewed_at","expires_at"] as const) {
    const c=contextFor(r);c.record[field]=field==="reviewed_at"?"2026-11-01T00:04:01Z":"2026-11-30T00:00:00Z";
    assert.ok(classify(p,r,c).reasons.includes("UNBOUND_EVIDENCE"),field);
  }
  const client=contextFor(r),raw=client.review_row as ReturnType<typeof reviewRow>;
  const declaration={...raw,body_json:{...raw.body_json,verified:true,independent:true}};
  declaration.record_digest=writerDigest(declaration);client.record.review_digest=declaration.record_digest;client.review_row=declaration;
  assert.equal(classify(p,r,client).status,"not_evaluated");
});
test("single holdout universe: complete finite ratios; tuning metadata needs no traces", () => {
  const p=packet(),before=JSON.stringify(p.input),r=computeQualityMetrics(p.input);
  assert.equal(r.missing_subject_traces,0);assert.equal(r.input.selections.length,3);
  assert.equal(r.input.dataset.sources.filter((x)=>x.split==="tuning").length,2);
  assert.equal(r.known_labeled_pairs,3);assert.equal(r.selected_pairs,3);assert.equal(r.candidate_recall.value,1);
  for (const kind of ["same_problem","same_root_cause_different_instance"]) {
    assert.equal(r.per_class[kind]!.precision.value,1);assert.equal(r.per_class[kind]!.recall.value,1);
  }
  assert.equal(JSON.stringify(p.input),before);assert.ok(Object.isFrozen(r.input.dataset));
  assert.equal("per_split" in r,false);assert.match(QUALITY_METRICS_MODULE_URL,/^file:/u);
  assert.equal(classify(p,r).status,"passed"); // Fake-host abstract branch only.
});
test("whole-universe FN survive omitted, not-compared and wrong-class predictions", () => {
  const p=packet();p.input.selections[0]=trace(1,[3]);p.input.decisions.shift();
  const r=computeQualityMetrics(p.input);assert.equal(r.not_selected_positive,1);
  assert.equal(r.per_class.same_problem!.false_negative,1);assert.equal(r.candidate_recall.value,0.5);
  const q=packet();q.input.decisions[0]!.prediction="same_root_cause_different_instance";
  const wrong=computeQualityMetrics(q.input);assert.equal(wrong.per_class.same_problem!.false_negative,1);
  assert.equal(wrong.per_class.same_root_cause_different_instance!.false_positive,1);
  const missing=packet();missing.input.decisions.shift();const mr=computeQualityMetrics(missing.input);
  assert.equal(mr.not_compared_positive,1);assert.equal(mr.missing_decisions,1);
  assert.equal(classify(missing,mr).status,"not_evaluated");
});
test("any unknown/insufficient selected truth blocks despite abstention or no comparison; no fabricated FP", () => {
  for (const label of [null,"insufficient_information"] as const) {
    const data=dataset();data.pairs[0]!.label=label;const p=packet(data);
    for (const abstain of [false,true]) {const q=structuredClone(p);if(abstain) q.input.decisions[0]!.prediction="insufficient_information";
      const r=computeQualityMetrics(q.input);assert.equal(r.unknown_selected_pairs,1);
      assert.equal(r.per_class.same_problem!.false_positive,0);assert.equal(classify(q,r).status,"not_evaluated");}
    p.input.decisions.shift();assert.ok(classify(p).reasons.includes("UNKNOWN_TRUTH"));
  }
});
test("only declared holdout subjects allowed, even for empty raw traces", () => {
  for (const n of [900,4]) {const p=packet();p.input.selections.push(trace(n));assert.throws(()=>computeQualityMetrics(p.input),/INVALID_QUALITY_SUBJECT/u);}
});
test("raw tuning/outside/unlabeled peers remain recorded and block even abstained/uncompared", () => {
  for (const n of [900,4]) for (const compare of [false,true]) {
    const p=packet();p.input.selections[0]=trace(1,[2,3,n]);
    if(compare) p.input.decisions.push(decision(1,n,"insufficient_information"));
    const r=computeQualityMetrics(p.input);assert.equal(r.selected_pairs,4);assert.equal(r.unknown_selected_pairs,1);
    assert.equal(r.input.selections[0]!.peerIds.at(-1),id(n));
    assert.ok(classify(p,r).reasons.includes("UNKNOWN_TRUTH"));
  }
});
test("missing heldout traces block; no predicted positives or no actual positives give null denominators", () => {
  const p=packet();p.input.selections.pop();assert.equal(computeQualityMetrics(p.input).missing_subject_traces,1);
  assert.ok(classify(p).reasons.includes("INCOMPLETE_OBSERVATIONS"));
  const q=packet();q.input.decisions=q.input.decisions.map((x)=>({...x,prediction:"distinct"}));
  const r=computeQualityMetrics(q.input);assert.equal(r.per_class.same_problem!.precision.value,null);
  assert.equal(r.per_class.same_problem!.recall.value,0);assert.ok(classify(q,r).reasons.includes("ZERO_DENOMINATOR"));
  const data=dataset();data.pairs.forEach((x)=>{x.label="distinct";});
  const z=computeQualityMetrics(packet(data).input);assert.equal(z.per_class.same_problem!.recall.value,null);
});
test("synthetic-kind can never pass even fake bound host facts, unlike fully-scored threshold failure", () => {
  const data=dataset();data.kind="synthetic";const p=packet(data);assert.ok(classify(p).reasons.includes("SYNTHETIC_DATA"));
  const q=packet();q.input.decisions[2]!.prediction="same_problem";
  const r=computeQualityMetrics(q.input);assert.equal(r.per_class.same_problem!.precision.value,0.5);
  assert.equal(classify(q,r).status,"failed");assert.ok(classify(q,r).reasons.includes("THRESHOLD_NOT_MET"));
});
test("sentinel is bounded lower coverage: omitted labeled positive remains FN, no full-corpus rank", () => {
  const data=dataset();for(let n=4;n<=RELATION_PAIR_LIMIT+2;n++) data.sources.push(source(n));
  data.pairs.push({left_id:id(1),right_id:id(258),label:"same_problem",label_evidence_digest:d});
  const p=packet(data);p.input.selections=data.sources.filter((x)=>x.split==="holdout").map((x)=>({...trace(0),finding_id:x.id}));
  p.input.selections[0]={...trace(1),peerIds:Array.from({length:RELATION_PAIR_LIMIT},(_,i)=>id(i+2)),
    observedCount:RELATION_PAIR_LIMIT+1,truncated:true,countKind:"lower_bound"};
  p.input.decisions=p.input.decisions.slice(0,2);const r=computeQualityMetrics(p.input);
  assert.equal(r.truncated_subjects,1);assert.equal(r.not_selected_positive,1);
  assert.equal(r.per_class.same_problem!.false_negative,1);assert.equal(r.observed_rows_including_sentinels,257);
  assert.equal("full_corpus_count" in r,false);
});
test("raw sentinel/order/count/duplicate/reverse and decision-subset corruption reject", () => {
  const bad=[{...trace(1,[2,3]),observedCount:3},{...trace(1,[2,3]),truncated:true},{...trace(1,[2,3]),countKind:"lower_bound"},trace(1,[3,2]),trace(1,[2,2]),trace(1,[1])];
  for (const row of bad) {const p=packet();assert.throws(()=>computeQualityMetrics({...p.input,selections:[row,...p.input.selections.slice(1)]}));}
  const p=packet();assert.throws(()=>computeQualityMetrics({...p.input,selections:[...p.input.selections,p.input.selections[0]]}));
  assert.throws(()=>computeQualityMetrics({...p.input,decisions:[...p.input.decisions,p.input.decisions[0]]}));
  assert.throws(()=>computeQualityMetrics({...p.input,decisions:[decision(2,1,"same_problem")]}));
  assert.throws(()=>computeQualityMetrics({...p.input,decisions:[decision(1,4,"same_problem")]}));
});
test("bound independent review rejects maker/tuner/registrar/custodian/alias self-review", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  for (const field of ["maker_ids","tuner_ids","registrar_ids","custodian_ids","forbidden_alias_ids"] as const) {
    const c=contextFor(r);c.record[field]=[c.record.reviewer_id];reseal(c);
    assert.ok(classify(p,r,c).reasons.includes("REVIEWER_NOT_INDEPENDENT"),field);
  }
  const c=contextFor(r);c.record.reviewer_id="token:B";c.record.maker_ids=["token:A"];
  c.record.reviewer_alias_ids=["principal:shared-person"];c.record.forbidden_alias_ids=["principal:shared-person"];reseal(c);
  assert.ok(classify(p,r,c).reasons.includes("REVIEWER_NOT_INDEPENDENT"));
  const missing=contextFor(r);missing.record.maker_ids=[];reseal(missing);assert.equal(classify(p,r,missing).status,"not_evaluated");
});
test("all independent provenance/isolation/denominator/current/alias facts must be checked and bound", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  for (const field of ["independent_reviewer","independent_human_labels","source_provenance","split_isolation",
    "denominator_complete","observations_complete","thresholds_adopted","current_sources","aliases_resolved","conflicts_cleared"] as const) {
    for (const status of ["unknown","rejected"] as const) {const c=contextFor(r);c.record[field]=status;reseal(c);
      assert.ok(classify(p,r,c).reasons.includes("UNVERIFIED_EVIDENCE"),field);}
  }
  const c=contextFor(r);c.record.reviewer_authenticated=false;reseal(c);assert.equal(classify(p,r,c).status,"not_evaluated");
  const generic={current_scope:r.binding.scope,current_time:c.current_time,record:{verified:true,independent:true}};
  assert.equal(classify(p,r,generic as unknown as QualityGateHostContext).status,"not_evaluated");
});
test("unbound review IDs/hash/report/evidence and source/config/code/normalization/rule drift close", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  for(const field of ["protocol_id","run_id","dataset_id","report_digest","protocol_digest"] as const) {
    const c=contextFor(r);c.record[field]=field.endsWith("_id")?id(999):qualityDigest("other");reseal(c);
    assert.equal(classify(p,r,c).status,"not_evaluated",field);
  }
  const c=contextFor(r);c.record.evidence_digest=null;reseal(c);assert.ok(classify(p,r,c).reasons.includes("UNBOUND_EVIDENCE"));
  for(const field of ["code_digest","config_digest","selector_digest","normalization_digest","strong_rule_digest","source_digest","corpus_digest","labelset_digest"] as const) {
    const x=contextFor(r);x.current_scope[field]=qualityDigest("drift");assert.ok(classify(p,r,x).reasons.includes("SCOPE_DRIFT"),field);
  }
  const tampered=contextFor(r);tampered.record.reviewer_authenticated=false;assert.ok(classify(p,r,tampered).reasons.includes("REVIEWER_NOT_INDEPENDENT"));
  const bad=packet();bad.input.binding.scope.dataset_digest=qualityDigest("other");assert.throws(()=>computeQualityMetrics(bad.input),/QUALITY_DATASET_BINDING_MISMATCH/u);
});
test("report excludes self-hash and cannot forge numeric outcomes even by resealing fake host record", () => {
  const p=packet(),r=computeQualityMetrics(p.input),{report_digest,...body}=r;assert.equal(qualityDigest(body),report_digest);
  const fake=structuredClone(r);fake.per_class.same_problem!.precision.value=0;
  const {report_digest:ignored,...changed}=fake;fake.report_digest=qualityDigest(changed);
  const c=contextFor(fake);assert.ok(classify(p,fake,c).reasons.includes("REPORT_MISMATCH"));
});
test("strict-before-first-access freeze/adoption and real admission/evaluation/review order; expiry/revoke", () => {
  const p=packet(),r=computeQualityMetrics(p.input);
  for (const field of ["frozen_at","thresholds_adopted_at"] as const) {
    const c=contextFor(r);c.record[field]=c.record.first_holdout_access_at!;reseal(c);
    assert.ok(classify(p,r,c).reasons.includes("LATE_OR_INVALID_FREEZE"),field);
  }
  const late=contextFor(r);late.record.dataset_admitted_at="2026-11-01T00:04:00Z";reseal(late);assert.equal(classify(p,r,late).status,"not_evaluated");
  const expired=contextFor(r);expired.record.expires_at=expired.current_time;reseal(expired);assert.ok(classify(p,r,expired).reasons.includes("REVOKED_OR_EXPIRED"));
  const revoked=contextFor(r);revoked.record.revoked_at="2026-11-01T00:04:00Z";reseal(revoked);assert.ok(classify(p,r,revoked).reasons.includes("REVOKED_OR_EXPIRED"));
  const unknown=contextFor(r);unknown.record.first_holdout_access_at=null;reseal(unknown);assert.equal(classify(p,r,unknown).status,"not_evaluated");
});
test("missing provenance and asset/family split leakage cannot be declared away by fake host facts", () => {
  const incomplete=dataset();incomplete.sources[0]!.provenance_digest=null;incomplete.pairs[0]!.label_evidence_digest=null;
  assert.ok(classify(packet(incomplete)).reasons.includes("INCOMPLETE_PROVENANCE"));
  for(const field of ["asset_group_digest","family_group_digest"] as const) {
    const data=dataset();data.sources[0]![field]=data.sources[3]![field];assert.ok(classify(packet(data)).reasons.includes("SPLIT_LEAKAGE"));
    const unknown=dataset();unknown.sources[0]![field]=null;assert.ok(classify(packet(unknown)).reasons.includes("INCOMPLETE_SPLIT"));
  }
});
