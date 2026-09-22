import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatStoredProjectJobQuota,
  isProjectJobQuotaDraftDirty,
  nextProjectJobQuotaOnReload,
  parseProjectJobQuotaDraft,
} from "./project-job-quota-draft";

test("formatStoredProjectJobQuota maps number / missing to input string", () => {
  assert.equal(formatStoredProjectJobQuota(3), "3");
  assert.equal(formatStoredProjectJobQuota(0), "0");
  assert.equal(formatStoredProjectJobQuota(undefined), "");
  assert.equal(formatStoredProjectJobQuota(null), "");
  assert.equal(formatStoredProjectJobQuota("2"), "");
});

test("dirty draft is preserved across reload while baseline advances", () => {
  assert.equal(isProjectJobQuotaDraftDirty("2", "1"), true);
  assert.equal(isProjectJobQuotaDraftDirty("1", "1"), false);
  assert.equal(isProjectJobQuotaDraftDirty("", ""), false);

  const dirty = nextProjectJobQuotaOnReload("2", "1", 1);
  assert.deepEqual(dirty, { draft: "2", baseline: "1" });

  // 服务端已变为其他值，但仍保护未保存草稿；baseline 跟随服务端
  const serverMoved = nextProjectJobQuotaOnReload("2", "1", 5);
  assert.deepEqual(serverMoved, { draft: "2", baseline: "5" });

  const clean = nextProjectJobQuotaOnReload("1", "1", 4);
  assert.deepEqual(clean, { draft: "4", baseline: "4" });

  const inherit = nextProjectJobQuotaOnReload("", "", undefined);
  assert.deepEqual(inherit, { draft: "", baseline: "" });
});

test("parseProjectJobQuotaDraft accepts empty inherit and integer quota", () => {
  assert.equal(parseProjectJobQuotaDraft(""), null);
  assert.equal(parseProjectJobQuotaDraft("  "), null);
  assert.equal(parseProjectJobQuotaDraft("0"), 0);
  assert.equal(parseProjectJobQuotaDraft("7"), 7);
  assert.throws(() => parseProjectJobQuotaDraft("1.5"));
  assert.throws(() => parseProjectJobQuotaDraft("-1"));
  assert.throws(() => parseProjectJobQuotaDraft("1001"));
  assert.throws(() => parseProjectJobQuotaDraft("abc"));
});

test("SettingsPanel wires ProjectJobQuotaSection and keeps rules save quota-free (#644)", () => {
  const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  const section = readFileSync(new URL("./components/ProjectJobQuotaSection.tsx", import.meta.url), "utf8");
  assert.match(panel, /ProjectJobQuotaSection/);
  assert.doesNotMatch(panel, /setProjectJobQuota/);
  const saveRulesBlock = panel.slice(panel.indexOf("const saveRules"), panel.indexOf("const toggleRole"));
  assert.doesNotMatch(saveRulesBlock, /maxConcurrentJobs/);
  assert.match(section, /保存项目配额/);
  assert.match(section, /nextProjectJobQuotaOnReload/);
  assert.match(section, /rules:\s*\{\s*maxConcurrentJobs\s*\}/);
});
