import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("project reports aggregation requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("GET /projects/:id/reports groups task versions and confirmed Finding reports", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./db.js"),
      import("./routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const canvasA = randomUUID();
    const canvasB = randomUUID();
    const otherCanvas = randomUUID();
    const jobA = randomUUID();
    const jobB = randomUUID();
    const findingA = randomUUID();
    const findingPending = randomUUID();
    const findingB = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'report agg'), (${otherProjectId}, 'other')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES
        (${canvasA}, ${projectId}, '任务 A', ${sql.json({ kind: "standard", goal: "a" })}),
        (${canvasB}, ${projectId}, '任务 B', ${sql.json({ kind: "compose", goal: "b" })}),
        (${otherCanvas}, ${otherProjectId}, '外人', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES
          (${jobA}, ${projectId}, ${canvasA}, 'audit', 'succeeded', ${sql.json({})}),
          (${jobB}, ${projectId}, ${canvasB}, 'audit', 'succeeded', ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES
          (${findingA}, ${projectId}, ${jobA}, ${`fp-a-${findingA}`}, 'Confirmed A', 'high', 'confirmed'),
          (${findingPending}, ${projectId}, ${jobA}, ${`fp-p-${findingPending}`}, 'Still pending', 'low', 'pending'),
          (${findingB}, ${projectId}, ${jobB}, ${`fp-b-${findingB}`}, 'Confirmed B', 'medium', 'confirmed')`;
      await sql`
        INSERT INTO task_reports (canvas_id, project_id, version, status, input_uri, input_sha256, summary_json)
        VALUES
          (${canvasA}, ${projectId}, 1, 'succeeded', 'reports/a/v1/input.json', ${"1".repeat(64)}, ${sql.json({ confirmed_count: 1 })}),
          (${canvasA}, ${projectId}, 2, 'generating', 'reports/a/v2/input.json', ${"2".repeat(64)}, ${sql.json({})})`;
      await sql`
        INSERT INTO finding_reports (
          finding_id, canvas_id, project_id, version, status, input_uri, input_sha256, summary_json
        ) VALUES
          (${findingA}, ${canvasA}, ${projectId}, 1, 'succeeded', 'fr/a/v1.json', ${"a".repeat(64)}, ${sql.json({ generated_at: "2026-09-01T00:00:00Z" })}),
          (${findingA}, ${canvasA}, ${projectId}, 2, 'succeeded', 'fr/a/v2.json', ${"b".repeat(64)}, ${sql.json({ generated_at: "2026-09-02T00:00:00Z" })})`;

      const missing = await app.inject({ method: "GET", url: `/projects/${randomUUID()}/reports` });
      assert.equal(missing.statusCode, 404);

      const badCanvas = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/reports?canvas_id=${otherCanvas}`,
      });
      assert.equal(badCanvas.statusCode, 404);

      const scoped = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/reports?canvas_id=${canvasA}`,
      });
      assert.equal(scoped.statusCode, 200, scoped.payload);
      const scopedBody = scoped.json();
      assert.equal(scopedBody.project_id, projectId);
      assert.equal(scopedBody.tasks.length, 1);
      assert.equal(scopedBody.tasks[0].canvas_id, canvasA);
      assert.deepEqual(scopedBody.tasks[0].task_reports.map((row: { version: number }) => row.version), [2, 1]);
      assert.equal(scopedBody.tasks[0].finding_reports.length, 1);
      assert.equal(scopedBody.tasks[0].finding_reports[0].finding_id, findingA);
      assert.equal(scopedBody.tasks[0].finding_reports[0].report.version, 2);

      const all = await app.inject({ method: "GET", url: `/projects/${projectId}/reports` });
      assert.equal(all.statusCode, 200, all.payload);
      const body = all.json();
      assert.equal(body.tasks.length, 2);
      const taskA = body.tasks.find((task: { canvas_id: string }) => task.canvas_id === canvasA);
      const taskB = body.tasks.find((task: { canvas_id: string }) => task.canvas_id === canvasB);
      assert.equal(taskA.kind, "standard");
      assert.equal(taskB.kind, "compose");
      assert.equal(taskA.task_reports.length, 2);
      assert.equal(taskB.task_reports.length, 0);
      assert.equal(taskB.finding_reports.length, 1);
      assert.equal(taskB.finding_reports[0].finding_id, findingB);
      assert.equal(taskB.finding_reports[0].report, null);
      assert.equal(
        body.tasks.some((task: { finding_reports: { title: string }[] }) =>
          task.finding_reports.some((row) => row.title === "Still pending"),
        ),
        false,
      );
    } finally {
      await sql`DELETE FROM finding_reports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM task_reports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await sql`DELETE FROM canvases WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await deleteProjectsLeavingAuditShells(sql, [projectId, otherProjectId]);
      await app.close();
    }
  });

  test("#1256 报告只取可见版本的知识引用，且正文不带可识别元数据", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ migrate, sql }, { buildReportInput, renderKnowledgeRefsSection }, { CLOSEOUT_EVALUATION_PREFIX }] = await Promise.all([
      import("./db.js"),
      import("./report.js"),
      import("./domains/project-knowledge/closeout-evaluation-key.js"),
    ]);
    await migrate();
    const projectId = randomUUID();
    const canvasId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const hashes = ["1", "2", "3"].map((seed) => seed.repeat(64));
    const activeItem = randomUUID(), activeVersion = randomUUID();
    const revokedItem = randomUUID(), revokedVersion = randomUUID();
    const privateItem = randomUUID(), privateVersion = randomUUID();
    const workId = randomUUID(), proposalId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'report knowledge')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, '知识任务', ${sql.json({ kind: "standard", goal: "g" })})`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json) VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})})`;
      await sql`INSERT INTO job_attempts (id, job_id, attempt_no, status, phase) VALUES (${attemptId}, ${jobId}, 1, 'active', 'agent.ready')`;
      for (const [index, hash] of hashes.entries()) {
        const payload = Buffer.from(JSON.stringify({ kind: "memory", content: `c${index}` }), "utf8");
        await sql`INSERT INTO shared_asset_blobs (content_sha256, bytes, content_type, blob_uri)
          VALUES (${hash}, ${payload.length}, 'application/json', ${`test://${hash}`})`;
      }
      for (const [item, version, hash, title] of [
        [activeItem, activeVersion, hashes[0], "可见知识标题"],
        [revokedItem, revokedVersion, hashes[1], "已撤权知识标题"],
        [privateItem, privateVersion, hashes[2], "私有评测知识标题"],
      ] as const) {
        await sql`INSERT INTO project_knowledge_items (id, project_id, kind, logical_key, title)
          VALUES (${item}, ${projectId}, 'memory', ${`k-${item}`}, ${title})`;
        await sql`INSERT INTO project_knowledge_versions (id, project_id, item_id, version, content_sha256,
          creator_job_id, creator_attempt_id, sources_json, governance_hash)
          VALUES (${version}, ${projectId}, ${item}, 1, ${hash}, ${jobId}, ${attemptId}, '[]', ${hash})`;
        await sql`UPDATE project_knowledge_items SET active_version_id=${version}, status='active' WHERE id=${item}`;
        await sql`INSERT INTO project_knowledge_usages (project_id, job_id, attempt_id, selector, content_sha256,
          owner_project_id, version_id, feedback_json)
          VALUES (${projectId}, ${jobId}, ${attemptId}, ${`sel-${item}`}, ${hash}, ${projectId}, ${version},
            ${sql.json({ outcome: "success" })})`;
      }
      await sql`UPDATE project_knowledge_versions SET revoked_at=now(), revoked_reason='security' WHERE id=${revokedVersion}`;
      await sql`INSERT INTO project_knowledge_work (id, project_id, trigger_key, governance_hash)
        VALUES (${workId}, ${projectId}, ${`${CLOSEOUT_EVALUATION_PREFIX}root:fp`}, ${"a".repeat(64)})`;
      await sql`INSERT INTO project_knowledge_proposals (id, project_id, work_id, action, revision, candidate_version_id,
        maker_job_id, idempotency_key, request_digest, input_digest, reason)
        VALUES (${proposalId}, ${projectId}, ${workId}, 'create', 1, ${privateVersion}, ${jobId}, ${randomUUID()},
          ${"b".repeat(64)}, ${"c".repeat(64)}, 'test')`;

      const input = await buildReportInput(canvasId, sql);
      const refs = input.knowledge_refs ?? [];
      assert.deepEqual(refs.map((ref) => ref.version_id), [activeVersion],
        "撤销与评测私有版本不得进入报告引用");
      assert.equal(refs[0]?.reads, 1);
      assert.equal(refs[0]?.outcome, "success");
      const section = renderKnowledgeRefsSection(refs);
      assert.match(section, /共读取 1 个知识版本/u);
      assert.match(section, /其中 1 个版本有显式反馈/u);
      for (const needle of ["可见知识标题", "已撤权知识标题", "私有评测知识标题", hashes[0]!.slice(0, 12), activeItem, activeVersion]) {
        assert.ok(!section.includes(needle), `正文不得包含可识别元数据：${needle}`);
      }
    } finally {
      await sql`DELETE FROM project_knowledge_proposals WHERE project_id=${projectId}`;
      await sql`DELETE FROM project_knowledge_work WHERE project_id=${projectId}`;
      await sql`DELETE FROM project_knowledge_usages WHERE project_id=${projectId}`;
      // 版本引用条目与 blob：先删版本再删条目，否则外键拒绝。
      await sql`DELETE FROM project_knowledge_versions WHERE project_id=${projectId}`;
      await sql`DELETE FROM project_knowledge_items WHERE project_id=${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id=${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id=${projectId}`;
      await sql`DELETE FROM shared_asset_blobs WHERE content_sha256 = ANY(${hashes}::text[])`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
    }
  });
}
