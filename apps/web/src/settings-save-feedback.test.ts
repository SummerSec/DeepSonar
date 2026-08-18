import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
const toast = readFileSync(new URL("./toast.tsx", import.meta.url), "utf8");

test("AppShell reads /health version instead of faking scheduler status only", () => {
  assert.match(shell, /api\.health\(\)/);
  assert.match(shell, /formatHealthVersion/);
  assert.match(shell, /调度器在线/);
});

test("settings save flash also raises a viewport-fixed toast", () => {
  assert.match(panel, /showToast\(m, inferToastKind\(m\)\)/);
  assert.match(toast, /createPortal/);
  assert.match(toast, /document\.body/);
  assert.match(toast, /app-toast-stack/);
});

test("primary settings save buttons expose busy and saved labels", () => {
  assert.match(panel, /rulesBusy \? "保存中…" : rulesSaved \? "已保存"/);
  assert.match(panel, /imagePolicyBusy \? "保存中…" : imagePolicySaved \? "已保存"/);
  const editor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /busy \? "保存中…" : saved \? "已保存"/);
});

test("project rules expose a claim-time concurrent job quota", () => {
  assert.match(panel, /最大同时运行 Job 数/);
  assert.match(panel, /maxConcurrentJobs/);
  assert.match(panel, /当前运行 \/ 有效上限/);
  assert.match(panel, /该项目所有任务共享此额度/);
});
