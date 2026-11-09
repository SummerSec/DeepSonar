import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("waiting Job list and detail share current wait ownership and unresolved-effect advice", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `waiting_list_${process.pid}_${Date.now()}`;
  let endSql: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.AGENT_MODE = "fake";
    const [{ default: Fastify }, { sql, migrate }, { registerJobControlRoutes }, { createAttempt }] = await Promise.all([
      import("fastify"), import("../../db.js"), import("./routes.js"), import("../job-attempt/application.js"),
    ]);
    endSql = () => sql.end({ timeout: 5 });
    await migrate();
    const app = Fastify();
    registerJobControlRoutes(app);
    await app.ready();
    closeApp = () => app.close();
    const projectId = randomUUID();
    const canvasId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'waiting list test')`;
    await sql`INSERT INTO canvases(id,project_id,title) VALUES(${canvasId},${projectId},'waiting')`;
    const waiting: string[] = [];
    for (const kind of ["credential", "business_decision", "authorization"]) {
      const jobId = randomUUID();
      waiting.push(jobId);
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,lease_expires_at)
        VALUES(${jobId},${projectId},${canvasId},'hub_reason','waiting_human',${sql.json({ name: "hub_reason" })},now(),now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      // A persisted historical request remains readable without rewriting its payload.
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${jobId},${String(attempt.id)},${randomUUID()},1,'human',${sql.json({
          reason: "需要获准测试条件后再继续执行。", subject: { type: "platform_blocker", kind },
        })})`;
      if (kind === "authorization") {
        await sql`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,status)
          VALUES(${jobId},${String(attempt.id)},'external-unknown','agent_run','unknown')`;
      }
    }
    const pendingId = randomUUID();
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${pendingId},${projectId},${canvasId},'audit','pending',${sql.json({ name: "audit" })})`;
    const listed = await app.inject({ method: "GET", url: `/jobs?canvas_id=${canvasId}&limit=50` });
    assert.equal(listed.statusCode, 200, listed.body);
    const rows = listed.json().items as Array<Record<string, any>>;
    assert.equal(rows.length, 4);
    for (const jobId of waiting) {
      const detail = await app.inject({ method: "GET", url: `/jobs/${jobId}` });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.deepEqual(rows.find(row => row.id === jobId)?.execution_state, detail.json().job.execution_state);
    }
    assert.equal(rows.find(row => row.id === pendingId)?.execution_state, undefined);
    const credential = rows.find(row => row.id === waiting[0])!.execution_state;
    assert.equal(credential.wait_owner, "platform_administrator");
    assert.ok(credential.allowed_actions.includes("wait_for_platform"));
    assert.ok(rows.find(row => row.id === waiting[1])!.execution_state.allowed_actions.includes("wait_for_human"));
    const unresolved = rows.find(row => row.id === waiting[2])!.execution_state;
    assert.equal(unresolved.blocker, "effects_require_reconciliation");
    assert.deepEqual(unresolved.allowed_actions, ["reconcile_effects"]);
    const firstPage = await app.inject({ method: "GET", url: `/jobs?canvas_id=${canvasId}&limit=1` });
    assert.equal(firstPage.json().items.length, 1, "enrichment preserves paging");
    assert.equal(firstPage.json().has_more, true);
    const unpaged = await app.inject({ method: "GET", url: `/jobs?project_id=${projectId}` });
    assert.ok(Array.isArray(unpaged.json()), "unpaged response keeps its array contract");
    assert.equal(unpaged.json().filter((row: any) => row.execution_state).length, 3);
  } finally {
    if (closeApp) await closeApp().catch(() => undefined);
    if (endSql) await endSql().catch(() => undefined);
    if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
});
