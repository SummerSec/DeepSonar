import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeProcessEvidenceView } from "./RuntimeProcessEvidence";
import { DeviceBindingView, type DeviceBinding } from "./DeviceBindingView";

const sourceRoot = path.resolve(import.meta.dirname);
const panel = readFileSync(path.join(sourceRoot, "JobDetailPanel.tsx"), "utf8");
const workspace = readFileSync(path.join(sourceRoot, "LiveTerminalWorkspace.tsx"), "utf8");
const markdown = readFileSync(path.join(sourceRoot, "MarkdownView.tsx"), "utf8");

const unbound: DeviceBinding = {
  state: "not_declared", reason: "本次运行未声明设备需求", role_matched: false,
  snapshot_requirement: null, canvas_requirement: null, attempts: [], leases: [],
  attempts_truncated: false, leases_truncated: false, lease_count: 0,
};

test("未绑定、未领取、角色不适用与缺失诊断分别呈现", () => {
  const render = (binding?: DeviceBinding) => renderToStaticMarkup(createElement(DeviceBindingView, { binding }));
  assert.match(panel, /<DeviceBindingView binding=\{detail.device_binding\} \/>/);
  assert.equal(render(), "");
  assert.match(render(unbound), /未绑定设备（未声明需求）/);
  const declared = { ...unbound, state: "not_attempted" as const, canvas_requirement: { transport: "hdc" } };
  assert.match(render(declared), /运行快照未包含画布需求/);
  const frozen = { ...declared, snapshot_requirement: declared.canvas_requirement };
  assert.match(render(frozen), /当前角色无需设备/);
  assert.match(render({ ...frozen, role_matched: true }), /尚未申请租约/);
  assert.match(render({ ...frozen, state: "not_applying" }), /当前角色无需设备/);
});

test("设备诊断只展示分类原因，截断的租约列表不改变历史分档", () => {
  const binding: DeviceBinding = {
    ...unbound, snapshot_requirement: { transport: "hdc" }, role_matched: true,
    state: "attempted_no_lease", attempts_truncated: true, leases_truncated: true, lease_count: 33,
    attempts: [
      { attempt_id: "d", attempt_no: 4, state: "attempted_no_lease", reason: "尚无记录" },
      { attempt_id: "c", attempt_no: 3, state: "lease_unrecorded", reason: "没有设备失败码" },
      { attempt_id: "b", attempt_no: 2, state: "acquire_failed", reason: "申请被拒" },
      { attempt_id: "a", attempt_no: 1, state: "lease_recorded_unverified", reason: "已记录租约" },
    ],
    leases: [{ attempt_id: null, device_key: "emulator", rig_id: "lab", state: "released" }],
  };
  const props = { binding, attempts: [
    { id: "c", error: "资产准备错误" },
    { id: "b", error: "DatabaseError: INTERNAL_DB_DIAGNOSTIC" },
  ] };
  const html = renderToStaticMarkup(createElement(DeviceBindingView, props));
  assert.match(html, /<summary[^>]*>设备绑定 · 本次执行暂无租约记录/);
  assert.match(html, /第 3 次执行 · 未记录租约申请结果/);
  assert.match(html, /第 2 次执行 · 设备租约申请失败<\/strong><p>申请被拒<\/p>/);
  assert.doesNotMatch(html, /资产准备错误|DatabaseError|INTERNAL_DB_DIAGNOSTIC/);
  assert.match(html, /第 1 次执行 · 已记录租约，连接未验证/);
  assert.match(html, /执行归属未知 · lab \/ emulator · 已释放/);
  assert.match(html, /最近 4 次执行/);
  assert.match(html, /共 33 条租约，仅显示最近 1 条/);
});

test("process cleanup evidence renders distinct results and the recovery boundary", () => {
  const html = renderToStaticMarkup(createElement(RuntimeProcessEvidenceView, { rows: [{
    audit_id: "1", observed_at: "2026-11-19T00:00:00.000Z", observation: {
      attempt_id: "attempt", sandbox_id: "sandbox", process_id: "process", termination: "host_kill",
      host_kill_caller: "terminal_result", exit_code: null, cleanup: { outcome: "http_error", http_status: 503 },
    }, sandbox_cleanup: { outcome: "timeout", automatic_recovery: "not_delivered" },
  }] }));
  assert.match(html, /正常结果收尾/); assert.match(html, /HTTP 拒绝/); assert.match(html, /503/);
  assert.match(html, /超时，结果未知/); assert.match(html, /自动恢复整个任务尚未交付/);
  assert.match(panel, /RuntimeProcessEvidenceView rows=\{detail.process_diagnostics\}/);
});

