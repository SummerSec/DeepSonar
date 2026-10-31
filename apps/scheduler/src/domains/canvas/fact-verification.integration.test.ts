import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { declaredQuantitiesFromPayloads } from "../../report-numeric-fidelity.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Fact verification lifecycle integration requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("Fact 人工收口、非法迁移、权限、证据引用与报告门禁保持独立", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_fact_verify_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule, graphModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("../../db.js"),
        import("../../routes.js"),
        import("../../auth.js"),
        import("../../graph.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { generateToken } = authModule;
      const { buildGraphSnapshot } = graphModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, 'Fact verification', ${sql.json({
          rules: { hubEnabled: false, minVerifySeverity: "high" },
          roles: { enabled: ["review"] },
        })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Fact canvas', ${sql.json({ network_policy: { allow_egress: false } })})`;

      const originJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${originJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded',
          ${sql.json({ name: "audit", role_kind: "role", platform_tools: ["emit_finding"] })},
          ${sql.json({})}
        )`;
      const [findingNode] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${originJobId}, 'finding', 'High finding', 'open', ${sql.json({ severity: "high" })})
        RETURNING id`;
      const findingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary, raw_json, verify_status)
        VALUES (
          ${findingId}, ${projectId}, ${originJobId}, ${findingNode.id}, ${`fp-${findingId}`},
          'High finding', 'high', 'structured summary', ${sql.json({})}, 'verifying'
        )`;

      const reviewJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${reviewJobId}, ${projectId}, ${canvasId}, ${findingId}, 'review', 'succeeded',
          ${sql.json({ name: "review", role_kind: "role", platform_tools: ["emit_fact"] })},
          ${sql.json({ verification_followup: { finding_id: findingId, scheduler_owned: true } })}
        )`;

      const quantity = {
        value: 42,
        unit: "verified slots",
        basis: "human-closed evidence trust",
      };
      const ids = {
        unverified: randomUUID(),
        verifying: randomUUID(),
        needs_human: randomUUID(),
        verified: randomUUID(),
        rejected: randomUUID(),
        evidence: randomUUID(),
      };
      const evidenceBody = {
        description: "结构化复核证据",
        quantities: [quantity],
        verification: {
          finding_id: findingId,
          evidence_kind: "review",
          outcome: "supports",
          subject_revision: "app@abc123",
        },
      };
      await sql`
        INSERT INTO canvas_nodes (
          id, canvas_id, job_id, node_type, title, body_json, status, verification_status
        ) VALUES
          (${ids.unverified}, ${canvasId}, ${originJobId}, 'fact', 'Unverified fact', ${sql.json({ description: "plain", quantities: [quantity] })}, 'open', 'unverified'),
          (${ids.verifying}, ${canvasId}, ${originJobId}, 'fact', 'Verifying fact', ${sql.json({ description: "in progress", quantities: [quantity] })}, 'open', 'verifying'),
          (${ids.needs_human}, ${canvasId}, ${originJobId}, 'fact', 'Needs human fact', ${sql.json({ description: "ask human", quantities: [quantity] })}, 'open', 'needs_human'),
          (${ids.verified}, ${canvasId}, ${originJobId}, 'fact', 'Verified fact', ${sql.json({ description: "trusted", quantities: [quantity] })}, 'open', 'verified'),
          (${ids.rejected}, ${canvasId}, ${originJobId}, 'fact', 'Rejected fact', ${sql.json({ description: "excluded", quantities: [quantity] })}, 'open', 'rejected'),
          (${ids.evidence}, ${canvasId}, ${reviewJobId}, 'fact', 'Evidence fact', ${sql.json(evidenceBody)}, 'open', 'unverified')`;
      await sql`
        INSERT INTO canvas_edges (canvas_id, from_node_id, to_node_id, edge_type)
        VALUES (${canvasId}, ${findingNode.id}, ${ids.evidence}, 'reviewed_by')`;

      const reader = generateToken();
      const operator = generateToken();
      await sql`
        INSERT INTO api_tokens (name, token_prefix, token_hash, scopes)
        VALUES
          ('reader', ${reader.prefix}, ${reader.hash}, ${["tasks:read"]}),
          ('operator', ${operator.prefix}, ${operator.hash}, ${["tasks:read", "jobs:control"]})`;

      const auth = (token: string) => ({ authorization: `Bearer ${token}` });
      const patch = (nodeId: string, status: string, token: string, note?: string) =>
        app.inject({
          method: "PATCH",
          url: `/canvases/${canvasId}/facts/${nodeId}/verification`,
          headers: auth(token),
          payload: note ? { status, note } : { status },
        });

      const denied = await patch(ids.unverified, "verified", reader.plaintext, "viewer cannot close");
      assert.equal(denied.statusCode, 403, denied.payload);

      const closeUnverified = await patch(ids.unverified, "verified", operator.plaintext, "human close");
      assert.equal(closeUnverified.statusCode, 200, closeUnverified.payload);
      assert.equal(closeUnverified.json().fact.verification_status, "verified");

      const closeVerifying = await patch(ids.verifying, "rejected", operator.plaintext);
      assert.equal(closeVerifying.statusCode, 200, closeVerifying.payload);
      assert.equal(closeVerifying.json().fact.verification_status, "rejected");

      const closeNeedsHuman = await patch(ids.needs_human, "verified", operator.plaintext);
      assert.equal(closeNeedsHuman.statusCode, 200, closeNeedsHuman.payload);
      assert.equal(closeNeedsHuman.json().fact.verification_status, "verified");

      const revokeVerified = await patch(ids.verified, "rejected", operator.plaintext);
      assert.equal(revokeVerified.statusCode, 200, revokeVerified.payload);
      assert.equal(revokeVerified.json().fact.verification_status, "rejected");

      const illegal = await patch(ids.rejected, "verified", operator.plaintext);
      assert.equal(illegal.statusCode, 409, illegal.payload);
      assert.equal(illegal.json().error_code, "FACT_VERIFICATION_ILLEGAL_TRANSITION");
      const [stillRejected] = await sql`SELECT verification_status FROM canvas_nodes WHERE id = ${ids.rejected}`;
      assert.equal(stillRejected.verification_status, "rejected");

      const reopen = await patch(ids.rejected, "needs_human", operator.plaintext);
      assert.equal(reopen.statusCode, 200, reopen.payload);
      const afterReopen = await patch(ids.rejected, "verified", operator.plaintext);
      assert.equal(afterReopen.statusCode, 200, afterReopen.payload);
      assert.equal(afterReopen.json().fact.verification_status, "verified");

      const unverifiedWrite = await patch(ids.evidence, "unverified", operator.plaintext);
      assert.equal(unverifiedWrite.statusCode, 400, unverifiedWrite.payload);
      const verifyingWrite = await patch(ids.evidence, "verifying", operator.plaintext);
      assert.equal(verifyingWrite.statusCode, 400, verifyingWrite.payload);

      const evidenceClose = await patch(ids.evidence, "verified", operator.plaintext, "trust evidence");
      assert.equal(evidenceClose.statusCode, 200, evidenceClose.payload);
      const detail = await app.inject({
        method: "GET",
        url: `/canvases/${canvasId}/facts/${ids.evidence}`,
        headers: auth(reader.plaintext),
      });
      assert.equal(detail.statusCode, 200, detail.payload);
      const body = detail.json();
      assert.equal(body.fact.verification_status, "verified");
      assert.equal(body.fact.verification.finding_id, findingId);
      assert.equal(body.finding.id, findingId);
      assert.equal(body.finding.verify_status, "verifying");
      assert.equal(body.trace.edges.some((edge: { edge_type: string }) => edge.edge_type === "reviewed_by"), true);
      const [findingRow] = await sql`SELECT verify_status FROM findings WHERE id = ${findingId}`;
      assert.equal(findingRow.verify_status, "verifying", "Fact 收口不得改写 Finding 技术验证");

      const rows = await sql<{ id: string; verification_status: string; body_json: { quantities?: unknown } }[]>`
        SELECT id, verification_status, body_json FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'fact'`;
      const declared = declaredQuantitiesFromPayloads(
        [{ id: findingId, verify_status: "verifying", quantities: [quantity] }],
        rows.map((row) => ({
          id: row.id,
          verification_status: row.verification_status,
          quantities: row.body_json.quantities,
        })),
      );
      assert.deepEqual(new Set(declared.map((item) => item.source_id)), new Set([
        ids.unverified,
        ids.needs_human,
        ids.rejected,
        ids.evidence,
      ]));
      assert.equal(declared.some((item) => item.source_id === ids.verifying || item.source === "finding"), false);

      const hub = await buildGraphSnapshot(canvasId, "hub");
      assert.match(hub.yaml, /"verification_status":"verified"/);
      const report = await buildGraphSnapshot(canvasId, "report");
      assert.match(report.yaml, /fact_counts_by_verification_status/);
      assert.match(report.yaml, /fact_quantity_gate: "verified"/);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
