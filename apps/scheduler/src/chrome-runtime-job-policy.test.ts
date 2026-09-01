import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertChromeRuntimeEgressAllowed,
  freezeAgentSnapshotNetworkPolicy,
  frozenCanvasAllowEgress,
  requireFrozenSnapshotAllowEgress,
} from "./domains/role-runtime-snapshot/index.js";
import {
  CHROME_JOB_STALL_SEC,
  resolveJobStallSec,
} from "./domains/job-lifecycle/stall-policy.js";

const coreSource = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
const projectTaskSource = readFileSync(new URL("./domains/project-task/routes.ts", import.meta.url), "utf8");
const reportSource = readFileSync(new URL("./report.ts", import.meta.url), "utf8");
const verifySource = readFileSync(new URL("./verify.ts", import.meta.url), "utf8");
const eventSideEffectsSource = readFileSync(new URL("./domains/event-ingestion/side-effects.ts", import.meta.url), "utf8");
const hubSource = readFileSync(new URL("./domains/hub-orchestration/application.ts", import.meta.url), "utf8");
const transferImportSource = readFileSync(new URL("./transfer/import.ts", import.meta.url), "utf8");
const dispatcherSource = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
const executorSource = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
const rerunSource = readFileSync(new URL("./domains/job-control/rerun.ts", import.meta.url), "utf8");

test("Chrome runtime policy accepts egress, rejects false, and leaves non-Chrome unchanged", () => {
  for (const imageKey of ["deepsonar-chrome-audit", "deepsonar-chrome-test", "deepsonar-chrome-fuzz"]) {
    assert.doesNotThrow(() => assertChromeRuntimeEgressAllowed(imageKey, true));
    assert.throws(() => assertChromeRuntimeEgressAllowed(imageKey, false), /allow_egress=true/);
  }
  assert.doesNotThrow(() => assertChromeRuntimeEgressAllowed("deepsonar-audit", false));
  assert.throws(
    () => assertChromeRuntimeEgressAllowed("deepsonar-chrome-test", false),
    /Chrome runtime deepsonar-chrome-test requires canvas network_policy\.allow_egress=true/,
  );
  assert.equal(frozenCanvasAllowEgress({ network_policy: { allow_egress: true } }), true);
  assert.equal(frozenCanvasAllowEgress({ network_policy: { allow_egress: false } }), false);
  assert.equal(frozenCanvasAllowEgress({ network_policy: { allow_egress: "true" } }), undefined);
});

test("Job creation freezes the canvas policy and ignores payload policy", async () => {
  let target: Record<string, unknown> = { network_policy: { allow_egress: false } };
  const db = ((strings: TemplateStringsArray) => {
    assert.match(strings[0] ?? "", /SELECT target_json FROM canvases/);
    return Promise.resolve([{ target_json: target }]);
  }) as never;
  const snapshot = await freezeAgentSnapshotNetworkPolicy(db, "canvas-1", {
    runtime_image: { image_key: "deepsonar-audit" },
    payload_network_policy: { allow_egress: true },
  });
  assert.equal(snapshot.network_policy.allow_egress, false);
  target = { network_policy: { allow_egress: true } };
  assert.equal(requireFrozenSnapshotAllowEgress(snapshot), false, "later canvas changes cannot alter a Job snapshot");
  const chromeDb = ((strings: TemplateStringsArray) => {
    assert.match(strings[0] ?? "", /SELECT target_json FROM canvases/);
    return Promise.resolve([{ target_json: { network_policy: { allow_egress: false } } }]);
  }) as never;
  await assert.rejects(
    () => freezeAgentSnapshotNetworkPolicy(
      chromeDb,
      "canvas-1",
      { runtime_image: { image_key: "deepsonar-chrome-test" } },
    ),
    /Chrome runtime deepsonar-chrome-test requires canvas network_policy\.allow_egress=true/,
  );
});

