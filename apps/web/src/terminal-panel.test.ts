import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "TerminalPanel.tsx"), "utf8");

test("terminal copy actions guard empty text and expose feedback", () => {
  assert.match(source, /if \(text\.length === 0\)/);
  assert.match(source, /没有可复制的\$\{label\}/);
  assert.match(source, /已复制\$\{label\}/);
  assert.match(source, /浏览器未授予剪贴板权限/);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /terminal\.buffer\.active/);
  assert.match(source, /aria-label="复制全部终端内容"/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText\(terminalRef\.current/);
});

test("copy feedback is transient and does not replace the connection status", () => {
  assert.match(source, /const timeout = window\.setTimeout\(\(\) => setCopyFeedback\(""\), 2200\)/);
  assert.match(source, /return \(\) => window\.clearTimeout\(timeout\)/);
  assert.match(source, /<span className="min-w-0 flex-1 truncate font-mono text-\[10px\] text-zinc-500">\{status\}<\/span>/);
  assert.match(source, /<span role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(source, /\{copyFeedback \|\| status\}/);
  assert.match(source, /<ClipboardText size=\{14\} \/>/);
});

test("Ctrl/Cmd+C copies only an existing selection while empty selection keeps PTY input", () => {
  const handlerStart = source.indexOf("terminal.attachCustomKeyEventHandler");
  const handlerEnd = source.indexOf("\n\n    const connect", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(handler, /terminal\.hasSelection\(\)/);
  assert.match(handler, /event\.type === "keydown"/);
  assert.match(handler, /void copyText\(terminal\.getSelection\(\), "选中内容"\)/);
  assert.match(handler, /if \(copyShortcut && terminal\.hasSelection\(\)\) \{[\s\S]*?return false;\s*\}\s*return true;/);
});

test("Tab is routed through xterm input instead of browser focus traversal", () => {
  assert.match(source, /if \(event\.key === "Tab"\)/);
  assert.match(source, /terminal\.input\(event\.shiftKey \? "\\u001b\[Z" : "\\t"\)/);
  assert.match(source, /event\.preventDefault\(\);[\s\S]*?return false;/);
  assert.match(source, /const input = terminal\.onData\(sendInput\)/);
  assert.match(source, /type: "input", data/);
});

test("terminal ticket and WebSocket transport remain governed", () => {
  assert.match(source, /api\.createWsTicket\(jobId, "terminal"\)/);
  assert.match(source, /\/api\/terminal-ws\?/);
  assert.match(source, /ticket: ticket\.ticket/);
  assert.match(source, /4401: "终端凭证无效或已过期"/);
  assert.match(source, /4403: "当前账号无终端权限"/);
});
