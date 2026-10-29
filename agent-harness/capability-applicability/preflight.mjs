/** Pure offline evidence comparison. No network, execution, ranking, cache or database writes. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonical, contentHash, digest, fail, validate } from './contract.mjs';

const result = (status, reasons, details = {}) => ({
  schema: 'deepsonar.skill-applicability-report/v1', status, reasons,
  meaning: 'frozen_offline_constraints_and_assertion_only', recommendation: null,
  effectiveness: 'not_evaluated', live_authorization: 'not_checked', ...details,
});
const exact = (entry, skill) => entry.item_id === skill.item_id && entry.version_id === skill.version_id
  && entry.version === skill.version && entry.hash === skill.content_sha256;
const verify = (value, code) => { if (contentHash(value.body) !== value.sha256) fail(code); };

export function preflight(input, expectedSourceDigest) {
  try {
    if (Buffer.byteLength(canonical(input)) > 1048576) fail('INPUT_LIMIT');
    validate(input);
    if (!/^[a-f0-9]{64}$/.test(expectedSourceDigest ?? '') || contentHash(input) !== expectedSourceDigest)
      fail('SOURCE_DIGEST_MISMATCH');
    // Foreign records never expose identities, hashes, names or per-field explanations.
    for (const section of ['job', 'authorization', 'declaration', 'assertion']) {
      if (input[section] && input[section].body.project_id !== input.project_id)
        return result('incompatible', ['SCOPE_DENIED']);
    }
    if (input.skill && input.skill.project_id !== input.project_id) return result('incompatible', ['SCOPE_DENIED']);
    if (!input.job || !input.attempt || !input.skill || !input.authorization) fail('MISSING_AUTHORIZATION_INPUT');
    const j = input.job.body, s = input.skill, a = input.authorization.body;
    const snapshot = j.agent_snapshot_json, catalog = snapshot.project_knowledge_catalog;
    if (input.attempt.job_id !== j.id) fail('ATTEMPT_SCOPE_MISMATCH');
    verify(input.job, 'JOB_DIGEST_MISMATCH'); verify(input.authorization, 'AUTHORIZATION_DIGEST_MISMATCH');
    if (contentHash(s.candidate) !== s.content_sha256) fail('SKILL_DIGEST_MISMATCH');
    if (contentHash(catalog.entries) !== catalog.hash) fail('CATALOG_DIGEST_MISMATCH');
    if (a.job_id !== j.id || a.job_projection_sha256 !== input.job.sha256 || a.captured_at !== input.captured_at)
      fail('AUTHORIZATION_SNAPSHOT_MISMATCH');
    const frozenMatches = catalog.entries.filter(e => e.kind === 'skill' && e.owner_project_id === input.project_id && exact(e, s));
    const currentMatches = a.entries.filter(e => e.project_id === input.project_id && e.id === s.version_id);
    if (frozenMatches.length > 1 || currentMatches.length > 1) fail('AMBIGUOUS_IDENTITY');
    const frozen = frozenMatches[0];
    const current = currentMatches.find(e => exact({ ...e, version_id: e.id, hash: e.content_sha256 }, s));
    if (!frozen || !current) return result('incompatible', ['NOT_AUTHORIZED']);
    if (current.revoked_at !== null) return result('incompatible', ['REVOKED']);
    if (!input.declaration) fail('MISSING_DECLARATION');
    verify(input.declaration, 'DECLARATION_DIGEST_MISMATCH');
    const d = input.declaration.body;
    if (d.skill_content_sha256 !== s.content_sha256) fail('DECLARATION_SKILL_MISMATCH');
    if (!input.input || !input.token_budget || !input.time_budget) fail('MISSING_TARGET_OR_BUDGET');
    if (digest(input.input.json) !== input.input.sha256) fail('INPUT_DIGEST_MISMATCH');
    let parsedInput;
    try { parsedInput = canonical(JSON.parse(input.input.json)); } catch { fail('INVALID_INPUT_JSON'); }
    if (parsedInput !== input.input.json) fail('INVALID_INPUT_JSON');
    if (input.token_budget.job_id !== j.id || input.time_budget.job_id !== j.id) fail('BUDGET_SCOPE_MISMATCH');
    if (input.token_budget.max_tokens === null || input.token_budget.used_tokens > input.token_budget.max_tokens) fail('BUDGET_UNKNOWN');
    if (input.token_budget.captured_at !== input.captured_at || input.time_budget.captured_at !== input.captured_at) fail('BUDGET_SNAPSHOT_MISMATCH');
    if (input.time_budget.started_at === null || Date.parse(input.time_budget.started_at) > Date.parse(input.captured_at)) fail('BUDGET_UNKNOWN');
    const remainingSeconds = j.timeout_sec - (Date.parse(input.captured_at) - Date.parse(input.time_budget.started_at)) / 1000;
    const reasons = [];
    if (d.input_kind !== input.input.kind) reasons.push('INPUT_KIND_MISMATCH');
    if (!d.target_versions.includes(input.input.target_version)) reasons.push('TARGET_VERSION_MISMATCH');
    if (!d.runtime_digests.includes(snapshot.runtime_image.image_digest)) reasons.push('RUNTIME_MISMATCH');
    if (d.required_tools.some(t => !snapshot.platform_tools.includes(t))) reasons.push('TOOLS_MISSING');
    if (d.requires_network && !snapshot.network_policy.allow_egress) reasons.push('NETWORK_DENIED');
    if (d.minimum_tokens > input.token_budget.max_tokens - input.token_budget.used_tokens || d.minimum_seconds > remainingSeconds) reasons.push('BUDGET_INSUFFICIENT');
    const details = { mode: input.mode, source_digest: expectedSourceDigest,
      author_declaration: { sha256: input.declaration.sha256, status: reasons.length ? 'mismatch' : 'matches',
        trust: 'author_claim_not_observed_fact' },
      observation: { status: 'not_checked', provenance: 'operator_supplied_not_authenticated' } };
    if (reasons.length) return result('incompatible', reasons, details);
    if (!input.assertion) return result('unknown', ['MISSING_ASSERTION'], details);
    verify(input.assertion, 'ASSERTION_DIGEST_MISMATCH');
    const e = input.assertion.body;
    if (e.consumer_job_id !== j.id || e.consumer_attempt_id !== input.attempt.id
      || e.skill_content_sha256 !== s.content_sha256 || e.input_sha256 !== input.input.sha256
      || e.runtime_digest !== snapshot.runtime_image.image_digest) return result('unknown', ['ASSERTION_CONTEXT_MISMATCH'], details);
    if (e.asset_id === e.oracle_asset_id) return result('unknown', ['ASSERTION_NOT_INDEPENDENT'], details);
    if (new Set([j.id, s.creator_job_id, e.trial_job_id, e.oracle_job_id]).size !== 4
      || new Set([input.attempt.id, s.creator_attempt_id, e.trial_attempt_id, e.oracle_attempt_id]).size !== 4)
      return result('unknown', ['ASSERTION_NOT_INDEPENDENT'], details);
    if (e.effect === 'unknown') return result('unknown', ['UNKNOWN_EFFECT_RECONCILE_ONLY'], details);
    if (e.state !== 'observed' || e.expected_json === null || e.actual_json === null || e.actual_sha256 === null)
      return result('unknown', ['ASSERTION_UNOBSERVED'], details);
    if (digest(e.expected_json) !== e.expected_sha256 || digest(e.actual_json) !== e.actual_sha256)
      return result('unknown', ['ASSERTION_BYTES_MISMATCH'], details);
    let expected, actual;
    try { expected = canonical(JSON.parse(e.expected_json)); actual = canonical(JSON.parse(e.actual_json)); }
    catch { return result('unknown', ['INVALID_ASSERTION_JSON'], details); }
    // Canonical bytes reject ambiguous duplicate keys and lossy numeric representations.
    if (expected !== e.expected_json || actual !== e.actual_json)
      return result('unknown', ['NONCANONICAL_ASSERTION_JSON'], details);
    details.observation = { status: expected === actual ? 'equal' : 'different', method: 'json_structural_equality',
      assertion_sha256: input.assertion.sha256, provenance: 'operator_supplied_not_authenticated' };
    return result(expected === actual ? 'compatible' : 'incompatible',
      [expected === actual ? 'OFFLINE_MATCH' : 'ASSERTION_MISMATCH'], details);
  } catch (error) {
    const codes = new Set(['INPUT_LIMIT', 'INVALID_CONTRACT', 'UNKNOWN_FIELD', 'MISSING_INPUT', 'SOURCE_DIGEST_MISMATCH',
      'MISSING_AUTHORIZATION_INPUT', 'JOB_DIGEST_MISMATCH', 'AUTHORIZATION_DIGEST_MISMATCH', 'SKILL_DIGEST_MISMATCH',
      'AUTHORIZATION_SNAPSHOT_MISMATCH', 'AMBIGUOUS_IDENTITY', 'MISSING_DECLARATION', 'DECLARATION_DIGEST_MISMATCH',
      'DECLARATION_SKILL_MISMATCH', 'ASSERTION_DIGEST_MISMATCH', 'ATTEMPT_SCOPE_MISMATCH',
      'CATALOG_DIGEST_MISMATCH', 'MISSING_TARGET_OR_BUDGET', 'BUDGET_SCOPE_MISMATCH', 'BUDGET_UNKNOWN',
      'INPUT_DIGEST_MISMATCH', 'INVALID_INPUT_JSON', 'BUDGET_SNAPSHOT_MISMATCH']);
    return result('unknown', [codes.has(error.message) ? error.message : 'INVALID_CONTRACT']);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bytes = readFileSync(process.argv[2]);
    if (bytes.length > 1048576) fail('INPUT_LIMIT');
    const report = preflight(JSON.parse(bytes.toString('utf8')), process.argv[3]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'compatible' ? 0 : report.status === 'incompatible' ? 1 : 2;
  } catch { console.log(JSON.stringify(result('unknown', ['INPUT_UNREADABLE']))); process.exitCode = 2; }
}
