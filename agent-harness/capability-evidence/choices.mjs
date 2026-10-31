/** Choice history is an event-ordered declaration, never execution or causal attribution. */
export function projectChoices(input, records, { sha, uuid, check }) {
  const output = [], sequences = new Set();
  const feedbackRefs = new Set(records.flatMap(r => (r.pulls ?? []).flatMap(p => p.feedback_receipt_refs)));
  for (const receipt of input.receipts.filter(r => feedbackRefs.has(r.id))) {
    const sequence = `${receipt.job_id}:${receipt.event_seq}`;
    check(!sequences.has(sequence), 'DUPLICATE_CHOICE_SEQUENCE'); sequences.add(sequence);
  }
  for (const receipt of input.receipts) {
    if (receipt.project_id !== input.project_id || receipt.operation !== 'record_skill_choice' || receipt.state !== 'settled') continue;
    const job = input.jobs.find(j => j.id === receipt.job_id && j.project_id === input.project_id);
    if (!job || !input.attempts.some(a => a.id === receipt.attempt_id && a.job_id === job.id)) continue;
    const r = receipt.result;
    if (!r || !['select', 'reject', 'none'].includes(r.decision)) continue;
    const identity = records.find(s => s.kind === 'project_skill' && s.job_id === job.id
      && s.selector === r.selector && s.content_hash === r.content_hash);
    // A foreign/revoked identity must not influence even diagnostic counts or ordering.
    if (r.decision !== 'none' && !identity) continue;
    if (r.decision === 'none' && (r.selector !== null || r.content_hash !== null || r.candidate !== null)) continue;
    if (!uuid(receipt.event_id) || !Number.isSafeInteger(receipt.event_seq) || receipt.event_seq <= 0) continue;
    const sequence = `${job.id}:${receipt.event_seq}`;
    check(!sequences.has(sequence), 'DUPLICATE_CHOICE_SEQUENCE'); sequences.add(sequence);
    const exact = r.candidate && identity && r.candidate.selector === identity.selector
      && r.candidate.content_hash === identity.content_hash && r.candidate.version_id === identity.version_id
      && r.candidate.version === Number(identity.selector.split('@').at(-1));
    const metadata = r.policy_version === 'deepsonar.skill-suggestions/v1' && sha(r.context_hash)
      && sha(r.catalog_hash) && r.catalog_hash === job.project_knowledge_catalog?.hash;
    const linked = Boolean(metadata && exact);
    output.push({ receipt_ref: receipt.id, job_id: job.id, attempt_id: receipt.attempt_id,
      event_id: receipt.event_id, event_seq: receipt.event_seq, decision: r.decision,
      ...(identity ? { selector: identity.selector, content_hash: identity.content_hash, version_id: identity.version_id } : {}),
      policy_version: r.policy_version === 'deepsonar.skill-suggestions/v1' ? r.policy_version : null,
      context_hash: sha(r.context_hash) ? r.context_hash : null, catalog_hash: sha(r.catalog_hash) ? r.catalog_hash : null,
      reason_present: typeof r.reason_present === 'boolean' ? r.reason_present : null,
      evidence_status: metadata && (r.decision === 'none' || exact) ? 'bound_declaration' : 'unknown',
      pulls: linked ? identity.pulls.filter(p => p.attempt_id === receipt.attempt_id).map(p => ({
        usage_ref: p.usage_ref, feedback_receipt_refs: p.feedback_receipt_refs,
      })) : [],
      pull_association: linked ? 'same_identity_only_order_and_causality_unknown' : 'unknown',
      exposure: 'unknown', observed_execution: 'unknown', independent_quality: 'unknown', attribution: 'none' });
  }
  return output.sort((a, b) => a.job_id.localeCompare(b.job_id) || a.event_seq - b.event_seq || a.receipt_ref.localeCompare(b.receipt_ref));
}
