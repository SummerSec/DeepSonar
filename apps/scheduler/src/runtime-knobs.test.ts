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
  tightenRuntimeKnobValue,
  validateRuntimeKnobOverride,
} from "./runtime-knobs.js";

const env = {
  stallSec: 900,
  jobTokenMaxRequests: 500,
  auditTimeoutSec: 18_000,
  verifyTimeoutSec: 10_800,
  provisionTimeoutSec: 300,
};

test("runtime knobs follow job > role > project > platform > env with role/project tighten-only (#697)", () => {
  const resolved = resolveRuntimeKnobs({
    jobType: "audit",
    env,
    platform: { stallSec: 1_200, jobTokenMaxRequests: 800, auditTimeoutSec: 20_000, provisionTimeoutSec: 400 },
    project: { stallSec: 1_500, jobTokenMaxRequests: 0 },
    role: { stallSec: 2_000 },
    job: { timeoutSec: 30_000 },
    imageKey: "deepsonar-audit",
  });
  // role 2000 / project 1500 clamped to platform 1200
  assert.equal(resolved.stallSec, 1_200);
  assert.equal(resolved.sources.stallSec, "role");
  // project 0 (unlimited) cannot widen finite platform 800
  assert.equal(resolved.jobTokenMaxRequests, 800);
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
  // role raise above platform verify timeout is clamped (#697)
  const role = resolveRuntimeKnobs({
    jobType: "verify_finding",
    env,
    platform: { verifyTimeoutSec: 9_000 },
    role: { timeoutSec: 12_000 },
  });
  assert.equal(role.timeoutSec, 9_000);
  assert.equal(role.sources.timeoutSec, "role");
  // role tighten below platform still applies
  const roleTight = resolveRuntimeKnobs({
    jobType: "verify_finding",
    env,
    platform: { verifyTimeoutSec: 9_000 },
    role: { timeoutSec: 6_000 },
  });
  assert.equal(roleTight.timeoutSec, 6_000);
  assert.equal(roleTight.sources.timeoutSec, "role");
});

test("chrome image floor still raises stall; project/role cannot widen past platform (#697)", () => {
  const floor = resolveRuntimeKnobs({ jobType: "test", env, imageKey: "deepsonar-chrome-fuzz" });
  assert.equal(floor.stallSec, CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
  assert.equal(floor.sources.stallSec, "env");

  // role tries to set 20000 but env ceiling is 900 → clamp to 900 then chrome floor raises
  const raised = resolveRuntimeKnobs({
    jobType: "test",
    env,
    imageKey: "deepsonar-chrome-fuzz",
    role: { stallSec: 20_000 },
  });
  assert.equal(raised.stallSec, CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
  assert.equal(raised.sources.stallSec, "role");
  // Explicit role below chrome floor still gets the image floor applied
  const belowFloor = resolveRuntimeKnobs({
    jobType: "test",
    env,
    imageKey: "deepsonar-chrome-fuzz",
    role: { stallSec: 600 },
  });
  assert.equal(belowFloor.stallSec, CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
});

test("stall 0 and max_requests 0 mean unlimited / disabled at platform/env", () => {
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

test("#697 role knobs merge project over global with tighten-only (0=unlimited)", () => {
  assert.deepEqual(
    mergeRoleRuntimeKnobOverrides({ stallSec: 1_200, jobTokenMaxRequests: 80 }, { stallSec: 4_000 }),
    { stallSec: 1_200, jobTokenMaxRequests: 80, timeoutSec: undefined },
  );
  assert.deepEqual(
    mergeRoleRuntimeKnobOverrides({ stallSec: 1_200, jobTokenMaxRequests: 80 }, { stallSec: 600, jobTokenMaxRequests: 0 }),
    { stallSec: 600, jobTokenMaxRequests: 80, timeoutSec: undefined },
  );
  assert.deepEqual(
    mergeRoleRuntimeKnobOverrides({ stallSec: 0, jobTokenMaxRequests: 0 }, { stallSec: 900, jobTokenMaxRequests: 40 }),
    { stallSec: 900, jobTokenMaxRequests: 40, timeoutSec: undefined },
  );
  assert.equal(tightenRuntimeKnobValue(0, 800, { zeroIsUnlimited: true }), 800);
  assert.equal(tightenRuntimeKnobValue(400, 0, { zeroIsUnlimited: true }), 400);
  assert.deepEqual(parseRuntimeKnobOverride({ stallSec: -1, jobTokenMaxRequests: 12 }), { jobTokenMaxRequests: 12 });
});

test("RoleConfig runtime_knobs reject snake_case aliases on write", () => {
  assert.match(validateRuntimeKnobOverride({ stall_sec: 900 }) ?? "", /stallSec/);
  assert.match(validateRuntimeKnobOverride({ job_token_max_requests: 12 }) ?? "", /jobTokenMaxRequests/);
  assert.equal(validateRuntimeKnobOverride({ stallSec: 900 }), null);
});

test("frozen snapshot knobs round-trip and reject partial blobs", () => {
  const frozen = freezeRuntimeKnobs(resolveRuntimeKnobs({ jobType: "audit", env, role: { stallSec: 600 } }));
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
