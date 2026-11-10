import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("waiting classification and recovery diagnostics expose the #1036 A/D operator surface", { skip: !databaseUrl },
  async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `recovery_diagnostics_${process.pid}_${Date.now()}`;
    let endSql: (() => Promise<void>) | undefined;
    let closeApp: (() => Promise<unknown>) | null = null;
    let created = false;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const url = new URL(databaseUrl!);
      url.pathname = `/${databaseName}`;
      process.env.DATABASE_URL = url.toString();
      process.env.BLOB_DIR = "/tmp/recovery-diagnostics-blobs";
      process.env.AGENT_MODE = "fake";
      const [{ default: Fastify }, dbModule, routesModule, authModule, { createAttempt }, receiptModule] = await Promise.all([
        import("fastify"), import("../../db.js"), import("./routes.js"), import("../../auth.js"),
        import("../job-attempt/application.js"), import("../event-ingestion/completion-receipt.js"),
      ]);
      const { sql, migrate } = dbModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      app.addHook("onRequest", authModule.authHook);
      routesModule.registerJobControlRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID(), otherProjectId = randomUUID();
      const stoppedCanvas = randomUUID(), canvasId = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${projectId},'recovery diag'), (${otherProjectId},'other')`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES
        (${stoppedCanvas},${projectId},'stopped',${sql.json({ plan_objective: { status: "stopped" } })}),
        (${canvasId},${projectId},'normal',${sql.json({})})`;

      const authorizationJob = randomUUID(), businessJob = randomUUID(), stoppedJob = randomUUID(), silentJob = randomUUID();
      const runningJob = randomUUID(), otherProjectJob = randomUUID();
      const exhaustedJob = randomUUID(), spoofedJob = randomUUID();
      for (const [id, canvas] of [
        [authorizationJob, canvasId], [businessJob, canvasId], [stoppedJob, stoppedCanvas],
        [silentJob, canvasId], [runningJob, canvasId], [otherProjectJob, null],
        [exhaustedJob, canvasId], [spoofedJob, canvasId],
      ] as const) {
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,lease_expires_at)
          VALUES(${id},${id === otherProjectJob ? otherProjectId : projectId},${canvas},'audit',
          ${id === runningJob ? 'running' : 'waiting_human'},${sql.json({ name: 'audit' })},
          ${id === otherProjectJob ? null : sql`now()`},${id === otherProjectJob ? null : sql`now() + interval '1 hour'`})`;
      }
      const authorizationAttempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, authorizationJob));
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${authorizationJob},${String(authorizationAttempt.id)},${randomUUID()},1,'human',${sql.json({
          reason: `RECOVERY_TEST_REDACTIONS_NONSENSITIVE_${process.pid}`, subject: { type: "platform_blocker", kind: "authorization" },
        })})`;
      await sql`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,status,replay_policy)
        VALUES(${authorizationJob},${String(authorizationAttempt.id)},'diag-unknown-1','gateway_model_request','unknown','never')`;
      await sql`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,status,replay_policy)
        VALUES(${authorizationJob},${String(authorizationAttempt.id)},'diag-unknown-2','agent_run','effect_pending','never')`;
      const businessAttempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, businessJob));
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${businessJob},${String(businessAttempt.id)},${randomUUID()},1,'human',${sql.json({
          reason: `RECOVERY_TEST_REDACTIONS_NONSENSITIVE_${process.pid}`, subject: { type: "finding", kind: "business_decision" },
        })})`;

      // #1036 A: 达到 COMPLETION_REPAIR_LIMIT 的拒绝回执只有在满足内核身份
      // （事件 ID 派生 + event_dedup/Attempt 归属 + 4xx accepted:false）时才可判平台死路。
      const limit = receiptModule.COMPLETION_REPAIR_LIMIT;
      for (const [jobId, kernelValid] of [[exhaustedJob, true], [spoofedJob, false]] as const) {
        const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
        for (let index = 0; index < limit; index += 1) {
          const key = `diag-repair-${jobId}-${index}`;
          const eventId = kernelValid ? receiptModule.completionReceiptId(jobId, key) : randomUUID();
          const payload = {
            v: 1, operation: "mark_job_done", idempotency_key: key,
            input_digest: "a".repeat(64), snapshot_digest: "b".repeat(64), proposal_revision: index,
            attempt_id: String(attempt.id), repair_token_limit: null,
            status: "rejected", result: { statusCode: 409, body: { accepted: false } },
          };
          if (kernelValid) {
            await sql`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${jobId}) ON CONFLICT DO NOTHING`;
          }
          await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
            VALUES(${jobId},${String(attempt.id)},${eventId},${index + 1},'control_receipt',${sql.json(payload)})`;
        }
      }

      const adminToken = authModule.generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('diag-admin',NULL,${adminToken.prefix},${adminToken.hash},${["admin"]})`;
      const projectToken = authModule.generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('diag-project',${projectId},${projectToken.prefix},${projectToken.hash},${["jobs:read","jobs:control"]})`;
      // 项目内的 admin：用于证明多 project_id 时逐个做范围校验，而不是只看第一个。
      const scopedAdminToken = authModule.generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('diag-scoped-admin',${projectId},${scopedAdminToken.prefix},${scopedAdminToken.hash},${["admin"]})`;
      const scopedAdminHeaders = { authorization: `Bearer ${scopedAdminToken.plaintext}` };
      const adminHeaders = { authorization: `Bearer ${adminToken.plaintext}` };
      const projectHeaders = { authorization: `Bearer ${projectToken.plaintext}` };

      const list = await app.inject({ method: "GET", url: "/jobs/waiting-classification", headers: adminHeaders });
      assert.equal(list.statusCode, 200, list.body);
      const items = list.json().items as Array<Record<string, any>>;
      assert.equal(items.length, 7, "unfiltered: the six target-project waits plus the other-project wait; running stays outside");
      const byId = new Map(items.map((row) => [row.job_id, row] as const));
      assert.equal(byId.get(authorizationJob)?.category, "unknown_effects");
      assert.deepEqual(byId.get(authorizationJob)?.signals.unresolved_effect_kinds, ["agent_run", "gateway_model_request"],
        "kind list is sorted so the projection does not depend on array_agg order");
      assert.equal(byId.get(authorizationJob)?.signals.human_subject_kind, "authorization",
        "unknown effects win precedence, human signal stays populated");
      assert.equal(byId.get(businessJob)?.category, "human_decision");
      assert.equal(byId.get(stoppedJob)?.category, "confirmed_platform_dead_end");
      assert.equal(byId.get(stoppedJob)?.signals.plan_objective_stopped, true);
      assert.equal(byId.get(exhaustedJob)?.category, "confirmed_platform_dead_end",
        "内核身份齐全的连续拒绝回执才构成平台死路");
      assert.equal(byId.get(exhaustedJob)?.signals.rejected_completion_verified, true);
      assert.equal(byId.get(spoofedJob)?.category, "no_signal",
        "只有回执形状、没有 event_dedup/派生事件 ID/Attempt 归属时不得判死路");
      assert.equal(byId.get(spoofedJob)?.signals.rejected_completion_verified, false);
      assert.equal(byId.get(spoofedJob)?.signals.rejected_completion_count, limit);
      assert.equal(byId.get(silentJob)?.category, "no_signal");
      const serialized = list.body;
      assert.ok(!serialized.includes(`RECOVERY_TEST_REDACTIONS_NONSENSITIVE_${process.pid}`),
        "the diagnosis endpoint never echoes business payload text");
      assert.ok(!serialized.includes("reason"), "no payload fields (reason/title/message) leave the surface");

      const scoped = await app.inject({
        method: "GET", url: `/jobs/waiting-classification?project_id=${projectId}`, headers: adminHeaders,
      });
      assert.equal(scoped.statusCode, 200, scoped.body);
      const scopedItems = scoped.json().items as Array<Record<string, any>>;
      assert.equal(scopedItems.length, 6, "the six target-project waiting jobs stay, running/other-project excluded");
      assert.ok(scopedItems.every((row) => row.project_id === projectId),
        "?project_id is an inclusion filter: every returned row belongs to that project");
      assert.ok(!scopedItems.some((row) => row.job_id === otherProjectJob), "other-project job never appears");
      const inScopeAdmin = await app.inject({
        method: "GET", url: `/jobs/waiting-classification?project_id=${projectId}`, headers: scopedAdminHeaders,
      });
      assert.equal(inScopeAdmin.statusCode, 200, inScopeAdmin.body);
      const wrongProject = await app.inject({
        method: "GET", url: `/jobs/waiting-classification?project_id=${otherProjectId}`, headers: scopedAdminHeaders,
      });
      assert.equal(wrongProject.statusCode, 403, wrongProject.body);
      const multiProject = await app.inject({
        method: "GET", url: `/jobs/waiting-classification?project_id=${projectId},${otherProjectId}`, headers: scopedAdminHeaders,
      });
      assert.equal(multiProject.statusCode, 403, "every requested project id is scope-checked, not only the first");
      assert.equal(multiProject.json().error_code, "PROJECT_MISMATCH", multiProject.body);
      const filtered = await app.inject({
        method: "GET", url: "/jobs/waiting-classification?status=failed,timeout", headers: adminHeaders,
      });
      assert.equal(filtered.statusCode, 200, filtered.body);
      assert.equal((filtered.json().items as unknown[]).length, 0);
      const badStatus = await app.inject({
        method: "GET", url: "/jobs/waiting-classification?status=running", headers: adminHeaders,
      });
      assert.equal(badStatus.statusCode, 400, badStatus.body);
      const badLimit = await app.inject({
        method: "GET", url: "/jobs/waiting-classification?limit=0", headers: adminHeaders,
      });
      assert.equal(badLimit.statusCode, 400, badLimit.body);
      const forbidden = await app.inject({
        method: "GET", url: "/jobs/waiting-classification", headers: projectHeaders,
      });
      assert.equal(forbidden.statusCode, 403, forbidden.body);

      const detail = await app.inject({
        method: "GET", url: `/jobs/${authorizationJob}/recovery-diagnostics`, headers: adminHeaders,
      });
      assert.equal(detail.statusCode, 200, detail.body);
      const diagnostics = detail.json();
      assert.equal(diagnostics.classification.category, "unknown_effects");
      assert.equal(diagnostics.unresolved_effects.length, 2);
      assert.equal(diagnostics.unresolved_effects[0].status, "unknown");
      const settle = diagnostics.next_actions.find((a: { action: string }) => a.action === "settle_effect");
      assert.ok(settle);
      assert.ok((settle as { path: string }).path.includes(`/jobs/${authorizationJob}/effects/`));
      assert.equal(diagnostics.repair_budget, null, "no repair receipts inserted -> no budget row");

      const noEffects = await app.inject({
        method: "GET", url: `/jobs/${businessJob}/recovery-diagnostics`, headers: adminHeaders,
      });
      assert.equal(noEffects.statusCode, 200, noEffects.body);
      assert.equal((noEffects.json().classification as { category: string }).category, "human_decision");
      assert.equal((noEffects.json().unresolved_effects as unknown[]).length, 0);
      const missing = await app.inject({
        method: "GET", url: `/jobs/${randomUUID()}/recovery-diagnostics`, headers: adminHeaders,
      });
      assert.equal(missing.statusCode, 404, missing.body);
      const disabled = await app.inject({
        method: "GET", url: `/jobs/${authorizationJob}/recovery-diagnostics`, headers: projectHeaders,
      });
      assert.equal(disabled.statusCode, 403, disabled.body);
      const anonymous = await app.inject({ method: "GET", url: `/jobs/${authorizationJob}/recovery-diagnostics` });
      assert.equal(anonymous.statusCode, 401, anonymous.body);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });
