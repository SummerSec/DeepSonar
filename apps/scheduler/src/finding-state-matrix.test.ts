import assert from "node:assert/strict";
import test from "node:test";
import {
  FINDING_STATE_MATRIX,
  HUMAN_JOB_STATUS,
  isClosedDisposition,
  isOpenHighRiskFinding,
  VERIFY_VERDICTS,
} from "./finding-state-matrix.js";

test("human confirmed_vuln is recorded independently of system verify", () => {
  const row = FINDING_STATE_MATRIX.find(
    (item) => item.dimension === "disposition" && item.value === "confirmed_vuln",
  );
  assert.ok(row, "confirmed_vuln 必须仍在矩阵里");
  // 矩阵必须写清它是人工事实：不再声明依赖 verify_status，也不允许它改写 Verify。
  assert.equal(row.owner, "Human");
  assert.doesNotMatch(String(row.writer), /verify_status=confirmed/u);
  assert.match(String(row.meaning), /分开记录/u);
  // 既不属于待跟进，也不属于闭环否定：它是人工确认的业务事实。
  assert.equal(isOpenHighRiskFinding({ severity: "critical", disposition: "confirmed_vuln" }), false);
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
  assert.deepEqual([...VERIFY_VERDICTS], ["confirmed", "rework", "needs_human", "refuted"]);
  assert.equal(HUMAN_JOB_STATUS, "waiting_human");
  const dimensions = new Set(FINDING_STATE_MATRIX.map((row) => row.dimension));
  assert.deepEqual(
    [...dimensions].sort(),
    ["disposition", "job_waiting_human", "research_dedupe", "research_priority", "verify_status"],
  );
  const leftover = FINDING_STATE_MATRIX.find((row) => row.dimension === "verify_status" && row.value === "false_positive");
  assert.equal(leftover?.writer, "无（新流程不可写）");
  assert.match(leftover?.report ?? "", /不映射为 rework/);
  const refuted = FINDING_STATE_MATRIX.find((row) => row.dimension === "verify_status" && row.value === "refuted");
  assert.equal(refuted?.terminal, true);
  assert.equal(refuted?.owner, "Scheduler");
  const inconclusive = FINDING_STATE_MATRIX.find((row) => row.dimension === "verify_status" && row.value === "inconclusive");
  assert.equal(inconclusive?.terminal, true);
  assert.match(inconclusive?.meaning ?? "", /未证实/);
});