test("job detail Escape closes the drawer but defers to a nested confirmation", () => {
  assert.match(panel, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(panel, /document\.querySelector\('\[role="alertdialog"\]'\)/);
  assert.match(panel, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(panel, /onClose\(\);/);
});

test("live terminal is an explicit, permission-gated mount", () => {
  assert.match(workspace, /useState\(false\)/);
  assert.match(workspace, /desktop && canOpenTerminal && desktopTerminalOpen/);
  assert.match(workspace, /aria-label="打开终端"/);
  assert.match(workspace, /aria-label="关闭终端"/);
  assert.match(workspace, /mobileView === "terminal" && canOpenTerminal/);
  assert.match(workspace, /该 CLI 暂不支持交互终端/);
  assert.doesNotMatch(workspace, /mobileView === "stream" \? "" : "hidden"/);
  assert.doesNotMatch(workspace, /mobileView === "terminal" \? "" : "hidden"/);
});

test("changing jobs resets terminal state and tears down the previous terminal", () => {
  assert.match(workspace, /const \[terminalJobId, setTerminalJobId\] = useState\(jobId\)/);
  assert.match(workspace, /setDesktopTerminalOpen\(false\);[\s\S]*?setMobileView\("stream"\);[\s\S]*?setTerminalJobId\(jobId\);[\s\S]*?\}, \[jobId\]\)/);
  assert.match(workspace, /desktop && canOpenTerminal && desktopTerminalOpen && terminalJobId === jobId/);
  assert.match(workspace, /mobileView === "terminal" && canOpenTerminal && terminalJobId === jobId/);
  assert.match(workspace, /<TerminalPanel key=\{jobId\}/);
});

test("job result human messages default collapsed through the shared list", () => {
  assert.match(panel, /<HumanMessageList/);
  assert.match(panel, /expandedIds=\{expandedMessageIds\}/);
  assert.doesNotMatch(panel, /human-message-detail-section" aria-label="人工消息"/);
});

test("results keep one vertical scroller while Markdown remains fully visible", () => {
  const resultStart = panel.indexOf('tab === "result"');
  const liveStart = panel.indexOf('tab === "live"', resultStart);
  const scrollStart = panel.indexOf("overflow-x-hidden overflow-y-auto");
  assert.ok(resultStart >= 0 && scrollStart >= 0 && liveStart > resultStart);
  const result = panel.slice(scrollStart, liveStart);
  assert.equal((result.match(/overflow-y-auto/g) ?? []).length, 1);
  assert.doesNotMatch(result, /max-h-\[40vh\]\s+overflow-y-auto/);
  assert.match(result, /MarkdownView markdown=\{dispatchPrompt\} scrollable=\{false\}/);
  assert.match(result, /MarkdownView markdown=\{runSummary\} scrollable=\{false\}/);
  assert.match(result, /navigator\.clipboard\?\.writeText\(dispatchPrompt\)/);
  assert.match(panel, /detail\.dispatched_prompt/);
  assert.match(panel, /extractDispatchPrompt\(detail\.job\.type, detail\.job\.payload_json\)/);
  assert.match(panel, /没有可展示的下发 prompt/);
  assert.doesNotMatch(panel, /未找到冻结的下发 prompt/);
  assert.match(markdown, /scrollable = true/);
  assert.match(markdown, /scrollable \? "max-h-\[65vh\] overflow-auto" : "overflow-visible"/);
});

test("运行详情展示有界上下文诊断，而不读取原始 prompt", () => {
  assert.match(panel, /上下文生命周期/);
  assert.match(panel, /context_diagnostics/);
  assert.match(panel, /压缩观测/);
  assert.match(panel, /transform_chain_digest/);
  assert.doesNotMatch(panel, /runtime_context\.prompt/);
});

test("Session 页可切换并下载所选归档", () => {
  assert.match(panel, /api\.jobSession\(jobId, \{ path \}\)/);
  assert.match(panel, /artifacts=\{session\.artifacts \?\? \[session\.meta\]\}/);
  assert.match(panel, /onSelectArtifact=/);
  assert.match(panel, /path: session\.meta\.path/);
  assert.match(panel, /sessionSelectReq/);
  assert.match(panel, /if \(req !== sessionSelectReq\.current\) return/);
});

test("运行详情把错误投影为 RepairFeedback，未知效果不提供无条件重试", () => {
  assert.match(panel, /RepairFeedbackPanel/);
  assert.match(panel, /projectJobActions/);
  assert.match(panel, /allowJobRetry/);
  assert.match(panel, /terminalAllowed && detail\?\.job\.execution_state/);
  assert.match(panel, /repairRecoveryActions/);
  assert.match(panel, /recoveryActions=\{repairRecoveryActions\}/);
  assert.match(panel, /使用原配置重新执行/);
  assert.match(panel, /RESUMABLE\.has\(detail\.job\.status\) && allowJobRetry/);
});

test("运行详情展示 Attempt、外部效果、投递和用量摘要", () => {
  assert.match(panel, /执行账本/);
  assert.match(panel, /latestAttempt/);
  assert.match(panel, /unknownEffects/);
  assert.match(panel, /deliveryCounts/);
  assert.match(panel, /<JobUsageLedgerView usage=\{detail\.usage\}/);
  const ledger = readFileSync(new URL("./UsageLedgerBoard.tsx", import.meta.url), "utf8");
  assert.match(ledger, /input_tokens/);
  assert.match(ledger, /output_tokens/);
  assert.match(ledger, /total_tokens/);
  assert.match(panel, /gatewayUsage=\{detail\.usage\}/);
});
