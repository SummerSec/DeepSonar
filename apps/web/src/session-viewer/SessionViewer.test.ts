import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SessionViewer.tsx", import.meta.url), "utf8");

test("inspector uses the maintained safe Markdown renderer and preserves source mode", () => {
  assert.match(source, /import \{ MarkdownView \} from "\.\.\/MarkdownView"/);
  assert.match(source, /<MarkdownView markdown=\{body\} controls=\{false\} scrollable=\{false\} \/>/);
  assert.match(source, /<pre className="session-viewer__inspector-source-body">\{body\}<\/pre>/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("session viewer exposes a dedicated token usage tab", () => {
  assert.match(source, /type ViewerTab = "timeline" \| "usage" \| "stats" \| "raw"/);
  assert.match(source, /\["usage", `用量 /);
  assert.match(source, /gatewayUsage = \[\]/);
  assert.match(source, /<SessionUsagePane usage=\{tokenUsage\} \/>/);
  assert.match(source, /Session 归档消耗/);
  assert.match(source, /Gateway 账本消耗/);
  assert.match(source, /按轮次/);
  assert.match(source, /按模型/);
  assert.match(source, /请求明细/);
});

test("inspector exposes Chinese source, copy, and transient feedback actions", () => {
  assert.match(source, /aria-label=\{showSource \? "渲染" : "原文"\}/);
  assert.match(source, /\{showSource \? "渲染" : "原文"\}/);
  assert.match(source, /<Copy size=\{12\} \/> 复制/);
  assert.match(source, /await writeClipboard\(detail\)/);
  assert.match(source, /已复制详情/);
  assert.match(source, /复制失败：/);
  assert.match(source, /role="status"\s+aria-live="polite"/);
});
