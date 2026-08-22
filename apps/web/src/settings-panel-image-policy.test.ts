import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("项目镜像策略过滤官方专项镜像的项目启用状态", () => {
  const start = panel.indexOf("const projectRuntimeImageChoices");
  const end = panel.indexOf("const saveImagePolicy", start);
  const filter = panel.slice(start, end);
  assert.match(filter, /image\.official && !image\.project_opt_in/);
  assert.match(filter, /image\.project_enabled !== false/);
  assert.match(filter, /image\.project_enabled === true/);
});

test("项目镜像策略下拉展示完整产品名并让选择器占满剩余宽度", () => {
  const start = panel.indexOf("{imagePolicyRoles.map");
  const end = panel.indexOf("{imagePolicyRoles.length === 0");
  const rows = panel.slice(start, end);
  assert.match(rows, /runtimeImageSelectOption\(image, projectId\)/);
  assert.doesNotMatch(rows, /\$\{image\.name\} · \$\{image\.image_key\}/);
  assert.match(rows, /sm:grid-cols-\[minmax\(6\.5rem,9rem\)_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(rows, /minmax\(190px,240px\)/);
  assert.match(rows, /className="searchable-select-wrap"/);
});

test("searchable-select-wrap 允许触发器换行以显示完整镜像名", () => {
  const start = styles.indexOf(".searchable-select-wrap {");
  const end = styles.indexOf(".datetime-local-trigger {", start);
  const wrap = styles.slice(start, end);
  assert.match(wrap, /\.searchable-select-wrap \.searchable-select-trigger-primary/);
  assert.match(wrap, /white-space:\s*normal/);
  assert.match(wrap, /word-break:\s*break-word/);
  assert.doesNotMatch(wrap, /text-overflow:\s*ellipsis/);
});
