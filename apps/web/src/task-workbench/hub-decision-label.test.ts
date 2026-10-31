import assert from "node:assert/strict";
import test from "node:test";
import { formatHubDecisionLabel } from "./hub-decision-label";

test("formatHubDecisionLabel surfaces verify-unclosed Hub stops (#574)", () => {
  assert.equal(formatHubDecisionLabel(null), null);
  assert.equal(formatHubDecisionLabel({ hub_paused: true }), "已暂停");
  assert.equal(formatHubDecisionLabel({ auto_stopped: false }), "自驱中");
  assert.equal(formatHubDecisionLabel({ auto_stopped: true }), "已收敛");
  assert.equal(
    formatHubDecisionLabel({
      auto_stopped: true,
      paused_reason: "verify_unclosed:high=5(inconclusive=4,pending=1)",
    }),
    "Hub 已停：5 个 high 未收口（4 inconclusive / 1 pending）",
  );
});
