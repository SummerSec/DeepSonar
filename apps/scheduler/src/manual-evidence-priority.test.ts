import assert from "node:assert/strict";
import test from "node:test";
import {
  isSchedulerOwnedVerificationFollowup,
  schedulerPurposeForPendingNormalization,
  stripPublicSchedulingMarkers,
} from "./core.js";

const manualFollowup = {
  scheduling_purpose: "convergence_evidence",
  verification_followup: {
    finding_id: "00000000-0000-4000-8000-000000000001",
    required_evidence: ["review"],
    scheduler_owned: true,
    manual_override: true,
  },
};

test("人工补证在非 Hub parent 下仍保持 Scheduler 收敛 lane", () => {
  assert.equal(isSchedulerOwnedVerificationFollowup(manualFollowup, "audit"), true);
  assert.equal(schedulerPurposeForPendingNormalization("review", manualFollowup, "audit"), "convergence_evidence");
  assert.equal(isSchedulerOwnedVerificationFollowup({
    verification_followup: {
      finding_id: "00000000-0000-4000-8000-000000000001",
      required_evidence: ["review"],
      scheduler_owned: true,
    },
  }, "hub_reason"), true);
});

test("公共 Job 输入会剥离 Scheduler 和人工补证可信标记", () => {
  const sanitized = stripPublicSchedulingMarkers({
    ...manualFollowup,
    scheduler_owned: true,
    manual_override: true,
  });
  const followup = sanitized.verification_followup as Record<string, unknown>;
  assert.equal(sanitized.scheduling_purpose, undefined);
  assert.equal(sanitized.scheduler_owned, undefined);
  assert.equal(sanitized.manual_override, undefined);
  assert.equal(followup.scheduler_owned, undefined);
  assert.equal(followup.manual_override, undefined);
  assert.equal(isSchedulerOwnedVerificationFollowup(sanitized, "audit"), false);
  assert.equal(schedulerPurposeForPendingNormalization("review", sanitized, "audit"), "discovery");
});
