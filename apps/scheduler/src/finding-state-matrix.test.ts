import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIRMED_VULN_REQUIRES_VERIFY,
  dispositionAllowed,
  FINDING_STATE_MATRIX,
  HUMAN_JOB_STATUS,
  isClosedDisposition,
  isOpenHighRiskFinding,
  VERIFY_VERDICTS,
} from "./finding-state-matrix.js";

test("confirmed_vuln requires system verify_status=confirmed", () => {
  assert.deepEqual(dispositionAllowed("confirmed", "confirmed_vuln"), { ok: true });
  assert.deepEqual(dispositionAllowed("pending", "confirmed_vuln"), {
    ok: false,
    error_code: CONFIRMED_VULN_REQUIRES_VERIFY,
  });
  assert.deepEqual(dispositionAllowed("needs_human", "confirmed_vuln"), {
    ok: false,
    error_code: CONFIRMED_VULN_REQUIRES_VERIFY,
  });
  assert.deepEqual(dispositionAllowed("pending", "human_reproducing"), { ok: true });
});

test("open high-risk excludes confirmed_vuln and closed dispositions", () => {
  assert.equal(isOpenHighRiskFinding({ severity: "critical", disposition: "open" }), true);
  assert.equal(isOpenHighRiskFinding({ severity: "high", disposition: "accepted" }), true);
  assert.equal(isOpenHighRiskFinding({ severity: "high", disposition: "human_reproducing" }), true);
  assert.equal(isOpenHighRiskFinding({ severity: "critical", disposition: "confirmed_vuln" }), false);
  assert.equal(isOpenHighRiskFinding({ severity: "critical", disposition: "resolved" }), false);
  assert.equal(isOpenHighRiskFinding({ severity: "medium", disposition: "open" }), false);
  assert.equal(isClosedDisposition("rejected_fp"), true);
  assert.equal(isClosedDisposition("open"), false);
});

test("verify / disposition / waiting_human stay independent dimensions", () => {
  assert.deepEqual([...VERIFY_VERDICTS], ["confirmed", "rework", "needs_human"]);
  assert.equal(HUMAN_JOB_STATUS, "waiting_human");
  const dimensions = new Set(FINDING_STATE_MATRIX.map((row) => row.dimension));
  assert.deepEqual(
    [...dimensions].sort(),
    ["disposition", "job_waiting_human", "research_dedupe", "research_priority", "verify_status"],
  );
  const leftover = FINDING_STATE_MATRIX.find((row) => row.dimension === "verify_status" && row.value === "false_positive");
  assert.equal(leftover?.writer, "无（新流程不可写）");
  assert.match(leftover?.report ?? "", /不映射为 rework/);
});
