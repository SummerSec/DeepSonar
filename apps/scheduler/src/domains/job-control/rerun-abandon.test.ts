import assert from "node:assert/strict";
import test from "node:test";
import { closeAbandonedCheckpoint, validateAbandonableCheckpoint } from "./rerun.js";

type Row = Record<string, unknown>;

/** 极简 sql 替身：只认本模块发出的两条语句，并记录是否发生写入。 */
function fakeSql(request: Row | null, latestAttemptNo = 1) {
  const writes: string[] = [];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM human_requests r")) return request ? [request] : [];
    if (text.includes("FROM job_attempts WHERE job_id")) return [{ attempt_no: latestAttemptNo }];
    if (text.startsWith("UPDATE human_requests")) {
      writes.push(String(values[0]));
      return [];
    }
    return [];
  }) as unknown as typeof import("../../db.js").sql;
  return { tag, writes };
}

test("#1223 只有 blocked 且属于当前 Attempt 的请求才允许放弃", async () => {
  const blocked = { id: "req-1", status: "answered", checkpoint_status: "blocked",
    checkpoint_error_code: "HUMAN_CHECKPOINT_SECRET_DETECTED", resumed_at: null, attempt_no: 1 };
  const ok = await validateAbandonableCheckpoint(fakeSql(blocked).tag as never, "job-1");
  assert.deepEqual(ok, { ok: true, requestId: "req-1" });

  for (const [label, request, latest] of [
    ["ready", { ...blocked, checkpoint_status: "ready", checkpoint_error_code: null }, 1],
    ["preparing", { ...blocked, checkpoint_status: "preparing", checkpoint_error_code: null }, 1],
    ["无错误码", { ...blocked, checkpoint_error_code: null }, 1],
    ["已进入续做", { ...blocked, resumed_at: new Date() }, 1],
    ["不属于当前 Attempt", blocked, 2],
    ["没有请求", null, 1],
  ] as const) {
    const verdict = await validateAbandonableCheckpoint(fakeSql(request as Row | null, latest).tag as never, "job-1");
    assert.equal(verdict.ok, false, label);
    if (!verdict.ok) assert.match(verdict.reason, /./u, label);
  }
});

test("#1223 关闭只发一条 UPDATE，且带 abandoned_checkpoint 原因", async () => {
  const { tag, writes } = fakeSql(null);
  await closeAbandonedCheckpoint(tag as never, "req-9");
  assert.deepEqual(writes, ["req-9"]);
});
