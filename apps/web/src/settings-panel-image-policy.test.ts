import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("项目镜像策略过滤官方专项镜像的项目启用状态", () => {
  const start = panel.indexOf("const projectRuntimeImageChoices");
  const end = panel.indexOf("const saveImagePolicy", start);
  const filter = panel.slice(start, end);
  assert.match(filter, /image\.official && !image\.project_opt_in/);
  assert.match(filter, /image\.project_enabled !== false/);
  assert.match(filter, /image\.project_enabled === true/);
});
