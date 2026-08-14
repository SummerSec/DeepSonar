import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { sql } from "../../db.js";
import { canTransition as coreCanTransition } from "../../core.js";
import {
  createJobLifecycleApplication,
  createSqlJobLifecycleApplication,
  type JobTransitionRequest,
} from "./application.js";
import { registerProvisionCancellation } from "../job-attempt/index.js";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATUSES,
  allowedSourcesForTarget,
  canTransition,
  isKnownJobStatus,
  isTerminalJobStatus,
} from "./transition-policy.js";

const architectureDoc = readFileSync(
  new URL("../../../../../docs/ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md", import.meta.url),
  "utf8",
);

const expectedTransitions: Record<string, readonly string[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"],
  failed: ["pending"],
  timeout: ["pending"],
  orphan: ["pending"],
  succeeded: [],
  cancelled: [],
};

test("Job lifecycle policy exposes the complete legal/illegal transition matrix", () => {
  assert.deepEqual(JOB_STATUSES, Object.keys(expectedTransitions));
  assert.deepEqual(JOB_TRANSITIONS, expectedTransitions);

  const matrixStatuses: readonly string[] = [...JOB_STATUSES, "unknown"];
  for (const from of matrixStatuses) {
    for (const to of matrixStatuses) {
      const expected = expectedTransitions[from]?.includes(to) ?? false;
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }

  assert.equal(canTransition("pending", "PENDING"), false);
  assert.equal(isKnownJobStatus("running"), true);
  assert.equal(isKnownJobStatus("future_status"), false);
  assert.equal(coreCanTransition("running", "succeeded"), true, "core facade delegates to policy");
});

test("target source guards are deterministic and reject unknown targets", () => {
  assert.deepEqual(allowedSourcesForTarget("pending"), ["waiting_human", "failed", "timeout", "orphan"]);
  assert.deepEqual(allowedSourcesForTarget("cancelled"), ["pending", "claimed", "provisioning", "running", "waiting_human"]);
  assert.deepEqual(allowedSourcesForTarget("succeeded"), ["running"]);
  assert.deepEqual(allowedSourcesForTarget("unknown"), []);
});

test("terminal statuses have no outgoing transitions", () => {
  for (const status of TERMINAL_JOB_STATUSES) {
    assert.equal(isTerminalJobStatus(status), true);
    for (const target of JOB_STATUSES) assert.equal(canTransition(status, target), false);
  }
  assert.equal(isTerminalJobStatus("running"), false);
});

test("application seam passes policy-approved guards and patch to one atomic executor", async () => {
  const calls: JobTransitionRequest[] = [];
  const app = createJobLifecycleApplication(async (request) => {
    calls.push(request);
    return { id: request.jobId, status: request.to };
  });

  const patch = { started_at: new Date("2026-08-04T00:00:00.000Z") };
  const result = await app.transitionJob("job-1", "running", patch);
  assert.deepEqual(result, { id: "job-1", status: "running" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    jobId: "job-1",
    to: "running",
    allowedFrom: ["provisioning"],
    patch,
  });
});

test("patch.status cannot override the target and never reaches persistence", async () => {
  let calls = 0;
  const app = createJobLifecycleApplication(async () => {
    calls += 1;
    return { id: "unexpected", status: "succeeded" };
  });

  await assert.rejects(
    () => app.transitionJob("job-status-patch", "running", { status: "succeeded" }),
    /patch must not include status/,
  );
  assert.equal(calls, 0);
});

test("unknown targets fail before persistence and stale terminal events are idempotent", async () => {
  const calls: JobTransitionRequest[] = [];
  let status = "running";
  const app = createJobLifecycleApplication(async (request) => {
    calls.push(request);
    if (!request.allowedFrom.includes(status as (typeof JOB_STATUSES)[number])) return null;
    status = request.to;
    return { id: request.jobId, status };
  });

  await assert.rejects(() => app.transitionJob("job-2", "not-a-status"), /非法目标状态/);
  assert.equal(calls.length, 0, "invalid target must not issue SQL");

  assert.deepEqual(await app.transitionJob("job-2", "succeeded"), { id: "job-2", status: "succeeded" });
  assert.equal(status, "succeeded");
  assert.equal(await app.transitionJob("job-2", "succeeded"), null, "duplicate terminal event is a no-op");
  assert.equal(await app.transitionJob("job-2", "failed"), null, "late failure cannot overwrite success");
  assert.equal(status, "succeeded");
  assert.deepEqual(calls.map(({ to, allowedFrom }) => ({ to, allowedFrom })), [
    { to: "succeeded", allowedFrom: ["running"] },
    { to: "succeeded", allowedFrom: ["running"] },
    { to: "failed", allowedFrom: ["claimed", "provisioning", "running", "waiting_human"] },
  ]);
});

test("application seam exposes explicit recovery and bulk ports without bypassing callers", async () => {
  const calls: string[] = [];
  const app = createJobLifecycleApplication({
    transitionJob: async (request) => ({ id: request.jobId, status: request.to }),
    claimPendingJob: async (id) => {
      calls.push(`claim:${id}`);
      return { id, status: "claimed" };
    },
    failExecution: async (id, error) => {
      calls.push(`fail:${id}:${error}`);
      return { id, status: "failed", error };
    },
    reapExecutionTimeout: async () => {
      calls.push("reap-timeout");
      return [{ id: "timeout" }];
    },
    reapProvisionTimeout: async (seconds) => {
      calls.push(`reap-provision:${seconds}`);
      return [{ id: "provision" }];
    },
    reapLeaseOrphans: async () => {
      calls.push("reap-orphan");
      return [{ id: "orphan" }];
    },
    reconcileProvisioning: async () => {
      calls.push("reconcile-provision");
      return { requeued: [{ id: "reset" }], orphaned: [] };
    },
    reconcileRunning: async () => {
      calls.push("reconcile-running");
      return [{ id: "orphan" }];
    },
    cancelJob: async (id, error) => {
      calls.push(`cancel:${id}:${error}`);
      return { id, status: "cancelled" };
    },
    cancelJobsOnCanvas: async (id, error, preserve) => {
      calls.push(`canvas-cancel:${id}:${error}:${String(preserve)}`);
      return [{ id: "canvas-job" }];
    },
    cancelJobsForRuntimeImageVersion: async (id, error) => {
      calls.push(`image-cancel:${id}:${error}`);
      return [{ id: "image-job" }];
    },
  });

  assert.equal((await app.claimPendingJob("claim"))?.status, "claimed");
  assert.equal((await app.failExecution("fail", "boom"))?.status, "failed");
  assert.deepEqual(await app.reapExecutionTimeout(), [{ id: "timeout" }]);
  assert.deepEqual(await app.reapProvisionTimeout(7), [{ id: "provision" }]);
  assert.deepEqual(await app.reapLeaseOrphans(), [{ id: "orphan" }]);
  assert.deepEqual(await app.reconcileProvisioning(), { requeued: [{ id: "reset" }], orphaned: [] });
  assert.deepEqual(await app.reconcileRunning(), [{ id: "orphan" }]);
  assert.equal((await app.cancelJob("cancel", "reason"))?.status, "cancelled");
  assert.deepEqual(await app.cancelJobsOnCanvas("canvas", "reason", true), [{ id: "canvas-job" }]);
  assert.deepEqual(await app.cancelJobsForRuntimeImageVersion("image", "revoked"), [{ id: "image-job" }]);
  assert.deepEqual(calls, [
    "claim:claim",
    "fail:fail:boom",
    "reap-timeout",
    "reap-provision:7",
    "reap-orphan",
    "reconcile-provision",
    "reconcile-running",
    "cancel:cancel:reason",
    "canvas-cancel:canvas:reason:true",
    "image-cancel:image:revoked",
  ]);
});

test("Reaper provision 超时先提交终态，再等待所有 provision 中止句柄完成", async () => {
  const calls: string[] = [];
  let releaseCancel!: () => void;
  const cancelDone = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const unregister = registerProvisionCancellation("job-provision-timeout", {
    attemptId: "attempt-provision-timeout",
    abortController: new AbortController(),
    cancelProvision: async () => {
      calls.push("cancel-start");
      await cancelDone;
      calls.push("cancel-done");
    },
  });
  const db = Object.assign(
    ((strings: TemplateStringsArray) => {
      const query = strings.join(" ").replace(/\s+/gu, " ").trim();
      if (query.includes("UPDATE jobs SET status = 'failed'")) {
        calls.push("terminal-committed");
        return [{ id: "job-provision-timeout", sandbox_id: null }];
      }
      // 本测试只验证生命周期顺序，不需要构造活动 Attempt；生产适配器仍会
      // 对返回的超时行调用终态收口。
      return [];
    }) as unknown as typeof sql,
    { json: (value: unknown) => value },
  );
  try {
    const app = createSqlJobLifecycleApplication(db);
    const reap = app.reapProvisionTimeout(1);
    for (let attempt = 0; attempt < 20 && !calls.includes("cancel-start"); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls, ["terminal-committed", "cancel-start"]);
    let returned = false;
    void reap.then(() => { returned = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    releaseCancel();
    assert.deepEqual(await reap, [{ id: "job-provision-timeout", sandbox_id: null }]);
    assert.deepEqual(calls, ["terminal-committed", "cancel-start", "cancel-done"]);
  } finally {
    releaseCancel();
    unregister();
  }
});

test("lock-order contract keeps Canvas-aware event ingress out of Job-first transactions", () => {
  assert.match(architectureDoc, /Event ingress \(Job-only\).*job-only side effects.*commit/s);
  assert.match(architectureDoc, /never acquire Canvas under an already-held Job lock/i);
  assert.match(architectureDoc, /Canvas-aware target.*commit/s);
  assert.match(architectureDoc, /append and semantic effects are one atomic transaction/);
  assert.match(architectureDoc, /Event-ingestion second slice/);
  assert.doesNotMatch(architectureDoc, /ingestEvent.*applySideEffects.*migration\s+debt/s);
  assert.match(architectureDoc, /rejects a `patch\.status` property/);
});
