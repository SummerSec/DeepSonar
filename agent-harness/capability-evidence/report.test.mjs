import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceReport, sourceDigest } from './report.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64);
function fixture() {
  const entry = { item_id: id(4), owner_project_id: id(1), version_id: id(5), version: 1,
    kind: 'skill', hash: sha, title: 'untrusted title' };
  return { schema: 'deepsonar.capability-evidence-export/v2', captured_at: '2026-10-29T00:00:00Z', project_id: id(1),
    jobs: [{ id: id(2), project_id: id(1), status: 'succeeded',
      project_knowledge_catalog: { entries: [entry], hash: sourceDigest([entry]) },
      capability_pack: { id: 'task.audit', version: '1', digest: `sha256:${sha}` } }],
    attempts: [{ id: id(3), job_id: id(2) }],
    versions: [{ id: id(5), project_id: id(1), item_id: id(4), version: 1, content_sha256: sha, revoked_at: null, item_status: 'active' }],
    usages: [{ id: id(6), project_id: id(1), job_id: id(2), attempt_id: id(3), owner_project_id: id(1),
      version_id: id(5), selector: `project:${id(4)}@1`, content_sha256: sha,
      declared_outcome: 'success', declared_evidence_count: 1 }],
    receipts: [{ id: id(7), project_id: id(1), job_id: id(2), attempt_id: id(3),
      operation: 'record_knowledge_feedback', state: 'settled', event_id: id(8), event_seq: 1, result: { usage_ref: id(6) } }] };
}
const report = x => buildEvidenceReport(x, sourceDigest(x));
const skill = x => report(x).records.find(r => r.kind === 'project_skill');

test('joins existing exact usage and receipt but never promotes a declaration or succeeded Job to quality', () => {
  const result = report(fixture());
  assert.equal(result.denominators.pulled_pairs, 1);
  assert.equal(result.denominators.feedback_declared_pairs, 1);
  assert.equal(result.denominators.independently_verified_pairs, 0);
  assert.equal(result.independent_quality_rate, null);
  assert.equal(skill(fixture()).pulls[0].feedback_receipt_refs[0], id(7));
  assert.equal(skill(fixture()).observed_execution, 'unknown');
  assert.equal(result.recommendation, null);
  assert.doesNotMatch(JSON.stringify(result), /untrusted|secret/);
});
test('cross-project rows never alter records, denominators or explanations', () => {
  const x = fixture(), expected = report(x);
  x.jobs.push({ id: id(20), project_id: id(21), capability_pack: { id: 'secret' } });
  x.usages.push({ ...x.usages[0], id: id(22), project_id: id(21), declared_outcome: 'failure' });
  const result = report(x);
  delete result.source_digest; delete expected.source_digest;
  assert.deepEqual(result, expected);
});
test('revoked and cross-project catalog entries do not contribute to local skill report', () => {
  const x = fixture(); x.versions[0].revoked_at = x.captured_at;
  assert.equal(report(x).denominators.local_skill_job_pairs, 0);
  x.versions[0].revoked_at = null;
  x.jobs[0].project_knowledge_catalog.entries[0].owner_project_id = id(21);
  x.jobs[0].project_knowledge_catalog.hash = sourceDigest(x.jobs[0].project_knowledge_catalog.entries);
  assert.equal(report(x).denominators.local_skill_job_pairs, 0);
});
test('different hashes, versions and attempts cannot borrow usage or feedback receipts', () => {
  for (const field of ['content_sha256', 'version_id', 'attempt_id', 'selector']) {
    const x = fixture(); x.usages[0][field] = 'different';
    assert.deepEqual(skill(x).pulls, [], field);
  }
  const x = fixture(); x.receipts[0].attempt_id = id(33);
  assert.deepEqual(skill(x).pulls[0].feedback_receipt_refs, []);
});
test('missing input, invalid snapshot, stale digest and duplicate records fail closed', () => {
  assert.throws(() => report({}));
  const x = fixture(), digest = sourceDigest(x); x.jobs[0].status = 'failed';
  assert.throws(() => buildEvidenceReport(x, digest), /SOURCE_DIGEST/);
  x.jobs[0].project_knowledge_catalog.hash = 'b'.repeat(64);
  assert.throws(() => report(x), /CATALOG_DIGEST/);
  const y = fixture(); y.usages.push(y.usages[0]);
  assert.throws(() => report(y), /DUPLICATE/);
});
test('duplicate pull identity cannot inflate sample counts', () => {
  const x = fixture(); x.usages.push({ ...x.usages[0], id: id(40) });
  assert.throws(() => report(x), /DUPLICATE_PULL/);
});
test('cold start and unpulled catalog membership produce explicit unknowns', () => {
  const x = fixture(); x.usages = []; x.receipts = [];
  assert.equal(report(x).denominators.pulled_pairs, 0);
  assert.equal(skill(x).exposure, 'unknown');
  x.jobs = []; assert.deepEqual(report(x).records, []);
});
test('rebuilding is deterministic and does not mutate the source or attribute success to pack members', () => {
  const x = fixture(); const before = structuredClone(x);
  assert.deepEqual(report(x), report(x)); assert.deepEqual(x, before);
  const pack = report(x).records.find(r => r.kind === 'configured_pack');
  assert.equal(pack.attribution, 'combination_only_no_causal_claim');
  assert.equal(pack.independent_quality, 'unknown');
});

