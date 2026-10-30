import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceReport, sourceDigest } from './report.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64);
function fixture() {
  const entry = { item_id: id(4), owner_project_id: id(1), version_id: id(5), version: 1,
    kind: 'skill', hash: sha, title: 'untrusted title' };
  return { schema: 'deepsonar.capability-evidence-export/v1', captured_at: '2026-10-29T00:00:00Z', project_id: id(1),
    jobs: [{ id: id(2), project_id: id(1), status: 'succeeded',
      project_knowledge_catalog: { entries: [entry], hash: sourceDigest([entry]) },
      capability_pack: { id: 'task.audit', version: '1', digest: `sha256:${sha}` } }],
    attempts: [{ id: id(3), job_id: id(2) }],
    versions: [{ id: id(5), project_id: id(1), item_id: id(4), version: 1, content_sha256: sha, revoked_at: null }],
    usages: [{ id: id(6), project_id: id(1), job_id: id(2), attempt_id: id(3), owner_project_id: id(1),
      version_id: id(5), selector: `project:${id(4)}@1`, content_sha256: sha,
      feedback_json: { outcome: 'success', reason: 'secret', evidence_refs: [{ ref: 'untrusted-secret' }] } }],
    receipts: [{ id: id(7), project_id: id(1), job_id: id(2), attempt_id: id(3),
      operation: 'record_knowledge_feedback', state: 'settled', result_json: { usage_ref: id(6), work_ref: id(8) } }] };
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
  x.usages.push({ ...x.usages[0], id: id(22), project_id: id(21), feedback_json: { outcome: 'failure' } });
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
