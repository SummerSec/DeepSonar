/** Offline research preparation only. No database, network, model, or execution adapter. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isFinite(value) && value > 0;
const arms = ['without', 'baseline', 'candidate'];
const kinds = ['target', 'negative_trigger', 'missing_input', 'environment_change'];

// Research-side deterministic assertion; does not certify output provenance or execute a trial.
export function checkOracle(fixture, actual) {
  if (fixture.oracle?.type !== 'exact_json') throw new Error('independent_oracle');
  return isDeepStrictEqual(fixture.oracle.expected, actual);
}

export function prepareStudy(protocol, fixtures, locks = null) {
  const errors = [];
  const check = (condition, code) => { if (!condition) errors.push(code); };
  check(protocol.schema === 'deepsonar.knowledge-study/v1', 'protocol_schema');
  check(Number.isSafeInteger(protocol.repeats) && protocol.repeats >= 2 && protocol.repeats <= 20, 'repeats');
  check(protocol.fixture_digest === digest(fixtures), 'fixture_digest');
  check(protocol.thresholds?.max_quality_regression === 0 && protocol.thresholds?.max_safety_failures === 0,
    'quality_and_safety_hard_gates');
  check(Number.isSafeInteger(protocol.thresholds?.minimum_pairs) && protocol.thresholds.minimum_pairs >= 2,
    'minimum_pairs');
  check(protocol.thresholds?.frozen_before_holdout === true, 'threshold_preregistration');
  check(Array.isArray(fixtures) && fixtures.length > 0 && fixtures.length <= 100, 'case_count');
  if (!Array.isArray(fixtures)) throw new Error('case_count');
  const ids = new Set(), families = new Map();
  for (const item of fixtures) {
    check(typeof item.id === 'string' && !ids.has(item.id), 'duplicate_or_missing_case'); ids.add(item.id);
    check(['debug', 'holdout'].includes(item.split), 'split');
    check(typeof item.family === 'string' && item.family.length > 0, 'family');
    const previous = families.get(item.family);
    check(!previous || previous === item.split, 'family_leakage'); families.set(item.family, item.split);
    check(kinds.includes(item.kind), 'case_kind');
    check(typeof item.asset_version === 'string' && item.asset_version.length > 0, 'asset_version');
    check(typeof item.input === 'string' && item.input.length > 0, 'case_input');
    check(item.oracle?.type === 'exact_json' && Object.hasOwn(item.oracle, 'expected'), 'independent_oracle');
  }
  for (const split of ['debug', 'holdout']) {
    for (const kind of kinds) check(fixtures.some(x => x.split === split && x.kind === kind), `missing_${split}_${kind}`);
  }
  // Missing deployment/model locks are a readiness result; malformed protocol never yields a report.
  if (errors.length) throw new Error([...new Set(errors)].join(', '));
  const blockers = [];
  const requireLock = (condition, code) => { if (!condition) blockers.push(code); };
  requireLock(locks?.isolated === true, 'isolated_environment_unverified');
  for (const key of ['runtime_digest', 'governance_hash', 'candidate_hash', 'baseline_hash', 'model_config_hash'])
    requireLock(hash(locks?.[key]), `missing_${key}`);
  requireLock(typeof locks?.model === 'string' && locks.model.trim().length > 0, 'missing_exact_model');
  requireLock(positive(locks?.max_usd) && locks.provider_hard_limit_usd === locks.max_usd, 'provider_hard_limit_unverified');
  requireLock(positive(locks?.reserve_usd_per_request) && Number.isSafeInteger(locks?.max_requests)
    && locks.max_requests > 0 && locks.max_requests * locks.reserve_usd_per_request <= locks.max_usd, 'request_cost_bound');
  requireLock(positive(locks?.max_seconds), 'missing_time_limit');
  requireLock(locks?.isolation_review_ref?.length > 0, 'answer_and_workspace_isolation_unverified');
  const rows = [];
  for (const [index, item] of fixtures.entries()) for (let repeat = 0; repeat < protocol.repeats; repeat++) {
    const offset = (index + repeat) % arms.length;
    for (let order = 0; order < arms.length; order++) rows.push({
      case_id: item.id, family: item.family, split: item.split, kind: item.kind,
      asset_version: item.asset_version, input_digest: digest(item.input), oracle_digest: digest(item.oracle),
      repeat, order, arm: arms[(order + offset) % arms.length], status: 'not_run',
      job_ref: null, attempt_ref: null, session_ref: null, work_ref: null, receipt_refs: [], evidence_refs: [],
      independent_quality: null, incorrect_conclusions: null, critical_omissions: null,
      evidence_complete: null, invalid_trigger_detected: null, version_failure_detected: null,
      exploration_calls: null, input_tokens: null, output_tokens: null, wall_seconds: null,
      repair_rounds: null, human_diagnosis_minutes: null, billed_usd: null, failure_type: null,
    });
  }
  return {
    schema: 'deepsonar.knowledge-study-report/v1', protocol_digest: digest(protocol), fixture_digest: digest(fixtures),
    locks_digest: locks ? digest(locks) : null, status: 'prepared_not_executed', blockers,
    paid_calls_performed: false, actual_execution_verified: false,
    lifecycle: { task_a: null, activation: null, task_b_usage: null, feedback: null, same_identity_revision: null,
      status: 'pending_real_model_and_execution_evidence' },
    recovery: 'reconcile_receipt_and_effect; never_replay_unknown',
    planned_trials: rows.length, observed_trials: 0, independent_quality_denominator: 0,
    benefit_conclusion: 'insufficient_evidence', rows,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  console.log(JSON.stringify(prepareStudy(read(process.argv[2]), read(process.argv[3]),
    process.argv[4] ? read(process.argv[4]) : null), null, 2));
}
