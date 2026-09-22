import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectImagePolicySection.tsx", import.meta.url), "utf8");
const settingsPanel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("镜像缺省过滤：官方默认可用、第三方须启用", () => {
  const start = settingsPanel.indexOf("const projectRuntimeImageChoices");
  const end = settingsPanel.indexOf("const saveImagePolicy", start);
  const filter = settingsPanel.slice(start, end);
  assert.match(filter, /image\.official \? image\.project_enabled !== false : image\.project_enabled === true/);
  assert.doesNotMatch(filter, /!image\.project_opt_in/);
});

test("角色镜像缺省下拉展示完整产品名并以三列网格排布", () => {
  const start = panel.indexOf("{imagePolicyRoles.map");
  const end = panel.indexOf("{imagePolicyRoles.length === 0");
  const rows = panel.slice(start, end);
  assert.match(panel, /grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3/);
  assert.match(rows, /runtimeImageSelectOption\(image, projectId\)/);
  assert.doesNotMatch(rows, /\$\{image\.name\} · \$\{image\.image_key\}/);
  assert.doesNotMatch(rows, /sm:grid-cols-\[minmax\(6\.5rem,9rem\)_minmax\(0,1fr\)\]/);
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

test("设置页镜像文案表述为启用边界与角色缺省而非替 AI 选图", () => {
  assert.match(panel, /镜像启用与角色缺省/);
  assert.match(panel, /Hub 可按任务从本项目可用且可信的镜像中提案/);
  assert.match(panel, /官方镜像默认可用/);
  assert.match(panel, /第三方须先启用/);
  assert.match(panel, /缺省跟随各角色全局 RoleConfig 镜像/);
  assert.match(panel, /缺省使用下方角色映射；未映射角色用系统基础环境（deepsonar-base）/);
  assert.match(panel, /保存镜像缺省/);
  assert.match(settingsPanel, /镜像缺省已保存（下一 job 生效）/);
  assert.match(settingsPanel, /ProjectImagePolicySection/);
  assert.doesNotMatch(panel, /项目镜像策略/);
  assert.doesNotMatch(panel, /保存镜像策略/);
});