test("malformed canvas policy and missing Job snapshot fail closed", async () => {
  const malformed = ((strings: TemplateStringsArray) => {
    assert.match(strings[0] ?? "", /SELECT target_json FROM canvases/);
    return Promise.resolve([{ target_json: { network_policy: { allow_egress: "true" } } }]);
  }) as never;
  await assert.rejects(
    () => freezeAgentSnapshotNetworkPolicy(malformed, "canvas-1", { runtime_image: { image_key: "deepsonar-audit" } }),
    /缺少合法的 network_policy\.allow_egress/,
  );
  await assert.rejects(
    () => freezeAgentSnapshotNetworkPolicy(malformed, null, { runtime_image: { image_key: "deepsonar-audit" } }),
    /缺少 canvas_id/,
  );
  assert.throws(() => requireFrozenSnapshotAllowEgress({}), /缺少冻结的 network_policy\.allow_egress/);
  assert.throws(() => requireFrozenSnapshotAllowEgress(null, "job-1"), /job job-1 缺少冻结/);
});

test("normal createJob validates the frozen canvas policy before insertion", () => {
  const createJob = coreSource.slice(coreSource.indexOf("export async function createJob"));
  const guard = createJob.indexOf("freezeAgentSnapshotNetworkPolicy");
  const insert = createJob.indexOf("INSERT INTO jobs");
  assert.ok(guard >= 0, "createJob must use the shared snapshot policy freezer");
  assert.ok(insert > guard, "createJob must validate before inserting the Job");
  assert.match(createJob.slice(0, insert), /resolveAgentSnapshotForJob/);
  assert.match(createJob.slice(0, insert), /freezeAgentSnapshotNetworkPolicy[\s\S]*input\.canvasId/);
  const localGate = createJob.indexOf("assertFrozenRuntimeImageLocal");
  assert.ok(localGate >= 0 && localGate < insert, "createJob must inspect the frozen digest before INSERT");
});

test("resume-session Hub force-wake and retry map unresolvable snapshots to SNAPSHOT_STALE", () => {
  const resume = projectTaskSource.slice(projectTaskSource.indexOf('app.post("/tasks/:canvasId/resume-session"'));
  const wake = resume.slice(resume.indexOf("无可恢复 Job"));
  assert.match(wake, /maybeTriggerHub/);
  assert.match(wake, /isSnapshotUnresolvableError/);
  assert.match(wake, /currentSnapshotUnresolvableBody/);
  const retry = projectTaskSource.slice(projectTaskSource.indexOf('app.post("/tasks/:canvasId/retry"'));
  assert.match(retry, /isSnapshotUnresolvableError/);
  assert.match(retry, /currentSnapshotUnresolvableBody/);
});

test("retry validates the locked canvas policy before destructive reset and insertion", () => {
  const retry = projectTaskSource.slice(projectTaskSource.indexOf('app.post("/tasks/:canvasId/retry"'));
  const guard = retry.indexOf("freezeAgentSnapshotNetworkPolicy");
  const wipe = retry.indexOf("await wipeCanvasRuntimeData");
  const insert = retry.indexOf("INSERT INTO jobs");
  assert.ok(guard >= 0, "retry must use the shared snapshot policy freezer");
  assert.ok(wipe > guard, "retry must validate before wiping canvas runtime data");
  assert.ok(insert > guard, "retry must validate before inserting the Hub Job");
  assert.match(retry.slice(0, guard), /SELECT id, status, target_json FROM canvases/);
  assert.match(retry.slice(0, insert), /resolveAgentSnapshotForJob/);
  const localGate = retry.indexOf("assertFrozenRuntimeImageLocal");
  assert.ok(localGate >= 0 && localGate < wipe, "retry must inspect the frozen digest before wiping the canvas");
});

