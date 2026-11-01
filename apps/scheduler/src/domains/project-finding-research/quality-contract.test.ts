import test from "node:test";
import assert from "node:assert/strict";
import { qualityDigest, qualityDatasetDigests, assertQualityBudget, QualityContractError,
  QualityScopeSchema, QualityProtocolBodySchema, QualityDatasetBodySchema, QualityRunBindingSchema,
  QualityUuidSchema, QUALITY_SOURCE_LIMIT, QUALITY_LABEL_LIMIT, QUALITY_TRACE_LIMIT, QUALITY_DECISION_LIMIT,
  QUALITY_INPUT_BYTES, QUALITY_METRIC_VERSION, QUALITY_POPULATION_VERSION, QUALITY_LABEL_MAPPING_VERSION,
  QUALITY_CONTRACT_MODULE_URL } from "./quality-contract.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";

// All data, labels, provenance and threshold values below are synthetic test
// inputs. They are NOT approved thresholds or genuine independent evidence.
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12,"0")}`;
const d = qualityDigest("synthetic fixture");
function dataset() { return { schema_version: 1, kind: "synthetic",
  sources: [1,2,3].map((n) => ({ id:id(n), source_digest:d, identity_digest:d, provenance_digest:d,
    asset_group_digest:qualityDigest(n), family_group_digest:qualityDigest(n), split:n === 3 ? "tuning" : "holdout" })),
  pairs:[{left_id:id(1),right_id:id(2),label:"same_problem",label_evidence_digest:d}],
}; }
function protocol() { return { schema_version:1,scope:{ project_id:id(99), code_digest:d,config_digest:d,selector_digest:d,normalization_digest:d,strong_rule_digest:d,
  extractor_version:"synthetic/v1",normalization_version:"synthetic/v1",strong_rule_version:STRONG_RELATION_RULE_VERSION,
  metric_version:QUALITY_METRIC_VERSION,population_version:QUALITY_POPULATION_VERSION,label_mapping_version:QUALITY_LABEL_MAPPING_VERSION,
  corpus_digest:d,...qualityDatasetDigests(dataset()) },
  thresholds:{same_problem:{precision:1,recall:1},same_root_cause_different_instance:{precision:1,recall:1}},valid_until:"2026-12-01T00:00:00Z" }; }
test("metadata-only protocol requires explicit both-class thresholds and rejects authority/backdate fields", () => {
  assert.ok(QualityProtocolBodySchema.safeParse(protocol()).success);
  for (const field of ["dataset","pairs","actor","frozen_at","evaluation_as_of","passed","approved","quorum","minimum_samples","report_digest"]) {
    assert.equal(QualityProtocolBodySchema.safeParse({...protocol(),[field]:true}).success,false,field);
  }
  const p = protocol();
  assert.equal(QualityProtocolBodySchema.safeParse({...p,thresholds:{same_problem:p.thresholds.same_problem}}).success,false);
  assert.equal(QualityProtocolBodySchema.safeParse({...p,thresholds:undefined}).success,false);
  assert.equal(QualityProtocolBodySchema.safeParse({...p,scope:{...p.scope,passed:true}}).success,false);
});
test("finite thresholds have no approved defaults; exact label/population versions bind", () => {
  for (const n of [0,0.5,1]) { const p=protocol();p.thresholds.same_problem.precision=n; assert.ok(QualityProtocolBodySchema.safeParse(p).success); }
  for (const n of [-0.1,1.1,NaN,Infinity]) { const p=protocol();p.thresholds.same_problem.recall=n; assert.equal(QualityProtocolBodySchema.safeParse(p).success,false); }
  for (const field of ["metric_version","population_version","label_mapping_version","strong_rule_version"] as const) {
    assert.equal(QualityScopeSchema.safeParse({...protocol().scope,[field]:"other/v1"}).success,false);
  }
  const input=dataset();
  for (const label of ["bothstrong","suspected_same_issue","similar","same_root_cause"]) { input.pairs[0]!.label=label; assert.equal(QualityDatasetBodySchema.safeParse(input).success,false); }
});
test("canonical UUID/digest/time conventions reject aliases rather than normalize", () => {
  const uuid="abcdef00-0000-4000-8000-000000000001";
  assert.equal(QualityUuidSchema.parse(uuid),uuid);
  assert.equal(QualityUuidSchema.safeParse(uuid.toUpperCase()).success,false);
  for (const value of ["identity-source-1", "not-a-uuid"]) assert.equal(QualityUuidSchema.safeParse(value).success,false);
  const p=protocol();
  for (const code_digest of [d.slice(7),d.toUpperCase(),"sha256:xyz"]) assert.equal(QualityScopeSchema.safeParse({...p.scope,code_digest}).success,false);
  assert.equal(QualityProtocolBodySchema.safeParse({...p,valid_until:"2026-12-01"}).success,false);
  assert.match(QUALITY_CONTRACT_MODULE_URL,/^file:/u);
  assert.equal(QualityProtocolBodySchema.safeParse({...p,module_url:QUALITY_CONTRACT_MODULE_URL}).success,false);
});
test("only canonical holdout labels; no tuning/cross-split/reverse/self/duplicate pairs", () => {
  const input=dataset(), original=input.pairs[0]!;
  for (const row of [{...original,left_id:id(2),right_id:id(1)}, {...original,right_id:id(1)},
    {...original,right_id:id(3)}, {...original,right_id:id(4)}]) {
    assert.equal(QualityDatasetBodySchema.safeParse({...input,pairs:[row]}).success,false);
  }
  assert.equal(QualityDatasetBodySchema.safeParse({...input,pairs:[original,original]}).success,false);
  assert.equal(QualityDatasetBodySchema.safeParse({...input,sources:[...input.sources,input.sources[0]]}).success,false);
  assert.equal(QualityDatasetBodySchema.safeParse({...input,pairs:[{...original,label:null}]}).success,true);
  assert.equal(QualityDatasetBodySchema.safeParse({...input,pairs:[{...original,label:"insufficient_information"}]}).success,true);
});
test("strict nested declarations cannot carry verification or authority flags", () => {
  const input=dataset();
  for (const field of ["reviewer_authenticated","aliases_resolved","conflicts_cleared","passed"]) {
    assert.equal(QualityDatasetBodySchema.safeParse({...input,[field]:true}).success,false);
    assert.equal(QualityDatasetBodySchema.safeParse({...input,sources:[{...input.sources[0],[field]:true},...input.sources.slice(1)]}).success,false);
    assert.equal(QualityDatasetBodySchema.safeParse({...input,pairs:[{...input.pairs[0],[field]:true}]}).success,false);
  }
  const binding={protocol_id:id(70),run_id:id(71),dataset_id:id(72),protocol_digest:qualityDigest(protocol()),scope:protocol().scope,evaluated_at:"2026-11-01T00:03:00Z"};
  assert.ok(QualityRunBindingSchema.safeParse(binding).success);
  assert.equal(QualityRunBindingSchema.safeParse({...binding,as_of:"2020-01-01T00:00:00Z"}).success,false);
});
test("canonical digests bind immutable declarations without mutating or authenticating", () => {
  assert.equal(qualityDigest({b:1,a:2}),qualityDigest({a:2,b:1}));
  assert.notEqual(qualityDigest([1,2]),qualityDigest([2,1]));
  for (const value of [undefined,NaN,Infinity,{x:undefined},new Date(),new Array(1),()=>1]) assert.throws(()=>qualityDigest(value));
  const input=dataset(), before=JSON.stringify(input), hash=qualityDatasetDigests(input);
  assert.deepEqual(qualityDatasetDigests({...input,sources:[...input.sources].reverse()}),hash);
  assert.equal(JSON.stringify(input),before);
  const changed=dataset();changed.pairs[0]!.label="distinct";
  assert.notEqual(qualityDatasetDigests(changed).labelset_digest,hash.labelset_digest);
  changed.sources[2]!.family_group_digest=qualityDigest("changed");
  assert.notEqual(qualityDatasetDigests(changed).tuning_digest,hash.tuning_digest);
  assert.notEqual(qualityDatasetDigests(changed).split_digest,hash.split_digest);
});
test("technical count budgets accept exact limits, reject overflow before cloning", () => {
  for (const [field,limit] of [["sources",QUALITY_SOURCE_LIMIT],["pairs",QUALITY_LABEL_LIMIT],
    ["selections",QUALITY_TRACE_LIMIT],["decisions",QUALITY_DECISION_LIMIT]] as const) {
    assert.doesNotThrow(()=>assertQualityBudget({[field]:Array(limit).fill(null)}));
    assert.throws(()=>assertQualityBudget({[field]:Array(limit+1).fill(null)}),QualityContractError);
  }
  assert.equal(QualityDatasetBodySchema.safeParse({...dataset(),sources:Array(QUALITY_SOURCE_LIMIT+1).fill(dataset().sources[0])}).success,false);
  assert.equal(QualityDatasetBodySchema.safeParse({...dataset(),pairs:Array(QUALITY_LABEL_LIMIT+1).fill(dataset().pairs[0])}).success,false);
});
test("16MiB is a UTF8 byte ceiling, not a sample minimum", () => {
  assert.doesNotThrow(()=>assertQualityBudget("x".repeat(QUALITY_INPUT_BYTES-2)));
  assert.throws(()=>assertQualityBudget("x".repeat(QUALITY_INPUT_BYTES-1)),QualityContractError);
  assert.throws(()=>assertQualityBudget("中".repeat(Math.floor(QUALITY_INPUT_BYTES/2))),QualityContractError);
  assert.throws(()=>assertQualityBudget(undefined),QualityContractError);
});

test("normalization/rule digests mandatory independently of descriptive versions/code bundle",()=>{
  const scope=protocol().scope;
  for(const field of ["normalization_digest","strong_rule_digest"] as const) {
    const missing=Object.fromEntries(Object.entries(scope).filter(([key])=>key!==field));
    assert.equal(QualityScopeSchema.safeParse(missing).success,false,field);
    assert.equal(QualityScopeSchema.safeParse({...scope,[field]:"fake/v1"}).success,false,field);
  }
});
