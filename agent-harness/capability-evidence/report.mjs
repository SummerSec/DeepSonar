/** Read-only audit projection. Never a catalog, permission decision or effectiveness evaluator. */
import { createHash } from 'node:crypto';
import { readBoundedInput } from './bounded-input.mjs';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (condition, code) => { if (!condition) throw new Error(code); };
export const sourceDigest = input => hash(canonical(input));

export function buildEvidenceReport(input, expectedDigest) {
  check(sha(expectedDigest) && sourceDigest(input) === expectedDigest, 'SOURCE_DIGEST_MISMATCH');
  check(input.schema === 'deepsonar.capability-evidence-export/v1' && uuid(input.project_id)
    && Number.isFinite(Date.parse(input.captured_at)), 'INVALID_EXPORT');
  for (const table of ['jobs', 'attempts', 'versions', 'usages', 'receipts']) {
    check(Array.isArray(input[table]) && input[table].length <= 10000, 'EXPORT_LIMIT');
    const ids = new Set();
    for (const row of input[table]) {
      check(uuid(row.id) && !ids.has(row.id), 'DUPLICATE_OR_INVALID_ID'); ids.add(row.id);
    }
  }
  const jobs = input.jobs.filter(j => j.project_id === input.project_id);
  const records = [];
  for (const job of jobs.sort((a, b) => a.id.localeCompare(b.id))) {
    const entries = job.project_knowledge_catalog?.entries ?? [];
    check(Array.isArray(entries) && entries.length <= 1000, 'INVALID_CATALOG');
    if (job.project_knowledge_catalog) check(
      hash(canonical(entries)) === job.project_knowledge_catalog.hash, 'CATALOG_DIGEST_MISMATCH');
    // Cross-project grants authorize bytes, not disclosure of source outcomes or sample counts.
    const local = entries.filter(e => e.kind === 'skill' && e.owner_project_id === input.project_id
      && input.versions.some(v => v.id === e.version_id && v.project_id === input.project_id
        && v.item_id === e.item_id && v.version === e.version && v.content_sha256 === e.hash && v.revoked_at === null));
    for (const entry of local) {
      check(sha(entry.hash) && uuid(entry.item_id) && uuid(entry.version_id), 'INVALID_IDENTITY');
      const selector = `project:${entry.item_id}@${entry.version}`;
      const usages = input.usages.filter(u => u.project_id === input.project_id && u.job_id === job.id
        && u.owner_project_id === input.project_id && u.version_id === entry.version_id
        && u.selector === selector && u.content_sha256 === entry.hash
        && input.attempts.some(a => a.id === u.attempt_id && a.job_id === job.id));
      const seen = new Set();
      for (const usage of usages) {
        check(!seen.has(usage.attempt_id), 'DUPLICATE_PULL'); seen.add(usage.attempt_id);
      }
      const receipts = input.receipts.filter(r => r.project_id === input.project_id && r.job_id === job.id
        && r.operation === 'record_knowledge_feedback' && r.state === 'settled'
        && usages.some(u => u.id === r.result_json?.usage_ref && u.attempt_id === r.attempt_id));
      records.push({ job_id: job.id, kind: 'project_skill', selector, version_id: entry.version_id,
        content_hash: entry.hash, catalog_member: true, exposure: 'unknown', selection_reason: 'unknown',
        pulls: usages.map(u => ({ usage_ref: u.id, attempt_id: u.attempt_id,
          declared_outcome: ['success', 'failure', 'inapplicable'].includes(u.feedback_json?.outcome)
            ? u.feedback_json.outcome : null,
          feedback_receipt_refs: receipts.filter(r => r.result_json.usage_ref === u.id).map(r => r.id).sort(),
          declared_evidence_count: Array.isArray(u.feedback_json?.evidence_refs) ? u.feedback_json.evidence_refs.length : 0,
        })).sort((a, b) => a.usage_ref.localeCompare(b.usage_ref)),
        job_succeeded: job.status === 'succeeded', observed_execution: 'unknown', independent_quality: 'unknown',
        attribution: 'none', failure_class: 'unclassified',
      });
    }
    const pack = job.capability_pack;
    if (pack) {
      check(typeof pack.id === 'string' && /^[a-z][a-z0-9_.-]{2,159}$/.test(pack.id)
        && typeof pack.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(pack.version)
        && /^sha256:[a-f0-9]{64}$/.test(pack.digest), 'INVALID_PACK_IDENTITY');
      records.push({ job_id: job.id, kind: 'configured_pack', id: pack.id, version: pack.version,
        digest: pack.digest, selection: 'frozen_configuration', selection_reason: 'unknown',
        job_succeeded: job.status === 'succeeded', observed_execution: 'unknown', independent_quality: 'unknown',
        attribution: 'combination_only_no_causal_claim' });
    }
  }
  records.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const skills = records.filter(r => r.kind === 'project_skill');
  return { schema: 'deepsonar.capability-evidence-report/v1', mode: 'offline_audit_not_recommendation',
    source_digest: expectedDigest, captured_at: input.captured_at, project_id: input.project_id,
    denominators: { local_skill_job_pairs: skills.length, pulled_pairs: skills.filter(r => r.pulls.length).length,
      feedback_declared_pairs: skills.filter(r => r.pulls.some(p => p.declared_outcome)).length,
      configured_pack_jobs: records.filter(r => r.kind === 'configured_pack').length,
      independently_verified_pairs: 0 },
    independent_quality_rate: null, cost_attribution: 'unavailable', recommendation: null,
    gaps: ['catalog_membership_is_not_exposure', 'pull_is_not_execution', 'feedback_is_a_declaration',
      'job_success_is_not_quality', 'independent_truth_not_linked', 'global_skills_not_covered',
      'cross_project_effects_not_disclosed', 'selection_bias_and_missing_failures_unmeasured',
      'historical_export_cannot_authorize_current_reads'], records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bytes = readBoundedInput(process.argv[2]);
    console.log(JSON.stringify(buildEvidenceReport(JSON.parse(bytes), process.argv[3]), null, 2));
  } catch { console.error('CAPABILITY_EVIDENCE_REPORT_REJECTED'); process.exitCode = 1; }
}
