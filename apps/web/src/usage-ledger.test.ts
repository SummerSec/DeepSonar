import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultCustomRange, shanghaiYmd, shiftShanghaiYmd, usagePeriodLabel } from "./usage-ledger.js";

test("Shanghai helpers keep custom defaults on a 7-day inclusive window", () => {
  const now = new Date("2026-08-19T10:00:00.000+08:00");
  assert.equal(shanghaiYmd(now), "2026-08-19");
  assert.equal(shiftShanghaiYmd("2026-08-19", -6), "2026-08-13");
  assert.deepEqual(defaultCustomRange(now), { from: "2026-08-13", to: "2026-08-19" });
});

test("period labels cover presets and custom range", () => {
  assert.equal(usagePeriodLabel("day"), "今日");
  assert.equal(usagePeriodLabel("week"), "近 7 日");
  assert.equal(usagePeriodLabel("month"), "近 30 日");
  assert.equal(usagePeriodLabel("custom"), "自定义");
});

test("usage board asks the dashboard usage API with period and optional custom range", () => {
  const source = readFileSync(new URL("./UsageLedgerBoard.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.dashboardUsage\(/);
  assert.match(source, /period === "custom"/);
  assert.match(source, /from: customFrom/);
  assert.match(source, /to: customTo/);
  assert.match(source, /type="date"/);
});
