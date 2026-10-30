import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, contentHash, digest, seal } from './contract.mjs';
import { fixture } from './fixture.mjs';
import { preflight } from './preflight.mjs';

const run = input => preflight(input, contentHash(input));
const reseal = (x, field) => { x[field] = seal(x[field].body); };
const reason = (x, code, status = 'unknown') => { const r = run(x); assert.equal(r.status, status); assert.deepEqual(r.reasons, [code]); return r; };

test('synthetic equality supports only frozen offline compatibility; author claims remain separate', () => {
  const x = fixture(), before = structuredClone(x), r = run(x);
  assert.equal(r.status, 'compatible'); assert.equal(r.mode, 'synthetic');
  assert.equal(r.author_declaration.trust, 'author_claim_not_observed_fact');
  assert.equal(r.observation.status, 'equal'); assert.equal(r.observation.provenance, 'operator_supplied_not_authenticated');
  assert.equal(r.effectiveness, 'not_evaluated'); assert.equal(r.recommendation, null);
  assert.equal(r.live_authorization, 'not_checked'); assert.deepEqual(run(x), r); assert.deepEqual(x, before);
});
test('runtime export label never authenticates producer identity', () => {
  const x = fixture(); x.mode = 'runtime_export';
  assert.equal(run(x).observation.provenance, 'operator_supplied_not_authenticated');
});
test('missing snapshot, revocation view, attempt, input, budget or declaration fails closed', () => {
  for (const field of ['job', 'authorization', 'attempt', 'input', 'token_budget', 'time_budget', 'declaration']) {
    const x = fixture(); delete x[field]; assert.equal(run(x).status, 'unknown', field);
  }
  const x = fixture(); delete x.authorization.body.entries[0].revoked_at; reason(x, 'MISSING_INPUT');
});
test('schema rejects unknown fields, including nested and prototype names', () => {
  for (const path of [[], ['job', 'body'], ['declaration', 'body'], ['assertion', 'body'], ['skill', 'candidate']]) {
    const x = fixture(); let value = x; for (const p of path) value = value[p];
    value.extra = 'injection'; reason(x, 'UNKNOWN_FIELD');
    delete value.extra; Object.defineProperty(value, '__proto__', { value: 'injection', enumerable: true }); reason(x, 'UNKNOWN_FIELD');
  }
});
test('versioned contracts and actual types are mandatory; no string booleans or unknown mode', () => {
  const x = fixture(); x.declaration.body.requires_network = 'false'; reason(x, 'INVALID_CONTRACT');
  x.declaration.body.requires_network = false; x.declaration.body.schema = 'future/v2'; reason(x, 'INVALID_CONTRACT');
  x.declaration.body.schema = 'deepsonar.skill-applicability-declaration/v1'; x.mode = 'production'; reason(x, 'INVALID_CONTRACT');
});
test('target input type/version, runtime, tools, network and budget mismatch reject rather than rank', () => {
  const cases = [
    ['input_kind', 'wrong', 'INPUT_KIND_MISMATCH'], ['target_versions', ['v2'], 'TARGET_VERSION_MISMATCH'],
    ['runtime_digests', [`sha256:${'b'.repeat(64)}`], 'RUNTIME_MISMATCH'],
    ['required_tools', ['unknown_tool'], 'TOOLS_MISSING'], ['requires_network', true, 'NETWORK_DENIED'],
    ['minimum_tokens', 1001, 'BUDGET_INSUFFICIENT'], ['minimum_seconds', 61, 'BUDGET_INSUFFICIENT'],
  ];
  for (const [field, value, code] of cases) {
    const x = fixture(); x.declaration.body[field] = value; reseal(x, 'declaration'); reason(x, code, 'incompatible');
  }
});
test('budget uses remaining scoped tokens; unknown quota is not unlimited', () => {
  const x = fixture(); x.token_budget.used_tokens = 995; reason(x, 'BUDGET_INSUFFICIENT', 'incompatible');
  x.token_budget.max_tokens = null; reason(x, 'BUDGET_UNKNOWN');
  x.token_budget.max_tokens = 10; reason(x, 'BUDGET_UNKNOWN');
  x.token_budget.job_id = x.skill.creator_job_id; reason(x, 'BUDGET_SCOPE_MISMATCH');
});
test('time budget uses observed elapsed time; missing/future/stale observations fail closed', () => {
  let x = fixture(); x.time_budget.started_at = '2026-10-28T23:58:59.000Z'; reason(x, 'BUDGET_INSUFFICIENT', 'incompatible');
  x = fixture(); x.time_budget.started_at = null; reason(x, 'BUDGET_UNKNOWN');
  x = fixture(); x.time_budget.started_at = '2026-10-29T00:00:01.000Z'; reason(x, 'BUDGET_UNKNOWN');
  for (const field of ['time_budget', 'token_budget']) {
    x = fixture(); x[field].captured_at = '2026-10-28T00:00:00.000Z'; reason(x, 'BUDGET_SNAPSHOT_MISMATCH');
  }
});
test('revocation and missing frozen entry reject; an old or unbound authorization view is unknown', () => {
  let x = fixture(); x.authorization.body.entries[0].revoked_at = x.captured_at; reseal(x, 'authorization'); reason(x, 'REVOKED', 'incompatible');
  x = fixture(); x.job.body.agent_snapshot_json.project_knowledge_catalog.entries = [];
  x.job.body.agent_snapshot_json.project_knowledge_catalog.hash = contentHash([]); reseal(x, 'job');
  x.authorization.body.job_projection_sha256 = x.job.sha256; reseal(x, 'authorization'); reason(x, 'NOT_AUTHORIZED', 'incompatible');
  x = fixture(); x.authorization.body.captured_at = '2026-10-28T00:00:00.000Z'; reseal(x, 'authorization'); reason(x, 'AUTHORIZATION_SNAPSHOT_MISMATCH');
});
test('foreign project records expose no IDs, hashes, names or field-specific reasons', () => {
  for (const field of ['job', 'authorization', 'declaration', 'assertion', 'skill']) {
    const x = fixture(); (field === 'skill' ? x.skill : x[field].body).project_id = x.skill.creator_job_id;
    const r = reason(x, 'SCOPE_DENIED', 'incompatible');
    assert.doesNotMatch(JSON.stringify(r), /00000000|sha256|ascii|declaration|source_digest/);
  }
});
test('catalog integrity, exact version and ambiguous identities are checked', () => {
  let x = fixture(); x.job.body.agent_snapshot_json.project_knowledge_catalog.hash = 'b'.repeat(64); reseal(x, 'job'); reason(x, 'CATALOG_DIGEST_MISMATCH');
  x = fixture(); x.skill.version = 2; reason(x, 'NOT_AUTHORIZED', 'incompatible');
  x = fixture(); x.authorization.body.entries.push(x.authorization.body.entries[0]); reseal(x, 'authorization'); reason(x, 'AMBIGUOUS_IDENTITY');
});
test('real mixed catalog keeps its original complete hash; unrelated Memory and foreign grants are not disclosed', () => {
  const x = fixture(), entries = x.job.body.agent_snapshot_json.project_knowledge_catalog.entries;
  const base = entries[0];
  entries.push({ ...base, item_id: x.skill.creator_job_id, version_id: x.skill.creator_attempt_id, kind: 'memory', title: 'private-memory' });
  entries.push({ ...base, item_id: x.assertion.body.oracle_job_id, owner_project_id: x.assertion.body.trial_job_id,
    version_id: x.assertion.body.oracle_attempt_id, grant_id: x.assertion.body.asset_id, title: 'foreign-secret' });
  entries.push({ ...entries[2], version_id: x.assertion.body.trial_attempt_id, version: 2, grant_id: x.assertion.body.oracle_asset_id });
  x.authorization.body.entries.push({ ...x.authorization.body.entries[0], id: x.skill.creator_attempt_id, version: 2 });
  x.job.body.agent_snapshot_json.project_knowledge_catalog.hash = contentHash(entries); reseal(x, 'job');
  x.authorization.body.job_projection_sha256 = x.job.sha256; reseal(x, 'authorization');
  const before = structuredClone(x), r = run(x);
  assert.equal(r.status, 'compatible'); assert.deepEqual(x, before);
  assert.doesNotMatch(JSON.stringify(r), /private-memory|foreign-secret|00000000/);
});
test('full KnowledgeCandidate hash catches file and metadata tampering', () => {
  for (const change of [x => x.skill.candidate.files['SKILL.md'] += ' changed', x => x.skill.candidate.title += ' changed']) {
    const x = fixture(); change(x); reason(x, 'SKILL_DIGEST_MISMATCH');
  }
  const x = fixture(); x.skill.candidate.files['../escape'] = 'bad'; reason(x, 'INVALID_CONTRACT');
});
test('input and every sidecar digest are checked; expected envelope digest detects concurrent update', () => {
  const x = fixture(), expected = contentHash(x); x.declaration.body.minimum_tokens++;
  assert.equal(preflight(x, expected).reasons[0], 'SOURCE_DIGEST_MISMATCH');
  for (const [field, code] of [['job', 'JOB'], ['authorization', 'AUTHORIZATION'], ['declaration', 'DECLARATION'], ['assertion', 'ASSERTION']]) {
    const y = fixture(); y[field].sha256 = 'b'.repeat(64); reason(y, `${code}_DIGEST_MISMATCH`);
  }
  const y = fixture(); y.input.json = '{}'; reason(y, 'INPUT_DIGEST_MISMATCH');
});
test('a declaration, pass claim, or absent result can never replace an assertion', () => {
  const x = fixture(); delete x.assertion; reason(x, 'MISSING_ASSERTION');
  x.assertion = fixture().assertion; x.assertion.body.outcome = 'pass'; reason(x, 'UNKNOWN_FIELD');
  delete x.assertion.body.outcome; x.assertion.body.state = 'unknown'; reseal(x, 'assertion'); reason(x, 'ASSERTION_UNOBSERVED');
});
test('assertion must match exact consumer Attempt, skill, input and runtime', () => {
  for (const field of ['consumer_job_id', 'consumer_attempt_id', 'skill_content_sha256', 'input_sha256', 'runtime_digest']) {
    const x = fixture(); x.assertion.body[field] = field.endsWith('_id') ? x.skill.creator_job_id : field === 'runtime_digest' ? `sha256:${'b'.repeat(64)}` : 'b'.repeat(64);
    reseal(x, 'assertion'); reason(x, 'ASSERTION_CONTEXT_MISMATCH');
  }
});
test('trial/oracle/maker/consumer Jobs, Attempts and oracle/actual assets must be independent', () => {
  for (const [field, other] of [['trial_job_id', 'consumer_job_id'], ['oracle_job_id', 'trial_job_id'], ['trial_attempt_id', 'consumer_attempt_id'], ['asset_id', 'oracle_asset_id']]) {
    const x = fixture(); x.assertion.body[field] = x.assertion.body[other]; reseal(x, 'assertion'); reason(x, 'ASSERTION_NOT_INDEPENDENT');
  }
});
test('unknown external effects require reconciliation, not a claimed pass or retry', () => {
  const x = fixture(); x.assertion.body.effect = 'unknown'; reseal(x, 'assertion'); reason(x, 'UNKNOWN_EFFECT_RECONCILE_ONLY');
});
test('objective expected/actual difference is incompatible even when all author constraints match', () => {
  const x = fixture(); x.assertion.body.actual_json = canonical({ label: 'wrong' });
  x.assertion.body.actual_sha256 = digest(x.assertion.body.actual_json); reseal(x, 'assertion');
  const r = reason(x, 'ASSERTION_MISMATCH', 'incompatible');
  assert.equal(r.author_declaration.status, 'matches'); assert.equal(r.observation.status, 'different');
});
test('asset bytes must match hashes; malformed or ambiguous JSON is unknown', () => {
  let x = fixture(); x.assertion.body.actual_json = '{}'; reseal(x, 'assertion'); reason(x, 'ASSERTION_BYTES_MISMATCH');
  for (const [bytes, code] of [['not json', 'INVALID_ASSERTION_JSON'], ['{"a":1,"a":1}', 'NONCANONICAL_ASSERTION_JSON']]) {
    x = fixture(); x.assertion.body.actual_json = bytes; x.assertion.body.actual_sha256 = digest(bytes); reseal(x, 'assertion'); reason(x, code);
  }
});