test("all direct Job creation paths freeze policy before INSERT", () => {
  const paths = [
    ["finding report", reportSource.slice(reportSource.indexOf("export async function maybeDispatchFindingReport"))],
    ["task report", reportSource.slice(reportSource.indexOf("export async function maybeDispatchReport"))],
    ["verify", verifySource.slice(verifySource.indexOf("export async function createVerifyRound"))],
    ["event follow-up", eventSideEffectsSource.slice(eventSideEffectsSource.indexOf("async function applySideEffects"))],
    ["Hub", hubSource.slice(hubSource.indexOf("async function maybeTriggerHub"))],
    ["transfer history import", transferImportSource.slice(transferImportSource.indexOf("// jobs 阶段 1"))],
  ] as const;
  for (const [name, source] of paths) {
    const freeze = source.indexOf("freezeAgentSnapshotNetworkPolicy");
    const insert = source.indexOf("INSERT INTO jobs");
    assert.ok(freeze >= 0, `${name} must freeze network policy`);
    assert.ok(insert > freeze, `${name} must freeze before inserting a Job`);
    if (name === "transfer history import") continue;
    const localGate = source.indexOf("assertFrozenRuntimeImageLocal");
    assert.ok(localGate >= 0 && localGate < insert, `${name} must inspect the frozen digest before INSERT`);
  }
});

test("Chrome runtimes raise stall floors without changing the global 900s default", () => {
  assert.equal(resolveJobStallSec("deepsonar-audit", 900), 900);
  assert.equal(resolveJobStallSec("deepsonar-chrome-audit", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-test", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-test"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-fuzz", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
  assert.ok(CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"] > 900);
  assert.ok(CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"] > CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"]);
});

test("human task create inspects the hub snapshot before opening a canvas", () => {
  const createTask = projectTaskSource.slice(projectTaskSource.indexOf('app.post("/projects/:id/tasks"'));
  const resolve = createTask.indexOf("resolveAgentSnapshotForJob");
  const inspect = createTask.indexOf("assertFrozenRuntimeImageLocal");
  const canvas = createTask.indexOf("ensureCanvasForTask");
  assert.ok(resolve >= 0 && inspect > resolve && canvas > inspect, "POST /tasks must inspect before ensureCanvasForTask");
});

test("resume inspects the snapshot that will run, not a later catalog digest", () => {
  const resume = rerunSource.slice(rerunSource.indexOf("export async function requeueJob"));
  const stale = resume.indexOf('mode === "resume-frozen" && staleFields.length > 0');
  const inspect = resume.indexOf("assertFrozenRuntimeImageLocal");
  const transition = resume.indexOf("transitionJob");
  assert.ok(stale >= 0 && inspect > stale && transition > inspect);
  assert.match(resume.slice(inspect, inspect + 400), /mode === "rerun-current" \? currentSnapshot : job\.agent_snapshot_json/);
});

test("Dispatcher and real executor provision from the frozen snapshot only", () => {
  assert.match(dispatcherSource, /requireFrozenSnapshotAllowEgress\(snapshot, jobId\)/);
  assert.match(dispatcherSource, /const allowEgress = useReal && snapshotAllowEgress/);
  assert.doesNotMatch(dispatcherSource, /networkPolicy\.allow_egress/);
  assert.match(executorSource, /requireFrozenSnapshotAllowEgress\(snapshot, jobId\)/);
  assert.match(executorSource, /env\.DEEPSONAR_ALLOW_EGRESS = allowEgress \? "1" : "0"/);
  assert.doesNotMatch(executorSource, /networkPolicy\.allow_egress/);
});

test("real executor maps tool.call boundaries into stall-visible activity", () => {
  assert.match(executorSource, /recordToolCallActivity/);
  assert.match(executorSource, /toolCallActivityPatch/);
  assert.match(executorSource, /toolCallProgressMessage/);
  const started = executorSource.indexOf('if (type === "tool.call.started")');
  const completed = executorSource.indexOf('} else if (type === "tool.call.completed")');
  const startedRecord = executorSource.indexOf('recordToolCallActivity("started"', started);
  const completedRecord = executorSource.indexOf('recordToolCallActivity("completed"', completed);
  assert.ok(started >= 0 && startedRecord > started && startedRecord < completed);
  assert.ok(completed > started && completedRecord > completed);
});
