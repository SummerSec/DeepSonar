import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("database conflict retry integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  /**
   * #945: 真实交叉更新必须由有界重试收敛，而不是把冲突抛给 Job 执行路径。
   *
   * 两个连接各自持有一把行锁、sleep 后再去拿对方的锁 —— 这是 PG 文档里的死锁形状，
   * 服务端在 deadlock_timeout 后必定中止其中一方并返回 40P01。未包装的重试（即旧行为）
   * 会让这一侧整体失败；包装后两侧都必须提交，且行数符合两次成功更新。
   */
  test("crossing transactions converge through the bounded retry", async () => {
    const postgres = (await import("postgres")).default;
    const { withOperationConflictRetry } = await import("./db-conflict-retry.js");

    const table = `deadlock_probe_${randomUUID().replaceAll("-", "")}`;
    const admin = postgres(testDatabaseUrl, { max: 1 });
    const left = postgres(testDatabaseUrl, { max: 1 });
    const right = postgres(testDatabaseUrl, { max: 1 });
    const redactedUrl = testDatabaseUrl!.replace(/:[^:@/]+@/u, ":***@");

    const conflicts: number[] = [];
    try {
      await admin.unsafe(`CREATE TABLE ${table} (id int PRIMARY KEY, v int NOT NULL)`);
      await admin.unsafe(`INSERT INTO ${table} (id, v) VALUES (1, 0), (2, 0)`);

      const crossUpdate = (conn: typeof left, first: number, second: number) =>
        withOperationConflictRetry(`deadlock_probe_${first}${second}`, () => conn.begin(async (tx) => {
          await tx.unsafe(`UPDATE ${table} SET v = v + 1 WHERE id = ${first}`);
          // 双方都先持锁再等待，构造确定性死锁窗口。
          await tx.unsafe("SELECT pg_sleep(0.6)");
          await tx.unsafe(`UPDATE ${table} SET v = v + 1 WHERE id = ${second}`);
        }), {
          baseDelayMs: 10,
          onConflict: (_error, attempt) => { conflicts.push(attempt); },
        });

      const [firstResult, secondResult] = await Promise.allSettled([
        crossUpdate(left, 1, 2),
        crossUpdate(right, 2, 1),
      ]);

      assert.equal(firstResult.status, "fulfilled", `left failed: ${String((firstResult as PromiseRejectedResult).reason ?? "")}`);
      assert.equal(secondResult.status, "fulfilled", `right failed: ${String((secondResult as PromiseRejectedResult).reason ?? "")}`);
      const rows = await admin.unsafe(`SELECT id, v FROM ${table} ORDER BY id`) as unknown as Array<{ id: number; v: number }>;
      assert.deepEqual(rows.map((row) => [Number(row.id), Number(row.v)]), [[1, 2], [2, 2]]);
      assert.ok(conflicts.length >= 1, "the deadlock must be observed and retried at least once");
    } finally {
      await admin.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await Promise.allSettled([admin.end({ timeout: 5 }), left.end({ timeout: 5 }), right.end({ timeout: 5 })]);
    }
    assert.ok(!redactedUrl.includes("://"), "database URL must never be printed");
  });
}