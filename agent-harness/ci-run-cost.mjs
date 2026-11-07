#!/usr/bin/env node
// #992: read-only, attempt-scoped Actions cost observations. Never a cache or
// acceptance decision; missing timestamps and unfinished jobs are not zero cost.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COST_SCHEMA = "deepsonar.ci-run-cost/v1";
const STEP_GROUPS = Object.freeze({
  setup_ms: /^(?:Set up job|Initialize containers|Run (?:actions\/checkout@|pnpm\/action-setup@|actions\/setup-node@|pnpm install --frozen-lockfile)|Select PostgreSQL)/u,
  typecheck_ms: /^(?:Run pnpm -r typecheck|Workspace typecheck)$/u,
  workspace_build_ms: /^(?:Run pnpm -r build|Workspace build)$/u,
  artifact_transfer_ms: /(?:actions\/(?:upload|download)-artifact@|(?:[Uu]pload|[Dd]ownload|[Rr]estore).*artifact|^Upload Plan offline replay report$)/u,
});

function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(start, end) {
  const from = timestamp(start), to = timestamp(end);
  return from !== null && to !== null && to >= from ? to - from : null;
}

function total(values) {
  return values.every((value) => Number.isFinite(value))
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || !/^\d+$/u.test(String(value))) {
    throw new Error(`invalid ${name}`);
  }
  return Number(value);
}

function stepDuration(step) {
  if (step.conclusion === "skipped") return 0;
  return step.status === "completed" ? duration(step.started_at, step.completed_at) : null;
}

// Native failed-job reruns clone successful results with NEW job IDs and the
// NEW run_attempt, but retain their OLD execution timestamps and runner. A new
// ID is not new work. Match the previous attempt's API evidence before counting
// such a record as zero additional execution; timestamps alone are insufficient.
function retainedSource(job, previousJobs, id, attempt, attemptStart) {
  const start = timestamp(job.started_at), end = timestamp(job.completed_at), created = timestamp(job.created_at);
  if (attempt < 2 || attemptStart === null || start === null || end === null || created === null
      || start > end || end >= attemptStart || created < attemptStart || job.status !== "completed"
      || job.conclusion !== "success" || !job.runner_id || !Array.isArray(job.steps) || !job.steps.length) return null;
  const stepKey = (steps) => JSON.stringify(steps?.map(({ name, status, conclusion, started_at, completed_at }) =>
    [name, status, conclusion, started_at, completed_at]));
  return previousJobs.find((old) => old.run_id === id && old.run_attempt === attempt - 1
    && old.name === job.name && old.status === "completed" && old.conclusion === "success"
    && old.runner_id === job.runner_id && old.started_at === job.started_at && old.completed_at === job.completed_at
    && Array.isArray(old.steps) && stepKey(old.steps) === stepKey(job.steps)) ?? null;
}

export function summarizeRunCost({ run, jobs, previousJobs = [] } = {}) {
  const id = positiveInteger(run?.id, "run.id");
  const attempt = positiveInteger(run?.run_attempt, "run.run_attempt");
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("missing attempt jobs");
  const ids = new Set();
  const rows = jobs.map((job) => {
    if (job.run_id !== id || job.run_attempt !== attempt) throw new Error("job belongs to another run or attempt");
    positiveInteger(job.id, "job.id");
    if (ids.has(job.id)) throw new Error("duplicate job; do not count a retained result twice");
    ids.add(job.id);
    const skipped = job.conclusion === "skipped";
    const attemptStart = timestamp(run.run_started_at);
    const source = retainedSource(job, previousJobs, id, attempt, attemptStart);
    const outsideAttempt = attemptStart === null || timestamp(job.started_at) === null || timestamp(job.started_at) < attemptStart;
    const noExecution = skipped || source !== null;
    const runner = noExecution ? 0 : !outsideAttempt && job.status === "completed" ? duration(job.started_at, job.completed_at) : null;
    const steps = Array.isArray(job.steps) ? job.steps : null;
    const phases = Object.fromEntries(Object.entries(STEP_GROUPS).map(([name, pattern]) => [name,
      noExecution ? 0 : !outsideAttempt && steps ? total(steps.filter((step) => pattern.test(step.name)).map(stepDuration)) : null,
    ]));
    return {
      id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
      execution: skipped ? "skipped" : source ? "retained_previous_result" : outsideAttempt ? "unknown" : "this_attempt",
      retained_from_job_id: source?.id ?? null,
      labels: job.labels ?? [], created_at: job.created_at, started_at: job.started_at, completed_at: job.completed_at,
      // created_at is when Actions creates the eligible job, not workflow creation.
      // The preceding needs/evaluation interval must not be called runner queueing.
      pre_job_ms: noExecution ? 0 : duration(run.run_started_at, job.created_at),
      queue_ms: noExecution ? 0 : duration(job.created_at, job.started_at),
      runner_ms: runner, ...phases,
    };
  });
  const complete = run.status === "completed" && rows.every((job) => job.status === "completed");
  const ends = rows.filter((job) => !["skipped", "retained_previous_result"].includes(job.execution)).map((job) => timestamp(job.completed_at));
  const end = complete && ends.length && ends.every((value) => value !== null) ? new Date(Math.max(...ends)).toISOString() : null;
  return {
    schema: COST_SCHEMA,
    source: { run_id: id, attempt, head_sha: run.head_sha, event: run.event, workflow: run.path,
      head_branch: run.head_branch, run_started_at: run.run_started_at, status: run.status, conclusion: run.conclusion },
    // Actions run/jobs metadata does not prove the tested merge checkout or input equivalence.
    tested_checkout_sha: "unknown",
    complete,
    workflow_wall_ms: duration(run.run_started_at, end),
    // Do not infer a rerun's request-to-start queue from API created_at.
    initial_queue_ms: attempt === 1 ? duration(run.created_at, run.run_started_at) : null,
    queue_ms: total(rows.map((job) => job.queue_ms)),
    runner_ms: total(rows.map((job) => job.runner_ms)),
    observed_completed_runner_ms: rows.reduce((sum, job) => sum + (job.runner_ms ?? 0), 0),
    ...Object.fromEntries(Object.keys(STEP_GROUPS).map((name) => [name, total(rows.map((job) => job[name]))])),
    jobs: rows,
  };
}

