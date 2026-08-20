import assert from "node:assert/strict";
import test from "node:test";
import { CHROME_JOB_STALL_SEC } from "./domains/job-lifecycle/stall-policy.js";
import {
  envRuntimeKnobDefaults,
  freezeRuntimeKnobs,
  frozenRuntimeKnobsFromSnapshot,
  jobTokenQuotaExhausted,
  mergeRoleRuntimeKnobOverrides,
  parseRuntimeKnobOverride,
  resolveRuntimeKnobs,
} from "./runtime-knobs.js";

const env = {
  stallSec: 900,
  jobTokenMaxRequests: 500,
  auditTimeoutSec: 18_000,
  verifyTimeoutSec: 10_800,
  provisionTimeoutSec: 300,
};

test("runtime knobs follow job > role > project > platform > env", () => {
  const resolved = resolveRuntimeKnobs({
    jobType: "audit",
    env,
    platform: { stallSec: 1_200, jobTokenMaxRequests: 800, auditTimeoutSec: 20_000, provisionTimeoutSec: 400 },
    project: { stallSec: 1_500, jobTokenMaxRequests: 0 },
    role: { stallSec: 2_000 },
    job: { timeoutSec: 30_000 },
    imageKey: "deepsonar-audit",
  });
  assert.equal(resolved.stallSec, 2_000);
  assert.equal(resolved.sources.stallSec, "role");
  assert.equal(resolved.jobTokenMaxRequests, 0);
  assert.equal(resolved.sources.jobTokenMaxRequests, "project");
  assert.equal(resolved.timeoutSec, 30_000);
  assert.equal(resolved.sources.timeoutSec, "job");
  assert.equal(resolved.provisionTimeoutSec, 400);
  assert.equal(resolved.sources.provisionTimeoutSec, "platform");
});

test("verify jobs use verifyTimeoutSec until a higher layer overrides", () => {
  const platform = resolveRuntimeKnobs({ jobType: "verify_finding", env, platform: { verifyTimeoutSec: 9_000 } });
  assert.equal(platform.timeoutSec, 9_000);
  assert.equal(platform.sources.timeoutSec, "platform");
  const role = resolveRuntimeKnobs({
    jobType: "verify_finding",
    env,
    platform: { verifyTimeoutSec: 9_000 },
    role: { timeoutSec: 12_000 },
  });
  assert.equal(role.timeoutSec, 12_000);
  assert.equal(role.sources.timeoutSec, "role");
});

test("chrome-like jobs keep the image floor unless an override is higher", () => {
  const floor = resolveRuntimeKnobs({ jobType: "test", env, imageKey: "deepsonar-chrome-fuzz" });
  assert.equal(floor.stallSec, CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
  assert.equal(floor.sources.stallSec, "env");

  const raised = resolveRuntimeKnobs({
    jobType: "test",
    env,
    imageKey: "deepsonar-chrome-fuzz",
    role: { stallSec: 20_000 },
  });
  assert.equal(raised.stallSec, 20_000);
  assert.equal(raised.sources.stallSec, "role");
  assert.ok(raised.stallSec > CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
});

test("stall 0 and max_requests 0 mean unlimited / disabled", () => {
  const resolved = resolveRuntimeKnobs({
    jobType: "audit",
    env,
    platform: { stallSec: 0, jobTokenMaxRequests: 0 },
    imageKey: "deepsonar-chrome-audit",
  });
  assert.equal(resolved.stallSec, 0);
  assert.equal(resolved.jobTokenMaxRequests, 0);
  assert.equal(jobTokenQuotaExhausted(999, 0), false);
  assert.equal(jobTokenQuotaExhausted(500, 500), true);
  assert.equal(jobTokenQuotaExhausted(499, 500), false);
});

test("changing platform layer without process restart is visible to the next resolve", () => {
  const first = resolveRuntimeKnobs({ jobType: "audit", env, platform: { stallSec: 900, jobTokenMaxRequests: 500 } });
  const next = resolveRuntimeKnobs({ jobType: "audit", env, platform: { stallSec: 3_600, jobTokenMaxRequests: 0 } });
  assert.equal(first.stallSec, 900);
  assert.equal(first.jobTokenMaxRequests, 500);
  assert.equal(next.stallSec, 3_600);
  assert.equal(next.jobTokenMaxRequests, 0);
});

test("role knobs merge project over global and ignore invalid values", () => {
  assert.deepEqual(
    mergeRoleRuntimeKnobOverrides({ stallSec: 1_200, jobTokenMaxRequests: 80 }, { stallSec: 4_000 }),
    { stallSec: 4_000, jobTokenMaxRequests: 80, timeoutSec: undefined },
  );
  assert.deepEqual(parseRuntimeKnobOverride({ stallSec: -1, job_token_max_requests: 12 }), { jobTokenMaxRequests: 12 });
});

test("frozen snapshot knobs round-trip and reject partial blobs", () => {
  const frozen = freezeRuntimeKnobs(resolveRuntimeKnobs({ jobType: "audit", env, role: { stallSec: 1_800 } }));
  assert.deepEqual(frozenRuntimeKnobsFromSnapshot({ runtime_knobs: frozen }), frozen);
  assert.equal(frozenRuntimeKnobsFromSnapshot({ runtime_knobs: { stall_sec: 900 } }), null);
});

test("job timeout may be shorter than the platform 60s floor", () => {
  const resolved = resolveRuntimeKnobs({
    jobType: "audit",
    env,
    platform: { auditTimeoutSec: 18_000 },
    job: { timeoutSec: 1 },
  });
  assert.equal(resolved.timeoutSec, 1);
  assert.equal(resolved.sources.timeoutSec, "job");
});

test("project cannot override provisionTimeoutSec", () => {
  const resolved = resolveRuntimeKnobs({
    jobType: "audit",
    env,
    platform: { provisionTimeoutSec: 400 },
    project: { provisionTimeoutSec: 1_200 },
  });
  assert.equal(resolved.provisionTimeoutSec, 400);
  assert.equal(resolved.sources.provisionTimeoutSec, "platform");
});

test("env defaults stay aligned with bootstrap config", () => {
  const defaults = envRuntimeKnobDefaults();
  assert.equal(typeof defaults.stallSec, "number");
  assert.equal(typeof defaults.jobTokenMaxRequests, "number");
  assert.equal(typeof defaults.provisionTimeoutSec, "number");
});
