/** Pure lifecycle formatting checks (no scheduler or database required). */
import assert from "node:assert/strict";
import { elapsedMs, formatDuration, formatElapsed } from "../apps/web/src/ui.tsx";

const start = "2026-08-04T00:00:00.000Z";
const startedAt = Date.parse("2026-08-04T00:00:02.000Z");

assert.equal(elapsedMs(start, null, startedAt), 2_000);
assert.equal(formatElapsed(start, null, startedAt), "2 秒");
const terminalEnd = "2026-08-04T00:02:05.000Z";
assert.equal(formatElapsed(start, terminalEnd, Date.parse("2026-08-04T00:02:06.000Z")), "2 分 5 秒");
// A terminal running duration is frozen at ended_at, even when the UI clock advances.
assert.equal(formatElapsed(start, terminalEnd, Date.parse("2026-08-04T00:30:00.000Z")), "2 分 5 秒");
assert.equal(formatDuration(0), "0 秒");
assert.equal(formatDuration(59_999), "59 秒");
assert.equal(formatDuration(60_000), "1 分");
assert.equal(formatDuration(3_600_000), "1 小时");
assert.equal(formatDuration(90_000_000), "1 天 1 小时");
assert.equal(formatElapsed(null, null, startedAt), "—");

console.log("task lifecycle formatting OK");
