import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname);
const panel = readFileSync(path.join(sourceRoot, "JobDetailPanel.tsx"), "utf8");
const workspace = readFileSync(path.join(sourceRoot, "LiveTerminalWorkspace.tsx"), "utf8");
const markdown = readFileSync(path.join(sourceRoot, "MarkdownView.tsx"), "utf8");

test("job detail Escape closes the drawer but defers to a nested confirmation", () => {
  assert.match(panel, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(panel, /document\.querySelector\('\[role="alertdialog"\]'\)/);
  assert.match(panel, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(panel, /onClose\(\);/);
});

test("live terminal is an explicit, permission-gated mount", () => {
  assert.match(workspace, /useState\(false\)/);
  assert.match(workspace, /desktop && terminalAllowed && desktopTerminalOpen/);
  assert.match(workspace, /aria-label="打开终端"/);
  assert.match(workspace, /aria-label="关闭终端"/);
  assert.match(workspace, /mobileView === "terminal" && terminalAllowed/);
  assert.doesNotMatch(workspace, /mobileView === "stream" \? "" : "hidden"/);
  assert.doesNotMatch(workspace, /mobileView === "terminal" \? "" : "hidden"/);
});

test("changing jobs resets terminal state and tears down the previous terminal", () => {
  assert.match(workspace, /const \[terminalJobId, setTerminalJobId\] = useState\(jobId\)/);
  assert.match(workspace, /setDesktopTerminalOpen\(false\);[\s\S]*?setMobileView\("stream"\);[\s\S]*?setTerminalJobId\(jobId\);[\s\S]*?\}, \[jobId\]\)/);
  assert.match(workspace, /desktop && terminalAllowed && desktopTerminalOpen && terminalJobId === jobId/);
  assert.match(workspace, /mobileView === "terminal" && terminalAllowed && terminalJobId === jobId/);
  assert.match(workspace, /<TerminalPanel key=\{jobId\}/);
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

test("运行详情展示 Attempt、外部效果、投递和用量摘要", () => {
  assert.match(panel, /执行账本/);
  assert.match(panel, /latestAttempt/);
  assert.match(panel, /unknownEffects/);
  assert.match(panel, /deliveryCounts/);
  assert.match(panel, /totalTokens/);
});
