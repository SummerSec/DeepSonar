/** Opt-in real-model acceptance driver. Scheduler owns every domain mutation. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../../apps/scheduler/package.json', import.meta.url));
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const plan = {
  phases: ['seed task A', 'maker + 12 case/arm trials + evaluator + reviewer',
    'pause and restart isolated Scheduler', 'task B exact-version use and real failure feedback',
    'same identity revision + independent trials/review', 'read-only evidence assertions'],
  minimum_jobs: 32, observed_job_limit: config.maxJobs, max_model_requests: config.maxRequests,
  provider_hard_limit_usd: config.maxUsd, paid_calls_performed: false,
};
if (!process.argv.includes('--run')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.KNOWLEDGE_LIVE_APPROVED, 'yes', 'paid-run approval required');
assert.ok(process.env.KNOWLEDGE_LIVE_API_TOKEN, 'isolated management token required');
assert.ok(Number.isSafeInteger(config.maxJobs) && config.maxJobs >= 32 && config.maxJobs <= 66);
assert.ok(Number.isSafeInteger(config.maxRequests) && config.maxRequests > 0);
assert.ok(Number.isFinite(config.maxUsd) && config.maxUsd > 0 && config.providerHardLimitUsd === config.maxUsd);
assert.ok(Number.isSafeInteger(config.requestsPerJob) && config.requestsPerJob > 0);
assert.ok(Number.isFinite(config.seconds) && config.seconds > 0 && config.seconds <= 7200);
const api = new URL(config.api), relay = new URL(config.relay);
for (const url of [api, relay]) assert.equal(url.hostname, '127.0.0.1', 'isolated loopback services required');
const dbUrl = new URL(process.env.TEST_DATABASE_URL || '');
assert.equal(dbUrl.hostname, '127.0.0.1');
assert.match(dbUrl.pathname, /^\/deepsonar_knowledge_live_[a-z0-9_]+$/);
const postgres = require('postgres');
// This observer cannot insert, update or activate knowledge, evaluations, receipts or usage.
const db = postgres(dbUrl.toString(), { max: 1, connection: { default_transaction_read_only: 'on' } });
const state = existsSync(config.report) ? JSON.parse(readFileSync(config.report, 'utf8')) : {
  schema: 'deepsonar.knowledge-live-acceptance/v1', status: 'running', started_at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), model: config.model, provider: config.provider,
};
const save = () => writeFileSync(config.report, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const request = async (path, body) => {
  const response = await fetch(new URL(path, api), { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${process.env.KNOWLEDGE_LIVE_API_TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`MANAGEMENT_HTTP_${response.status}`);
  return response.json();
};
const started = Date.parse(state.started_at);
assert.ok(Number.isFinite(started), 'valid persisted start time required');
assert.equal(state.model, config.model); assert.equal(state.provider, config.provider);
async function guard() {
  const budget = await fetch(new URL('/__budget', relay)).then(r => r.json());
  assert.equal(budget.max_requests, config.maxRequests); assert.equal(budget.max_usd, config.maxUsd);
  state.budget = budget;
  if (budget.exhausted) throw new Error('LIVE_BUDGET_EXHAUSTED');
  if (Date.now() - started > config.seconds * 1000) throw new Error('LIVE_TIME_EXHAUSTED');
  const [count] = await db`SELECT count(*)::int AS n FROM jobs`;
  if (count.n > config.maxJobs) throw new Error('LIVE_JOB_BUDGET_EXHAUSTED');
  const [bad] = await db`SELECT id FROM jobs WHERE status IN ('failed','timeout','cancelled','orphan') LIMIT 1`;
  if (bad) throw new Error('LIVE_JOB_NOT_SUCCESSFUL');
  const [blocked] = await db`SELECT id FROM project_knowledge_work WHERE state IN ('blocked','cancelled') LIMIT 1`;
  if (blocked) throw new Error('LIVE_WORK_BLOCKED');
}
async function waitFor(check) {
  for (;;) { await guard(); const result = await check(); if (result) return result;
    save(); await new Promise(r => setTimeout(r, 2000)); }
}
async function launch(prompt) {
  const job = await request('/jobs', { project_id: state.project_id, type: 'analyze',
    title: 'Knowledge real-model acceptance', timeout_sec: 600, max_requests: config.requestsPerJob,
    payload: { intent: { prompt } } });
  return job.id;
}
try {
  const credentials = await db`SELECT provider,public_metadata_json FROM credentials WHERE kind='llm_provider' AND status='active'`;
  assert.ok(credentials.length > 0, 'isolated model credential must be configured');
  for (const row of credentials) {
    assert.equal(row.provider, config.provider);
    assert.equal(String(row.public_metadata_json?.base_url).replace(/\/$/, ''), config.relay.replace(/\/$/, ''),
      'every model credential must use the bounded relay');
  }
  if (!state.project_id) {
    const [projects] = await db`SELECT count(*)::int AS n FROM projects`;
    const [jobs] = await db`SELECT count(*)::int AS n FROM jobs`;
    assert.equal(projects.n, 0, 'fresh isolated project space required'); assert.equal(jobs.n, 0);
    const project = await request('/projects', { name: 'knowledge-live-fixture' });
    state.project_id = project.id; save();
    state.seed_job = await launch(`Use only this disposable fixture. Execute a small Python task that normalizes ASCII whitespace in a label.
Create actual Fact/Evidence from execution. Discover existing project knowledge, then use request_project_knowledge with exact real source refs to request one reusable Skill named label-normalization.
The initial method must explicitly cover ASCII whitespace only, not claim Unicode coverage. Preserve sources and mark_job_done. Do not submit evaluations, reviews or activate knowledge yourself.`);
    save();
  }
  const first = await waitFor(async () => {
    const rows = await db`SELECT i.id,i.active_version_id,v.content_sha256 FROM project_knowledge_items i
      JOIN project_knowledge_versions v ON v.id=i.active_version_id
      WHERE i.project_id=${state.project_id} AND i.kind='skill' AND i.status='active'`;
    const [work] = await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${state.seed_job} AND state='completed'`;
    return work && rows.length === 1 ? { ...rows[0], work_id: work.id } : null;
  });
  if (!state.first) {
    state.first = first; state.status = 'awaiting_scheduler_restart'; save();
    console.log('First activation recorded. Restart only the isolated Scheduler, then rerun with --run --resume.');
  } else {
    assert.ok(process.argv.includes('--resume'), 'explicit isolated Scheduler restart/resume required');
    if (!state.consumer_job) {
      state.consumer_job = await launch(`Find and pull the exact project Skill identity ${state.first.id}, version ${state.first.active_version_id}, hash ${state.first.content_sha256}.
Actually execute its ASCII-only method against a label containing U+00A0 nonbreaking spaces; preserve the failing result as actual Fact/Evidence.
Record record_knowledge_feedback on the actual returned usage_ref, requesting a revision of the SAME identity to cover Unicode whitespace with positive and negative cases.
Do not invent a failure, approve knowledge, write evaluations, or call request_project_knowledge to bypass usage feedback. Finish with mark_job_done.`);
      state.status = 'running_revision'; save();
    }
    await waitFor(async () => {
      const [item] = await db`SELECT active_version_id FROM project_knowledge_items WHERE id=${state.first.id}`;
      const [feedback] = await db`SELECT id FROM project_knowledge_usages WHERE job_id=${state.consumer_job}
        AND version_id=${state.first.active_version_id} AND feedback_json IS NOT NULL`;
      const [work] = await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${state.consumer_job} AND state='completed'`;
      return feedback && work && item.active_version_id !== state.first.active_version_id;
    });
    state.proposals = await db`SELECT id,work_id,state,revision,input_digest,candidate_version_id,maker_job_id
      FROM project_knowledge_proposals WHERE project_id=${state.project_id} ORDER BY created_at`;
    for (const proposal of state.proposals.filter(p => p.state === 'active')) {
      const evaluations = await db`SELECT id,kind,actor_job_id,actor_attempt_id,input_digest FROM project_knowledge_evaluations
        WHERE proposal_id=${proposal.id} AND proposal_revision=${proposal.revision}`;
      assert.ok(evaluations.some(e => e.kind === 'behavior')); assert.ok(evaluations.some(e => e.kind === 'review'));
      assert.equal(new Set([proposal.maker_job_id, ...evaluations.map(e => e.actor_job_id)]).size, evaluations.length + 1);
      assert.ok(evaluations.every(e => e.input_digest === proposal.input_digest));
    }
    state.jobs = await db`SELECT id,status,agent_snapshot_json->>'model' AS model FROM jobs ORDER BY created_at`;
    assert.ok(state.jobs.every(j => j.status === 'succeeded' && j.model === config.model));
    state.assignments = await db`SELECT job_id,work_id,proposal_id,stage,case_id,arm,input_digest FROM project_knowledge_job_assignments`;
    state.receipts = await db`SELECT id,job_id,attempt_id,operation,input_digest,state FROM project_knowledge_receipts`;
    state.usage = await db`SELECT id,job_id,attempt_id,version_id,content_sha256 FROM project_knowledge_usages`;
    state.evidence = await db`SELECT e.id,e.sha256,a.job_id FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id`;
    state.metering = await db`SELECT job_id,attempt_id,request_no,provider,model,input_tokens,output_tokens,settlement_status FROM job_usage_ledger`;
    assert.ok(state.metering.length > 0 && state.metering.every(u => u.settlement_status === 'settled'));
    state.status = 'lifecycle_passed_restart_unverified'; state.restart_verification = 'operator restart requires independent process/run evidence'; state.finished_at = new Date().toISOString(); save();
    console.log('Lifecycle evidence passed; report contains IDs and hashes, not credentials or raw model text.');
  }
} catch (error) {
  await fetch(new URL('/__stop', relay), { method: 'POST' }).catch(() => undefined);
  state.status = 'failed'; state.error_code = /^LIVE_[A-Z_]+$/.test(error.message) ? error.message : 'LIVE_ACCEPTANCE_FAILED';
  // The Provider limit/relay stops paid calls; ordinary cancellation handles existing effects.
  if (state.project_id) {
    const jobs = await db`SELECT id FROM jobs WHERE status IN ('pending','claimed','provisioning','running','waiting_human')`;
    state.cleanup_errors = [];
    for (const job of jobs) try { await request(`/jobs/${job.id}/cancel`, {}); }
    catch { state.cleanup_errors.push(job.id); }
  }
  save(); process.exitCode = 1; console.error(state.error_code);
} finally { await db.end({ timeout: 5 }); }
