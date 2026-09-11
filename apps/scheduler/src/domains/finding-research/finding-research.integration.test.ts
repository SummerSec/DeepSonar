import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { FindingResearchJudgeError } from "./policy.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("finding research integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("semantic research merges, grows anchors, isolates verify, and records failures", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_research_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let endSql: (() => Promise<unknown>) | null = null;
    let closeApp: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";

      const [{ sql, migrate }, research, verifyModule, { default: Fastify }, { default: websocket }, { registerRoutes }] = await Promise.all([
        import("../../db.js"),
        import("./application.js"),
        import("../../verify.js"),
        import("fastify"),
        import("@fastify/websocket"),
        import("../../routes.js"),
      ]);
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const jobId = randomUUID();
      const firstId = randomUUID();
      const dupId = randomUUID();
      const xssId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'research')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'research task', ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'analysis_complete', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, location, summary, category, verify_status, created_at)
        VALUES
          (${firstId}, ${projectId}, ${jobId}, 'fp-sql-1', 'SQL injection in login handler', 'high', 'src/auth/login.ts:42', 'query concatenates input', 'injection', 'pending', ${"2026-09-11T00:00:00.000Z"}),
          (${dupId}, ${projectId}, ${jobId}, 'fp-sql-2', 'SQLi in the login form', 'medium', 'src/auth/login.ts:42', 'login form reaches the same query', 'injection', 'pending', ${"2026-09-11T00:01:00.000Z"}),
          (${xssId}, ${projectId}, ${jobId}, 'fp-xss-1', 'Reflected XSS in search', 'critical', 'src/search/view.ts:8', 'search term rendered raw', 'xss', 'pending', ${"2026-09-11T00:02:00.000Z"})`;

      const first = await research.runFindingResearch(sql, {
        canvasId,
        projectId,
        kind: "dedupe",
        batchLimit: 1,
      });
      assert.equal(first.status, "succeeded");
      const afterFirst = await sql`
        SELECT finding_id, is_canonical, canonical_finding_id, verify_status, severity
        FROM finding_research r
        JOIN findings f ON f.id = r.finding_id
        WHERE r.canvas_id = ${canvasId}`;
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0]?.is_canonical, true);
      assert.equal(afterFirst[0]?.finding_id, firstId);

      const grown = await research.runFindingResearch(sql, {
        canvasId,
        projectId,
        kind: "pipeline",
        batchLimit: 8,
      });
      assert.equal(grown.status, "succeeded");
      const rows = await sql`
        SELECT r.finding_id, r.is_canonical, r.canonical_finding_id, r.dedupe_cluster_id,
               r.dedupe_reason, r.priority_score, r.priority_reason, f.verify_status, f.severity
        FROM finding_research r
        JOIN findings f ON f.id = r.finding_id
        WHERE r.canvas_id = ${canvasId}
        ORDER BY f.created_at`;
      assert.equal(rows.length, 3);
      const byId = Object.fromEntries(rows.map((row) => [String(row.finding_id), row]));
      assert.equal(byId[firstId]?.is_canonical, true);
      assert.equal(byId[dupId]?.is_canonical, false);
      assert.equal(byId[dupId]?.canonical_finding_id, firstId);
      assert.equal(byId[dupId]?.dedupe_cluster_id, byId[firstId]?.dedupe_cluster_id);
      assert.ok(String(byId[dupId]?.dedupe_reason ?? "").length > 0);
      assert.equal(byId[xssId]?.is_canonical, true);
      assert.notEqual(byId[xssId]?.dedupe_cluster_id, byId[firstId]?.dedupe_cluster_id);
      assert.ok(Number(byId[xssId]?.priority_score) >= Number(byId[firstId]?.priority_score));
      assert.equal(byId[firstId]?.verify_status, "pending");
      assert.equal(byId[dupId]?.verify_status, "pending");
      assert.equal(byId[xssId]?.verify_status, "pending");
      assert.equal(byId[firstId]?.severity, "high");
      assert.equal(byId[dupId]?.severity, "medium");
      assert.equal(byId[xssId]?.severity, "critical");

      const gate = await verifyModule.evaluateAnalysisCompleteGate(sql, canvasId);
      assert.equal(gate.ok, false, "unconfirmed findings still block report after research");

      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();
      const list = await app.inject({ method: "GET", url: `/findings?canvas_id=${canvasId}` });
      assert.equal(list.statusCode, 200);
      const listed = list.json() as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const items = Array.isArray(listed) ? listed : listed.items ?? [];
      assert.equal(items.length, 3);
      const listedDup = items.find((item) => item.id === dupId);
      assert.equal(listedDup?.canonical_finding_id, firstId);
      assert.equal(listedDup?.verify_status, "pending");

      const detail = await app.inject({ method: "GET", url: `/findings/${dupId}` });
      assert.equal(detail.statusCode, 200);
      const body = detail.json() as {
        finding: { verify_status: string; severity: string };
        research: { canonical_finding_id: string; is_canonical: boolean };
        cluster_members: Array<{ finding_id: string }>;
      };
      assert.equal(body.finding.verify_status, "pending");
      assert.equal(body.finding.severity, "medium");
      assert.equal(body.research.canonical_finding_id, firstId);
      assert.equal(body.research.is_canonical, false);
      assert.ok(body.cluster_members.some((member) => member.finding_id === firstId));

      const ledger = await app.inject({ method: "GET", url: `/canvases/${canvasId}/finding-research` });
      assert.equal(ledger.statusCode, 200);
      assert.ok((ledger.json() as { runs: unknown[] }).runs.length >= 1);

      const lateId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, location, summary, category, verify_status)
        VALUES (${lateId}, ${projectId}, ${jobId}, 'fp-late', 'Late candidate kept on failure', 'high', 'src/late.ts:1', 'must remain', 'other', 'pending')`;
      const failed = await research.runFindingResearch(sql, {
        canvasId,
        projectId,
        kind: "dedupe",
        judge: {
          compare() {
            throw new FindingResearchJudgeError("anchor compare unavailable");
          },
        },
      });
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", /anchor compare unavailable/);
      const afterFail = await sql`SELECT id, verify_status, severity FROM findings WHERE project_id = ${projectId} ORDER BY created_at`;
      assert.equal(afterFail.length, 4);
      assert.ok(afterFail.some((row) => row.id === lateId));
      assert.deepEqual(afterFail.map((row) => row.verify_status), ["pending", "pending", "pending", "pending"]);
      const lateResearch = await sql`SELECT finding_id FROM finding_research WHERE finding_id = ${lateId}`;
      assert.equal(lateResearch.length, 0, "failed compare must not drop or auto-cluster the candidate");
      const failedRuns = await sql`SELECT status, error FROM finding_research_runs WHERE canvas_id = ${canvasId} AND status = 'failed'`;
      assert.ok(failedRuns.some((row) => String(row.error).includes("anchor compare unavailable")));

      const isolatedFindingId = randomUUID();
      const isolatedReportId = randomUUID();
      await sql`
        ALTER TABLE finding_research
        ADD CONSTRAINT finding_research_force_failure CHECK (false) NOT VALID`;
      try {
        const isolated = await sql.begin(async (tx) => {
          await tx`
            INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, location, summary, category, verify_status)
            VALUES (
              ${isolatedFindingId}, ${projectId}, ${jobId}, 'fp-research-savepoint',
              'Persistence failure must not roll back the finding', 'high', 'src/savepoint.ts:1',
              'outer writes stay committed', 'other', 'pending'
            )`;
          await tx`
            INSERT INTO task_reports (id, canvas_id, project_id, version, status, input_uri, input_sha256, summary_json)
            VALUES (
              ${isolatedReportId}, ${canvasId}, ${projectId}, 1, 'pending',
              'reports/research-savepoint/input.json', ${"a".repeat(64)}, ${tx.json({})}
            )`;
          const result = await research.runFindingResearchBestEffort(tx as unknown as typeof sql, {
            canvasId,
            projectId,
            kind: "pipeline",
          });
          return result;
        });
        assert.equal(isolated.status, "failed");
        assert.match(isolated.error ?? "", /finding_research_force_failure|check constraint/i);
      } finally {
        await sql`ALTER TABLE finding_research DROP CONSTRAINT IF EXISTS finding_research_force_failure`;
      }
      const [keptFinding] = await sql`SELECT id, verify_status, severity FROM findings WHERE id = ${isolatedFindingId}`;
      const [keptReport] = await sql`SELECT id, status FROM task_reports WHERE id = ${isolatedReportId}`;
      assert.equal(keptFinding?.id, isolatedFindingId, "Finding insert must commit after research SQL failure");
      assert.equal(keptFinding?.verify_status, "pending");
      assert.equal(keptFinding?.severity, "high");
      assert.equal(keptReport?.id, isolatedReportId, "task report insert must commit after research SQL failure");
      assert.equal(keptReport?.status, "pending");
      const isolatedCluster = await sql`SELECT finding_id FROM finding_research WHERE finding_id = ${isolatedFindingId}`;
      assert.equal(isolatedCluster.length, 0, "failed research persistence must not assign the candidate");
      const isolatedFailedRuns = await sql`
        SELECT status, error FROM finding_research_runs
        WHERE canvas_id = ${canvasId} AND status = 'failed'
        ORDER BY created_at DESC`;
      assert.ok(
        isolatedFailedRuns.some((row) => String(row.error).includes("finding_research_force_failure")
          || /check constraint/i.test(String(row.error))),
        "failed run ledger should still record after savepoint rollback",
      );
    } finally {
      if (closeApp) await closeApp().catch(() => {});
      if (endSql) await endSql().catch(() => {});
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
}
