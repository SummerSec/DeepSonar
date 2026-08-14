import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Finding 人工收口集成测试（设置 TEST_DATABASE_URL 后运行）", {
    skip: "未设置 TEST_DATABASE_URL，拒绝使用调度器默认数据库",
  }, () => {});
} else {
  test("人工 needs_human 收口与 Hub 恢复保持同一事务", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_human_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let stopListening: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { sql, migrate } = dbModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const sourceJobId = randomUUID();
      const findingId = randomUUID();
      const hubJobId = randomUUID();
      const hubNodeId = randomUUID();
      const findingNodeId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, '人工收口集成项目')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, '人工收口集成画布')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${sourceJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES (${findingNodeId}, ${canvasId}, 'finding', '待人工 Finding', 'verifying', ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, verify_status)
        VALUES (${findingId}, ${projectId}, ${sourceJobId}, ${findingNodeId}, ${`human-${findingId}`}, '待人工 Finding', 'high', 'verifying')`;
      await sql`
        INSERT INTO finding_verification_rounds (finding_id, attempt, status, requirements_json)
        VALUES (${findingId}, 1, 'pending', ${sql.json({ eligibility: 'waiting_evidence' })})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${hubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'waiting_human', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${hubNodeId}, ${canvasId}, ${hubJobId}, 'job', '等待人工 Hub', 'waiting_human', ${sql.json({ type: 'hub_reason' })})`;

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('人工收口项目 Token', ${projectId}, ${token.prefix}, ${token.hash}, ${['findings:write']})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      let notified = false;
      let resolveNotification!: () => void;
      const notification = new Promise<void>((resolve) => {
        resolveNotification = resolve;
      });
      const listener = await sql.listen("deepsonar_jobs", (payload) => {
        if (payload === "finding_needs_human") {
          notified = true;
          resolveNotification();
        }
      });
      stopListening = async () => {
        await listener.unlisten();
      };
      const response = await app.inject({
        method: "PATCH",
        url: `/findings/${findingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human", reason: "集成测试人工判断" },
      });
      assert.equal(response.statusCode, 200, response.payload);
      await Promise.race([
        notification,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      assert.equal(notified, true, "人工收口应在提交事务后通知 dispatcher");

      const [settledFinding] = await sql`SELECT verify_status FROM findings WHERE id = ${findingId}`;
      assert.equal(settledFinding.verify_status, "needs_human");
      const [settledRound] = await sql`
        SELECT status, final_outcome FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
      assert.equal(settledRound.status, "needs_human");
      assert.equal(settledRound.final_outcome, "needs_human");
      const [blocker] = await sql`
        SELECT body_json, status FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'human'
          AND body_json->>'finding_id' = ${findingId}`;
      assert.equal(blocker.status, "open");
      assert.equal((blocker.body_json as Record<string, unknown>).kind, "verification_blocker");
      const [resumedHub] = await sql`SELECT status FROM jobs WHERE id = ${hubJobId}`;
      assert.equal(resumedHub.status, "pending");
      const [resumedHubNode] = await sql`SELECT status FROM canvas_nodes WHERE id = ${hubNodeId}`;
      assert.equal(resumedHubNode.status, "pending");

      const confirmedFindingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${confirmedFindingId}, ${projectId}, ${sourceJobId}, ${`confirmed-${confirmedFindingId}`}, '已确认 Finding', 'high', 'confirmed')`;
      const confirmedResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${confirmedFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(confirmedResponse.statusCode, 409);
      const [confirmedState] = await sql`SELECT verify_status FROM findings WHERE id = ${confirmedFindingId}`;
      assert.equal(confirmedState.verify_status, "confirmed");

      const noHubFindingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${noHubFindingId}, ${projectId}, ${sourceJobId}, ${`no-hub-${noHubFindingId}`}, '无 Hub Finding', 'high', 'verifying')`;
      const noHubResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${noHubFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(noHubResponse.statusCode, 409);
      const [noHubState] = await sql`SELECT verify_status FROM findings WHERE id = ${noHubFindingId}`;
      assert.equal(noHubState.verify_status, "verifying");

      const otherProjectId = randomUUID();
      const otherCanvasId = randomUUID();
      const otherSourceJobId = randomUUID();
      const otherFindingId = randomUUID();
      const otherHubJobId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${otherProjectId}, ${otherCanvasId}, '越权测试项目')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${otherCanvasId}, ${otherProjectId}, '越权测试画布')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES
          (${otherSourceJobId}, ${otherProjectId}, ${otherCanvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})}),
          (${otherHubJobId}, ${otherProjectId}, ${otherCanvasId}, 'hub_reason', 'waiting_human', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${otherFindingId}, ${otherProjectId}, ${otherSourceJobId}, ${`other-${otherFindingId}`}, '其它项目 Finding', 'high', 'verifying')`;
      const scopeResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${otherFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(scopeResponse.statusCode, 403);
      const [scopeFinding] = await sql`SELECT verify_status FROM findings WHERE id = ${otherFindingId}`;
      const [scopeHub] = await sql`SELECT status FROM jobs WHERE id = ${otherHubJobId}`;
      assert.equal(scopeFinding.verify_status, "verifying");
      assert.equal(scopeHub.status, "waiting_human");
    } finally {
      if (stopListening) await stopListening().catch(() => undefined);
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
