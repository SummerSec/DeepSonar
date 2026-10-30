/** Synthetic engineering fixture only. No Job, runtime admission or real model is claimed. */
import { pathToFileURL } from 'node:url';
import { canonical, contentHash, digest, seal } from './contract.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function fixture() {
  // Oracle: the manually specified expected result for ASCII whitespace normalization.
  // Actual: an independently expressed local JS implementation; never a canned "pass" result.
  const value = { label: ' A\tB ' };
  const expected = canonical({ label: 'A B' });
  const actual = canonical({ label: value.label.trim().replace(/[ \t\r\n]+/g, ' ') });
  const candidate = { kind: 'skill', logical_key: 'ascii-label', title: 'ASCII label normalization',
    keywords: ['ascii'], files: { 'SKILL.md': '# ASCII labels\nTrim and collapse ASCII whitespace. Unicode is outside this fixture.\n' } };
  const skillHash = contentHash(candidate), runtime = `sha256:${digest('synthetic runtime; not an admitted image')}`;
  const entry = { item_id: id(4), owner_project_id: id(1), version_id: id(5), version: 1,
    kind: 'skill', hash: skillHash, title: candidate.title, logical_key: candidate.logical_key, keywords: candidate.keywords };
  const job = seal({ id: id(2), project_id: id(1), timeout_sec: 60,
    agent_snapshot_json: { runtime_image: { image_digest: runtime }, platform_tools: ['emit_fact'],
      network_policy: { allow_egress: false },
      project_knowledge_catalog: { entries: [entry], hash: contentHash([entry]) } } });
  return { schema: 'deepsonar.skill-applicability-input/v1', mode: 'synthetic', project_id: id(1),
    captured_at: '2026-10-29T00:00:00.000Z', job, attempt: { id: id(3), job_id: id(2) },
    input: { kind: 'json-label', target_version: 'ascii-v1', sha256: contentHash(value), json: canonical(value) },
    time_budget: { job_id: id(2), captured_at: '2026-10-29T00:00:00.000Z', started_at: '2026-10-28T23:59:59.000Z' },
    token_budget: { job_id: id(2), captured_at: '2026-10-29T00:00:00.000Z', max_tokens: 1000, used_tokens: 0 },
    skill: { project_id: id(1), item_id: id(4), version_id: id(5), version: 1,
      creator_job_id: id(6), creator_attempt_id: id(7), content_sha256: skillHash, candidate },
    authorization: seal({ project_id: id(1), job_id: id(2), job_projection_sha256: job.sha256,
      captured_at: '2026-10-29T00:00:00.000Z', entries: [{ id: id(5), project_id: id(1), item_id: id(4),
        version: 1, content_sha256: skillHash, revoked_at: null }] }),
    declaration: seal({ schema: 'deepsonar.skill-applicability-declaration/v1', project_id: id(1),
      skill_content_sha256: skillHash, input_kind: 'json-label', target_versions: ['ascii-v1'],
      runtime_digests: [runtime], required_tools: ['emit_fact'], requires_network: false, minimum_tokens: 10, minimum_seconds: 2 }),
    assertion: seal({ schema: 'deepsonar.json-equality-assertion/v1', project_id: id(1), skill_content_sha256: skillHash,
      consumer_job_id: id(2), consumer_attempt_id: id(3), trial_job_id: id(8), trial_attempt_id: id(9),
      oracle_job_id: id(10), oracle_attempt_id: id(11), asset_id: id(12), oracle_asset_id: id(13),
      runtime_digest: runtime, input_sha256: contentHash(value), expected_sha256: digest(expected), actual_sha256: digest(actual),
      expected_json: expected, actual_json: actual, state: 'observed', effect: 'settled' }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = fixture();
  console.log(process.argv.includes('--digest') ? contentHash(input) : JSON.stringify(input, null, 2));
}
