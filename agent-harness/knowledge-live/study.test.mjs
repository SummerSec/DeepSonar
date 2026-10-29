import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareStudy, digest, checkOracle } from './study.mjs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const fixtures = read('./study-fixtures.json'), protocol = read('./study-protocol.json');
test('offline preparation preserves every arm and never asserts real acceptance', () => {
  const report = prepareStudy(protocol, fixtures);
  assert.equal(report.rows.length, 216);
  assert.equal(report.independent_quality_denominator, 0);
  assert.equal(report.benefit_conclusion, 'insufficient_evidence');
  assert.equal(report.actual_execution_verified, false);
  assert.ok(report.blockers.includes('provider_hard_limit_unverified'));
  assert.ok(report.rows.every(row => row.status === 'not_run' && row.independent_quality === null));
  assert.equal(report.lifecycle.status, 'pending_real_model_and_execution_evidence');
  for (const arm of ['without', 'baseline', 'candidate']) for (const order of [0, 1, 2])
    assert.equal(report.rows.filter(row => row.arm === arm && row.order === order).length, 24);
  assert.deepEqual(report, prepareStudy(protocol, fixtures));
});
test('tampering and family leakage fail closed before producing any report', () => {
  const changed = structuredClone(fixtures); changed[0].input = 'changed';
  assert.throws(() => prepareStudy(protocol, changed), /fixture_digest/);
  changed.find(row => row.split === 'holdout').family = changed[0].family;
  assert.throws(() => prepareStudy({ ...protocol, fixture_digest: digest(changed) }, changed), /family_leakage/);
});
test('missing negative cases, duplicate cases and absent independent oracle are rejected', () => {
  for (const mutate of [rows => rows.splice(0, rows.length, ...rows.filter(x => x.kind !== 'missing_input')),
    rows => { rows[1].id = rows[0].id; }, rows => { rows[0].oracle = { type: 'model_self_score', expected: 1 }; }]) {
    const rows = structuredClone(fixtures); mutate(rows);
    assert.throws(() => prepareStudy({ ...protocol, fixture_digest: digest(rows) }, rows));
  }
});
test('cost cannot compensate quality gates and thresholds must be frozen', () => {
  assert.throws(() => prepareStudy({ ...protocol, thresholds: { ...protocol.thresholds, max_quality_regression: 1 } }, fixtures));
  assert.throws(() => prepareStudy({ ...protocol, thresholds: { ...protocol.thresholds, frozen_before_holdout: false } }, fixtures));
});
test('complete declarative locks are still preparation, not runtime authorization', () => {
  const locks = { isolated: true, model: 'test-only-model', max_usd: 5, provider_hard_limit_usd: 5,
    reserve_usd_per_request: 1, max_requests: 5, max_seconds: 3600, isolation_review_ref: 'operator-review' };
  for (const key of ['runtime_digest', 'governance_hash', 'candidate_hash', 'baseline_hash', 'model_config_hash']) locks[key] = 'a'.repeat(64);
  assert.deepEqual(prepareStudy(protocol, fixtures, locks).blockers, []);
  assert.equal(prepareStudy(protocol, fixtures, locks).status, 'prepared_not_executed');
  assert.ok(prepareStudy(protocol, fixtures, { ...locks, max_requests: 6 }).blockers.includes('request_cost_bound'));
});

test('independent JSON oracle rejects plausible extra claims and incorrect conclusions', () => {
  for (const fixture of fixtures) {
    assert.equal(checkOracle(fixture, structuredClone(fixture.oracle.expected)), true);
    assert.equal(checkOracle(fixture, { ...fixture.oracle.expected, unsupported_claim: true }), false);
    assert.equal(checkOracle(fixture, null), false);
  }
});
