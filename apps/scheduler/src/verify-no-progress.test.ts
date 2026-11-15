import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  VERIFY_NO_PROGRESS_LIMIT,
  VERIFY_NO_PROGRESS_REASON,
  missingFingerprint,
  noProgressStreak,
  reachedNoProgressLimit,
} from "./verify-no-progress.js";

const runtime = [{ final_outcome: "rework", missing: ["runtime_test"] },
  { final_outcome: "rework", missing: ["runtime_test"] }];

test("#1133 缺失集合指纹与顺序/重复无关，进展与否按集合判定", () => {
  assert.equal(missingFingerprint(["runtime_test", "independent_review"]), "independent_review|runtime_test");
  assert.equal(missingFingerprint(["independent_review", "runtime_test"]), missingFingerprint(["runtime_test", "independent_review"]));
  assert.equal(missingFingerprint(["runtime_test", "runtime_test"]), "runtime_test");
  assert.equal(missingFingerprint([]), "");
  assert.equal(missingFingerprint(null), "");
});

test("#1133 连续同指纹的回弹才计数，缺失集合一旦缩小即视为有进展", () => {
  assert.equal(noProgressStreak(runtime, ["runtime_test"]), 2);
  // 最近一轮 missing 不同（缩小了）→ streak 中断，不误判为无进展。
  assert.equal(noProgressStreak([{ final_outcome: "rework", missing: ["runtime_test", "independent_review"] }, ...runtime], ["runtime_test"]), 0);
  // 其它终态（已收口）不参与计数。
  assert.equal(noProgressStreak([{ final_outcome: "needs_human", missing: ["runtime_test"] }], ["runtime_test"]), 0);
  // 顺序差异不算进展。
  assert.equal(noProgressStreak([{ final_outcome: "rework", missing: ["independent_review", "runtime_test"] }], ["runtime_test", "independent_review"]), 1);
});

test("#1133 达到上限即应收口：含本次判定，阈值为 0 时完全关闭", () => {
  assert.equal(VERIFY_NO_PROGRESS_LIMIT, 2);
  assert.equal(reachedNoProgressLimit([], ["runtime_test"]), false);
  assert.equal(reachedNoProgressLimit([{ final_outcome: "rework", missing: ["runtime_test"] }], ["runtime_test"]), true);
  assert.equal(reachedNoProgressLimit(runtime, ["runtime_test"]), true);
  assert.equal(reachedNoProgressLimit(runtime, ["runtime_test"], 0), false);
  assert.equal(reachedNoProgressLimit([], ["runtime_test"], 0), false);
});

test("#1133 verify 只在判定回弹后、写终态前调用刹车，并落稳定原因码", () => {
  const source = readFileSync(new URL("./verify.ts", import.meta.url), "utf8");
  const brake = source.indexOf('shouldStopForNoProgress(tx, findingId, round.id as string, missing)');
  assert.ok(brake > 0, "verify 必须在 rework 决策里调用无进展刹车");
  // 刹车位于「轮次上限」之后、「写 round 终态(finishRound)」之前。
  assert.ok(source.indexOf("maxVerificationRounds > 0") < brake, "轮次上限先于无进展刹车");
  assert.ok(brake < source.indexOf("await finishRound(tx, round.id as string, {\n    status: roundStatus,"), "刹车必须先于 round 终态写入");
  assert.ok(source.indexOf("import { VERIFY_NO_PROGRESS_REASON, shouldStopForNoProgress }") > 0, "刹车经 verify-no-progress 模块复用");
  // 收口原因与 round error 都带稳定码，便于看板/日志聚合。
  assert.ok(source.includes("noProgress ? VERIFY_NO_PROGRESS_REASON"), "needs_human 结算原因使用稳定码");
  assert.equal(VERIFY_NO_PROGRESS_REASON, "verify_no_progress");
});
