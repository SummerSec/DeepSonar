import { createHash } from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const fail = code => { throw new Error(code); };
export function canonical(value, depth = 0) {
  if (depth > 24) fail('INPUT_LIMIT');
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(',')}}`;
  if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) fail('INVALID_CONTRACT');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('INVALID_CONTRACT');
  return JSON.stringify(value);
}
export const contentHash = value => digest(canonical(value));
export const seal = body => ({ sha256: contentHash(body), body });

const string = v => typeof v === 'string' && v.length > 0 && v.length <= 240;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const runtime = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const boolean = v => typeof v === 'boolean';
const positive = v => Number.isSafeInteger(v) && v > 0;
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
const literal = x => v => v === x;
const strings = v => Array.isArray(v) && v.length <= 64 && v.every(string) && new Set(v).size === v.length;
const nonemptyStrings = v => strings(v) && v.length > 0;
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Unknown fields are rejected at every structured level; missing data is never a default. */
export function shape(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONTRACT');
  if (Object.keys(value).some(k => !Object.hasOwn(fields, k))) fail('UNKNOWN_FIELD');
  for (const [k, validate] of Object.entries(fields)) {
    if (!(k in value)) { if (optional.includes(k)) continue; fail('MISSING_INPUT'); }
    if (!validate(value[k])) fail('INVALID_CONTRACT');
  }
  return true;
}
const keywords = v => Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 80);
const identity = v => shape(v, { item_id: uuid, owner_project_id: uuid, version_id: uuid, version: positive,
  kind: v => ['memory', 'skill'].includes(v), hash, title: string, logical_key: string, keywords, grant_id: uuid }, ['grant_id']);
const list = validator => v => Array.isArray(v) && v.length <= 1000 && v.every(validator);
const candidate = v => shape(v, {
  kind: literal('skill'), logical_key: v => typeof v === 'string' && v.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(v),
  title: v => typeof v === 'string' && v.length > 0 && v.length <= 200, keywords,
  files: files => {
    if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
    const entries = Object.entries(files);
    return typeof files['SKILL.md'] === 'string' && Boolean(files['SKILL.md'].trim()) && entries.length <= 20
      && entries.every(([p, text]) => (p === 'SKILL.md' || /^references\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:md|txt|json|yaml|yml|csv)$/.test(p))
        && typeof text === 'string')
      && entries.reduce((n, [p, text]) => n + Buffer.byteLength(p) + Buffer.byteLength(text), 0) <= 131072;
  },
});
const wrapped = validator => v => shape(v, { sha256: hash, body: validator });
const jsonBytes = v => v === null || (typeof v === 'string' && Buffer.byteLength(v) <= 65536);
export function validate(input) {
  shape(input, {
    schema: literal('deepsonar.skill-applicability-input/v1'),
    mode: v => ['synthetic', 'runtime_export'].includes(v), project_id: uuid, captured_at: time,
    job: wrapped(v => shape(v, {
      id: uuid, project_id: uuid, timeout_sec: positive,
      agent_snapshot_json: v => shape(v, {
        runtime_image: v => shape(v, { image_digest: runtime }), platform_tools: strings,
        network_policy: v => shape(v, { allow_egress: boolean }),
        project_knowledge_catalog: v => shape(v, { entries: list(identity), hash }),
      }),
    })),
    attempt: v => shape(v, { id: uuid, job_id: uuid }),
    input: v => shape(v, { kind: string, target_version: string, sha256: hash, json: v => typeof v === 'string' && Buffer.byteLength(v) <= 65536 }),
    time_budget: v => shape(v, { job_id: uuid, captured_at: time, started_at: v => v === null || time(v) }),
    token_budget: v => shape(v, { job_id: uuid, captured_at: time, max_tokens: v => v === null || nonnegative(v), used_tokens: nonnegative }),
    skill: v => shape(v, {
      project_id: uuid, item_id: uuid, version_id: uuid, version: positive,
      creator_job_id: uuid, creator_attempt_id: uuid, content_sha256: hash, candidate,
    }),
    authorization: wrapped(v => shape(v, {
      project_id: uuid, job_id: uuid, job_projection_sha256: hash, captured_at: time,
      entries: list(v => shape(v, { id: uuid, project_id: uuid, item_id: uuid, version: positive, content_sha256: hash, revoked_at: v => v === null || time(v) })),
    })),
    declaration: wrapped(v => shape(v, {
      schema: literal('deepsonar.skill-applicability-declaration/v1'), project_id: uuid, skill_content_sha256: hash,
      input_kind: string, target_versions: nonemptyStrings,
      runtime_digests: v => nonemptyStrings(v) && v.every(runtime), required_tools: strings,
      requires_network: boolean, minimum_tokens: positive, minimum_seconds: positive,
    })),
    assertion: wrapped(v => shape(v, {
      schema: literal('deepsonar.json-equality-assertion/v1'), project_id: uuid, skill_content_sha256: hash,
      consumer_job_id: uuid, consumer_attempt_id: uuid, trial_job_id: uuid, trial_attempt_id: uuid,
      oracle_job_id: uuid, oracle_attempt_id: uuid, runtime_digest: runtime, input_sha256: hash,
      asset_id: uuid, oracle_asset_id: uuid, expected_sha256: hash, actual_sha256: v => v === null || hash(v),
      expected_json: jsonBytes, actual_json: jsonBytes,
      state: v => ['observed', 'unknown'].includes(v), effect: v => ['settled', 'unknown'].includes(v),
    })),
  }, ['job', 'attempt', 'input', 'token_budget', 'time_budget', 'skill', 'authorization', 'declaration', 'assertion']);
}
