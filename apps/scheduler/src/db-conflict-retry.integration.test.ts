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
  });

  test("#945 Verify terminal recovery rolls back a late SQL conflict and closes exactly once", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { sql, migrate } = await import("./db.js");
    const { recoverVerifyJobTerminal } = await import("./core.js");
    await migrate();
    const projectId = randomUUID(), canvasId = randomUUID();
    const originId = randomUUID(), findingId = randomUUID(), verifyId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const sequence = `verify_retry_${suffix}`, trigger = `verify_retry_${suffix}`, fn = `verify_retry_fn_${suffix}`;
    try {
      await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'terminal retry fixture',${sql.json({ rules: { maxVerificationRounds: 1 } })})`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'terminal retry fixture',${sql.json({})})`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,payload_json,agent_snapshot_json)
        VALUES(${originId},${projectId},${canvasId},'audit','succeeded',${sql.json({})},${sql.json({})})`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,severity,verify_status,raw_json)
        VALUES(${findingId},${projectId},${originId},${findingId},'terminal retry finding','high','pending',${sql.json({})})`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,finding_id,payload_json,agent_snapshot_json)
        VALUES(${verifyId},${projectId},${canvasId},'verify_finding','failed',${findingId},${sql.json({})},${sql.json({})})`;
      await sql`INSERT INTO finding_verification_rounds(finding_id,attempt,verify_job_id,status,requirements_json,evidence_snapshot_json)
        VALUES(${findingId},1,${verifyId},'running',${sql.json({})},${sql.json({})})`;
      await sql.unsafe(`CREATE SEQUENCE ${sequence}`);
      await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.verify_job_id = '${verifyId}' AND nextval('${sequence}') = 1 THEN
          RAISE EXCEPTION 'injected terminal serialization conflict' USING ERRCODE = '40001';
        END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON finding_verification_rounds FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      await recoverVerifyJobTerminal(verifyId, "failed", "terminal fixture failure");
      assert.equal(Number((await sql.unsafe(`SELECT last_value FROM ${sequence}`))[0].last_value), 2);
      const before = [...await sql`SELECT * FROM finding_verification_rounds WHERE verify_job_id=${verifyId}`];
      assert.equal(before.length, 1);
      assert.equal(before[0].status, "failed");
      assert.ok(before[0].finished_at);
      await recoverVerifyJobTerminal(verifyId, "failed", "duplicate terminal callback");
      assert.deepEqual([...await sql`SELECT * FROM finding_verification_rounds WHERE verify_job_id=${verifyId}`], before);
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=${verifyId}`)[0].n, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_attempt_effects WHERE job_id=${verifyId}`)[0].n, 0);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON finding_verification_rounds`).catch(() => {});
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {});
      await sql.unsafe(`DROP SEQUENCE IF EXISTS ${sequence}`).catch(() => {});
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id=${findingId}`;
      await sql`DELETE FROM events WHERE job_id=ANY(${[originId, verifyId]})`;
      await sql`DELETE FROM jobs WHERE id=${verifyId}`;
      await sql`DELETE FROM findings WHERE id=${findingId}`;
      await sql`DELETE FROM jobs WHERE id=${originId}`;
      await sql`DELETE FROM canvases WHERE id=${canvasId}`;
      const { deleteProjectsLeavingAuditShells } = await import("./test-project-teardown.js");
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql.end({ timeout: 5 });
    }
  });
}