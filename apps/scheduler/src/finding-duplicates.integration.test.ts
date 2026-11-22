import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Finding 跨 canvas 重复候选与重复处置集成测试（设置 TEST_DATABASE_URL 后运行）", {
    skip: "未设置 TEST_DATABASE_URL，拒绝使用调度器默认数据库",
  }, () => {});
} else {
  test("重复候选只读、跨项目拒绝，duplicate 处置与去重口径可核对（#1206）", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_duplicates_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      const otherProjectId = randomUUID();
      const canvasA = randomUUID();
      const canvasB = randomUUID();
      const otherCanvas = randomUUID();
      const makeJob = async (id: string, canvasId: string, owner: string) => {
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
          VALUES (${id}, ${owner}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      };
      const jobA = randomUUID();
      const jobB = randomUUID();
      const jobOther = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, '重复候选集成项目')`;
      await sql`INSERT INTO projects (id, name) VALUES (${otherProjectId}, '另一个集成项目')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasA}, ${projectId}, '画布 A')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasB}, ${projectId}, '画布 B')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${otherCanvas}, ${otherProjectId}, '其它画布')`;
      await makeJob(jobA, canvasA, projectId);
      await makeJob(jobB, canvasB, projectId);
      await makeJob(jobOther, otherCanvas, otherProjectId);

      const shared = "0123456789abcdef";
      const f1 = randomUUID();
      const f2 = randomUUID();
      const f3 = randomUUID();
      const f4 = randomUUID();
      const insertFinding = async (id: string, owner: string, jobId: string, fingerprint: string, title: string, location: string) => {
        await sql`
          INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status, location)
          VALUES (${id}, ${owner}, ${jobId}, ${fingerprint}, ${title}, 'high', 'pending', ${location})`;
      };
      await insertFinding(f1, projectId, jobA, shared, "同一校验缺失", "/a/b/c");
      await insertFinding(f2, projectId, jobB, shared, "同一校验缺失（另一画布）", "/x/y/z");
      await insertFinding(f3, projectId, jobB, "fedcba9876543210", "安装期内存分配", "/a/b/c/d");
      await insertFinding(f4, otherProjectId, jobOther, shared, "其它项目的同名记录", "/a/b/c");

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('重复候选 Token', ${projectId}, ${token.prefix}, ${token.hash}, ${["findings:read", "findings:write"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const duplicates = await app.inject({ method: "GET", url: `/findings/${f1}/duplicates`, headers });
      assert.equal(duplicates.statusCode, 200, duplicates.payload);
      const body = duplicates.json() as { items: { id: string; match_reason: string }[]; project_id: string };
      assert.equal(body.project_id, projectId);
      const reasons = new Map(body.items.map((item) => [item.id, item.match_reason]));
      assert.equal(reasons.get(f2), "fingerprint_equal");
      assert.equal(reasons.get(f3), "location_prefix");
      assert.equal(reasons.has(f4), false, "跨项目记录不得进入候选");
      assert.equal(reasons.has(f1), false, "候选不得包含自身");

      const crossProject = await app.inject({ method: "GET", url: `/findings/${f1}/duplicates?project_id=${otherProjectId}`, headers });
      assert.equal(crossProject.statusCode, 403, crossProject.payload);
      assert.equal(crossProject.json().error_code, "CROSS_PROJECT_DUPLICATE_QUERY");

      const limited = await app.inject({ method: "GET", url: `/findings/${f1}/duplicates?limit=1`, headers });
      assert.equal(limited.statusCode, 200, limited.payload);
      assert.equal((limited.json() as { items: unknown[] }).items.length, 1);

      const dispose = (findingId: string, payload: Record<string, unknown>) => app.inject({
        method: "PATCH", url: `/findings/${findingId}/disposition`, headers, payload,
      });
      const missingTarget = await dispose(f2, { disposition: "duplicate" });
      assert.equal(missingTarget.statusCode, 400, missingTarget.payload);
      assert.equal(missingTarget.json().error_code, "DUPLICATE_TARGET_REQUIRED");
      const selfTarget = await dispose(f2, { disposition: "duplicate", duplicate_of: f2 });
      assert.equal(selfTarget.statusCode, 400, selfTarget.payload);
      assert.equal(selfTarget.json().error_code, "DUPLICATE_TARGET_SELF");
      const foreignTarget = await dispose(f2, { disposition: "duplicate", duplicate_of: f4 });
      const unknownTarget = await dispose(f2, { disposition: "duplicate", duplicate_of: randomUUID() });
      assert.equal(unknownTarget.statusCode, 400, unknownTarget.payload);
      assert.equal(unknownTarget.json().error_code, "DUPLICATE_TARGET_NOT_FOUND");
      assert.equal(foreignTarget.statusCode, unknownTarget.statusCode, foreignTarget.payload);
      assert.deepEqual(foreignTarget.json(), unknownTarget.json());
      const notAllowed = await dispose(f3, { disposition: "accepted", duplicate_of: f1 });
      assert.equal(notAllowed.statusCode, 400, notAllowed.payload);
      assert.equal(notAllowed.json().error_code, "DUPLICATE_TARGET_NOT_ALLOWED");
      const accepted = await dispose(f2, { disposition: "duplicate", duplicate_of: f1, note: "与 7349ffd9 同族" });
      assert.equal(accepted.statusCode, 200, accepted.payload);
      assert.equal(accepted.json().disposition, "duplicate");
      assert.equal(accepted.json().duplicate_of, f1);
      // 处置语义不变：不改写 verify_status
      assert.equal(accepted.json().verify_status, "pending");

      // 数据库约束兜底：duplicate 与 duplicate_of 必须成对
      await assert.rejects(
        sql`UPDATE findings SET disposition = 'duplicate', duplicate_of = NULL WHERE id = ${f3}`,
        /findings_duplicate_disposition_check/,
      );

      const summary = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary`, headers });
      assert.equal(summary.statusCode, 200, summary.payload);
      const summaryBody = summary.json() as {
        total: number;
        distinct_by_fingerprint: number;
        distinct_by_cluster: number;
        disposition: { key: string; count: number }[];
      };
      assert.equal(summaryBody.total, 3);
      assert.equal(summaryBody.distinct_by_fingerprint, 2, "同 fingerprint 跨 canvas 只计一个独立漏洞");
      assert.equal(summaryBody.distinct_by_cluster, 3, "没有 research 行时按记录计入 cluster 口径");
      const duplicateBucket = summaryBody.disposition.find((bucket) => bucket.key === "duplicate")?.count ?? 0;
      assert.equal(duplicateBucket, 1, "duplicate 单列一桶");

      const clusterId = randomUUID();
      await sql`INSERT INTO finding_dedupe_clusters (id, canvas_id, project_id, canonical_finding_id)
        VALUES (${clusterId}, ${canvasB}, ${projectId}, ${f3})`;
      await sql`INSERT INTO finding_research
        (finding_id, project_id, canvas_id, dedupe_cluster_id, canonical_finding_id, is_canonical)
        VALUES (${f3}, ${projectId}, ${canvasB}, ${clusterId}, ${f3}, true),
               (${f2}, ${projectId}, ${canvasB}, ${clusterId}, ${f3}, false)`;
      const clustered = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary`, headers });
      assert.equal(clustered.statusCode, 200, clustered.payload);
      assert.equal(clustered.json().distinct_by_cluster, 2, "同组主记录和成员只计一次");
      const memberOnly = await app.inject({
        method: "GET", url: `/projects/${projectId}/findings/summary?disposition=duplicate`, headers,
      });
      assert.equal(memberOnly.statusCode, 200, memberOnly.payload);
      assert.equal(memberOnly.json().total, 1);
      assert.equal(memberOnly.json().distinct_by_cluster, 1, "仅成员匹配时仍计入该组");

      const filtered = await app.inject({ method: "GET", url: `/findings?fingerprint=${shared}`, headers });
      assert.equal(filtered.statusCode, 200, filtered.payload);
      const filteredBody = filtered.json() as unknown;
      const filteredItems = Array.isArray(filteredBody) ? filteredBody as { id: string }[] : (filteredBody as { items: { id: string }[] }).items;
      assert.deepEqual(filteredItems.map((item) => item.id).sort(), [f1, f2].sort());
    } finally {
      await closeApp?.();
      await endSql?.();
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
}