/** The caller authenticates gh. Only fixed read-only Actions endpoints are used;
 * no artifacts or source code from the observed run are downloaded or executed. */
export function collectRunCost({ repository, runId, attempt, api = githubApi } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository ?? "")) throw new Error("invalid repository");
  const id = positiveInteger(runId, "run id"), number = positiveInteger(attempt, "attempt");
  const endpoint = `repos/${repository}/actions/runs/${id}/attempts/${number}`;
  const run = api(endpoint);
  if (run.id !== id || run.run_attempt !== number || run.repository?.full_name !== repository) {
    throw new Error("Actions source identity mismatch");
  }
  const loadJobs = (number) => {
    const pages = api(`repos/${repository}/actions/runs/${id}/attempts/${number}/jobs?per_page=100`, true);
    if (!Array.isArray(pages) || !pages.length || pages.some((page) => !Array.isArray(page.jobs))) {
      throw new Error("invalid paginated jobs response");
    }
    const jobs = pages.flatMap((page) => page.jobs);
    if (pages.some((page) => page.total_count !== jobs.length)) throw new Error("incomplete jobs pagination");
    return jobs;
  };
  const jobs = loadJobs(number);
  const previousJobs = number > 1 ? loadJobs(number - 1) : [];
  return { ...summarizeRunCost({ run, jobs, previousJobs }), repository,
    evidence_url: `https://github.com/${repository}/actions/runs/${id}/attempts/${number}` };
}

function githubApi(endpoint, paginate = false) {
  const args = ["api", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])];
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
}

const seconds = (value) => value === null ? "unknown" : (value / 1000).toFixed(1);
const cell = (value) => String(value ?? "unknown").replace(/[\r\n|`]/gu, " ");

export function renderRunCost(report) {
  const lines = [
    "\n## CI cost observations (#992)", "",
    `Run ${report.source.run_id}, attempt ${report.source.attempt}; head \`${cell(report.source.head_sha)}\`; ${report.complete ? "complete" : "partial (summary/current jobs still running)"}.`,
    `Workflow job-span: ${seconds(report.workflow_wall_ms)} s; runner execution: ${report.runner_ms === null
      ? `unknown (observed completed-job subtotal ${(report.observed_completed_runner_ms / 60_000).toFixed(2)} runner-minutes)`
      : `${(report.runner_ms / 60_000).toFixed(2)} runner-minutes`}.`,
    "Runner-minutes are elapsed execution, not rounded/billed minutes. Queue uses job created_at → started_at; pre-job time includes needs/evaluation, not runner queue.",
    "Missing data stays unknown. Retained results are matched against the previous attempt API before assigning zero additional cost; new job IDs alone do not prove rerunning.",
    "This is not a verified benchmark, cache hit or permission to reuse test success; the tested checkout is not inferred from head_sha.", "",
    "| Job | Result / execution | Pre-job s | Queue s | Runner s | Setup s | Typecheck s | Build s | Artifact step s |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const job of report.jobs) {
    lines.push(`| ${cell(job.name)} | ${cell(job.conclusion || job.status)} / ${cell(job.execution)} | ${[job.pre_job_ms, job.queue_ms, job.runner_ms,
      job.setup_ms, job.typecheck_ms, job.workspace_build_ms, job.artifact_transfer_ms].map(seconds).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--repository", "--run", "--attempt", "--json", "--summary"].includes(args[index]) || !args[index + 1]) {
      throw new Error("usage: ci-run-cost.mjs --repository owner/repo --run ID --attempt N [--json FILE] [--summary FILE]");
    }
    options[args[index]] = args[index + 1];
  }
  const report = collectRunCost({ repository: options["--repository"], runId: options["--run"], attempt: options["--attempt"] });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--json"]) writeFileSync(options["--json"], json);
  if (options["--summary"]) appendFileSync(options["--summary"], renderRunCost(report));
  process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`CI cost observation failed: ${error.message}`); process.exitCode = 1; }
}
