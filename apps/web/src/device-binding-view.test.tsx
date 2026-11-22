import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceBindingView, type BindingDiagnostics } from "./DeviceBindingView";

const attempt = { attempt_id: "second", attempt_no: 2, state: "declared_no_lease", reason: "尚无租约记录" } as const;
const binding: BindingDiagnostics = {
  ...attempt, role_matched: true, snapshot_requirement: { transport: "hdc" },
  attempts: [attempt], attempts_truncated: false, leases_truncated: false,
};

test("没有诊断时不冒充未绑定，未声明时显示平台原因", () => {
  assert.equal(renderToStaticMarkup(<DeviceBindingView attempts={[]} />), "");
  const html = renderToStaticMarkup(<DeviceBindingView binding={{ ...binding, state: "not_declared",
    snapshot_requirement: null, role_matched: false, attempts: [], reason: "没有声明设备需求" }} attempts={[]} />);
  assert.match(html, /未绑定设备/);
  assert.match(html, /没有声明设备需求/);
});

test("租约失败按本轮结构化原因认定，不串用上次的结果", () => {
  const history = { ...attempt, attempt_id: "first", attempt_no: 1 };
  const html = renderToStaticMarkup(<DeviceBindingView binding={{ ...binding, attempts: [attempt, history] }}
    attempts={[{ id: "first", outcome_json: { reason: "device_not_available" }, error: "设备代理未响应" }]} />);
  assert.match(html, /<summary>设备绑定 · 暂无租约记录/);
  assert.match(html, /第 1 次执行 · 租约申请失败/);
  assert.match(html, /设备代理未响应/);
});

test("按角色和租约事实显示状态，已发租约不代表已连通", () => {
  const render = (b: BindingDiagnostics) => renderToStaticMarkup(<DeviceBindingView binding={b} attempts={[]} />);
  assert.match(render({ ...binding, role_matched: false }), /当前角色无需设备/);
  assert.match(render({ ...binding, state: "lease_recorded_unverified", attempts: [] }), /已记录租约，连接未验证/);
});