function addChoice(x, decision = 'select', number = 50, seq = 2) {
  const selector = `project:${id(4)}@1`;
  const receipt = { id: id(number), project_id: id(1), job_id: id(2), attempt_id: id(3),
    operation: 'record_skill_choice', state: 'settled', event_id: id(number + 100), event_seq: seq,
    result: { decision, selector: decision === 'none' ? null : selector, content_hash: decision === 'none' ? null : sha,
      policy_version: 'deepsonar.skill-suggestions/v1', context_hash: 'c'.repeat(64),
      catalog_hash: x.jobs[0].project_knowledge_catalog.hash, reason_present: true,
      candidate: decision === 'none' ? null : { version_id: id(5), version: 1, selector, content_hash: sha } } };
  x.receipts.push(receipt); return receipt;
}
test('v2 choice declarations retain unpulled select, reject, and none independently of catalog pairs', () => {
  const x = fixture(); x.usages = []; x.receipts = [];
  addChoice(x); addChoice(x, 'reject', 51, 3); addChoice(x, 'none', 52, 4);
  const out = report(x);
  assert.equal(out.schema, 'deepsonar.capability-evidence-report/v2');
  assert.equal(out.denominators.choice_declarations, 3);
  for (const key of ['selected', 'rejected', 'none']) assert.equal(out.denominators[key], 1);
  assert.ok(out.choices.every(c => c.pulls.length === 0 && c.observed_execution === 'unknown'));
  assert.equal(out.choices[2].selector, undefined);
  assert.equal(out.records.filter(r => r.kind === 'project_skill').length, 1);
});
test('event order keeps repeated choices distinct while shared pull identity never implies causality', () => {
  const x = fixture(); addChoice(x, 'select', 51, 5); addChoice(x, 'select', 50, 2);
  const out = report(x);
  assert.deepEqual(out.choices.map(c => c.event_seq), [2, 5]);
  assert.ok(out.choices.every(c => c.pulls[0].usage_ref === id(6)));
  assert.equal(out.denominators.pulled_usages, 1);
  assert.ok(out.choices.every(c => c.pull_association === 'same_identity_only_order_and_causality_unknown'));
  assert.deepEqual(out.choices[0].pulls[0].feedback_receipt_refs, [id(7)]);
});
test('stale catalog, missing policy proof or changed candidate version never associates a pull', () => {
  for (const change of [r => { r.catalog_hash = 'd'.repeat(64); }, r => { r.policy_version = null; },
    r => { r.candidate.version_id = id(99); }, r => { r.candidate = null; }]) {
    const x = fixture(); change(addChoice(x).result);
    const c = report(x).choices[0]; assert.equal(c.evidence_status, 'unknown'); assert.deepEqual(c.pulls, []);
  }
  const x = fixture(), c = addChoice(x); x.attempts.push({ id: id(55), job_id: id(2) }); c.attempt_id = id(55);
  assert.deepEqual(report(x).choices[0].pulls, []);
});
test('foreign, revoked, item tombstone and mismatched choice hashes are filtered before choice denominators', () => {
  for (const change of [x => { x.versions[0].revoked_at = x.captured_at; }, x => { x.versions[0].item_status = 'revoked'; },
    x => { x.receipts.at(-1).result.content_hash = 'f'.repeat(64); }, x => { x.receipts.at(-1).project_id = id(999); }]) {
    const x = fixture(); addChoice(x); change(x); assert.equal(report(x).denominators.choice_declarations, 0);
  }
});
test('missing event provenance is not counted and duplicate same-Job event sequence fails closed', () => {
  for (const change of [r => { r.event_id = null; }, r => { r.event_seq = null; }, r => { r.event_seq = 0; }, r => { r.event_seq = 1.1; }]) {
    const x = fixture(); change(addChoice(x)); assert.deepEqual(report(x).choices, []);
  }
  const x = fixture(); addChoice(x); const second = addChoice(x, 'none', 51, 2);
  x.attempts.push({ id: id(55), job_id: id(2) }); second.attempt_id = id(55);
  assert.throws(() => report(x), /DUPLICATE_CHOICE_SEQUENCE/);
});
test('v1 is rejected; no free text or complete suggestion propagates into report', () => {
  const x = fixture(); addChoice(x).result.target = { secret: 'SECRET' }; addChoice(x, 'none', 51, 3).result.reason = 'SECRET';
  assert.doesNotMatch(JSON.stringify(report(x)), /SECRET|untrusted title/);
  x.schema = 'deepsonar.capability-evidence-export/v1'; assert.throws(() => report(x), /INVALID_EXPORT/);
});
test('event order is Job-wide across feedback and choices; missing feedback events cannot establish linkage', () => {
  const x = fixture(); addChoice(x, 'select', 50, 1);
  assert.throws(() => report(x), /DUPLICATE_CHOICE_SEQUENCE/);
  const y = fixture(); addChoice(y); y.receipts[0].event_id = null;
  assert.deepEqual(report(y).choices[0].pulls[0].feedback_receipt_refs, []);
  y.versions[0].item_status = null;
  assert.equal(report(y).denominators.choice_declarations, 0);
});
