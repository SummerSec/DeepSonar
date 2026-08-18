import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("atomic task creation PostgreSQL integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("task creation rolls snapshot failures back and commits complete compose tasks", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName =
      `deepsonar_task_create_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    const blobDir = path.resolve(
      process.cwd(),
      `data/task-create-${process.pid}-${Date.now()}`,
    );
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let authority: ReturnType<typeof postgres> | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "real";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.BLOB_STORE = "fs";
      process.env.BLOB_DIR = blobDir;

      const [
        { default: Fastify },
        websocketModule,
        dbModule,
        routesModule,
        runtimeImages,
        sharedAssets,
      ] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./runtime-images.js"),
        import("./domains/shared-assets/index.js"),
      ]);
      const { migrate, sql } = dbModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      authority = postgres(targetUrl.toString(), { max: 1 });
      const authoritySql = authority;

      const app = Fastify({ logger: false });
      await app.register(websocketModule.default);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID();
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (
          ${projectId},
          ${`task-create-${projectId}`},
          'atomic task create',
          ${sql.json({ rules: { allowEgress: false } } as never)}
        )`;

      const failed = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/tasks`,
        payload: {
          title: "must roll back",
          content: "No trusted Base runtime exists yet.",
        },
      });
      assert.equal(failed.statusCode, 409, failed.payload);
      assert.equal(
        failed.json().error_code,
        "RUNTIME_IMAGE_NO_TRUSTED_VERSION",
      );
      const [afterFailure] = await authoritySql`
        SELECT
          (SELECT COUNT(*)::int FROM canvases WHERE project_id = ${projectId}) AS canvases,
          (SELECT COUNT(*)::int FROM canvas_nodes n
             JOIN canvases c ON c.id = n.canvas_id
             WHERE c.project_id = ${projectId}) AS nodes,
          (SELECT COUNT(*)::int FROM jobs WHERE project_id = ${projectId}) AS jobs,
          (SELECT COUNT(*)::int FROM audit_logs
             WHERE project_id = ${projectId} AND action = 'task.create') AS audits`;
      assert.deepEqual(
        {
          canvases: Number(afterFailure.canvases),
          nodes: Number(afterFailure.nodes),
          jobs: Number(afterFailure.jobs),
          audits: Number(afterFailure.audits),
        },
        { canvases: 0, nodes: 0, jobs: 0, audits: 0 },
      );

      const [baseImage] = await sql`
        SELECT id FROM runtime_images WHERE image_key = 'deepsonar-base'`;
      const versionId = randomUUID();
      const digest = `sha256:${"a".repeat(64)}`;
      const imageRef =
        `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${digest}`;
      const hostPlatform = runtimeImages.hostRuntimePlatform();
      await sql`
        INSERT INTO runtime_image_versions (
          id, runtime_image_id, version, image_ref, resolved_ref, digest,
          platforms_json, trust_status, promoted_at
        ) VALUES (
          ${versionId}, ${baseImage.id as string}, 'issue-203', ${imageRef},
          ${imageRef}, ${digest}, ${sql.json([hostPlatform])}, 'trusted', now()
        )`;
      const [settings] = await sql`
        SELECT runtime_registry_channel FROM global_settings WHERE id = 'global'`;
      await sql`
        INSERT INTO runtime_image_version_refs (
          version_id, channel, image_ref, resolved_ref, digest, evidence_json
        ) VALUES (
          ${versionId}, ${settings.runtime_registry_channel as string}, ${imageRef},
          ${imageRef}, ${digest}, ${sql.json({ source: "issue-203-test" } as never)}
        )`;

      const sourceCanvasId = randomUUID();
      const sourceJobId = randomUUID();
      const findingId = randomUUID();
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (
          ${sourceCanvasId}, ${projectId}, 'source task',
          ${sql.json({ network_policy: { allow_egress: false } } as never)}
        )`;
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
        ) VALUES (
          ${sourceJobId}, ${projectId}, ${sourceCanvasId}, 'audit', 'succeeded',
          ${sql.json({} as never)}, ${sql.json({} as never)}
        )`;
      await sql`
        INSERT INTO findings (
          id, project_id, job_id, fingerprint, title, severity, summary,
          verify_status, disposition
        ) VALUES (
          ${findingId}, ${projectId}, ${sourceJobId}, ${`issue-203-${findingId}`},
          'Confirmed seed', 'high', 'Confirmed seed used by the atomic task test.',
          'confirmed', 'open'
        )`;
      const asset = await sharedAssets.createSharedAsset({
        scope: "project",
        projectId,
        key: "docs/atomic-task.md",
        contentType: "text/markdown",
        bytes: Buffer.from("# Atomic task asset\n"),
        origin: "human",
        actor: "issue-203-test",
      });

      const scheduledStartAt = "2099-08-20T00:00:00.000Z";
      const success = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/tasks`,
        payload: {
          title: "atomic compose task",
          content: "Preserve compose, schedule, network, and shared assets.",
          kind: "compose",
          seed_finding_ids: [findingId],
          allow_egress: true,
          scheduled_start_at: scheduledStartAt,
        },
      });
      assert.equal(success.statusCode, 201, success.payload);
      const response = success.json() as {
        canvas_id: string;
        job: { id: string; status: string };
        scheduled_start_at: string;
      };
      assert.equal(response.scheduled_start_at, scheduledStartAt);

      const [committed] = await authoritySql`
        SELECT c.target_json, j.id AS job_id, j.status AS job_status,
               j.priority, j.payload_json, j.agent_snapshot_json,
               (SELECT COUNT(*)::int FROM canvas_nodes n
                  WHERE n.canvas_id = c.id AND n.node_type = 'root') AS roots,
               (SELECT COUNT(*)::int FROM canvas_nodes n
                  WHERE n.canvas_id = c.id AND n.node_type = 'finding'
                    AND n.status = 'imported') AS seeds,
               (SELECT COUNT(*)::int FROM canvas_nodes n
                  WHERE n.canvas_id = c.id AND n.job_id = j.id
                    AND n.node_type = 'job') AS job_nodes,
               (SELECT COUNT(*)::int FROM canvas_edges e
                  JOIN canvas_nodes source ON source.id = e.from_node_id
                  JOIN canvas_nodes target ON target.id = e.to_node_id
                  WHERE e.canvas_id = c.id AND source.node_type = 'root'
                    AND target.job_id = j.id AND e.edge_type = 'child') AS entry_edges,
               (SELECT COUNT(*)::int FROM job_shared_asset_versions link
                  WHERE link.job_id = j.id AND link.version_id = ${asset.version_id}) AS asset_links,
               (SELECT COUNT(*)::int FROM audit_logs a
                  WHERE a.project_id = c.project_id AND a.action = 'task.create'
                    AND a.resource_id = j.id) AS audits
        FROM canvases c
        JOIN jobs j ON j.canvas_id = c.id AND j.type = 'hub_reason'
        WHERE c.id = ${response.canvas_id}`;
      assert.ok(committed, "201 must expose a fully committed task to another connection");
      assert.equal(committed.job_id, response.job.id);
      assert.equal(committed.job_status, "pending");
      assert.equal(Number(committed.roots), 1);
      assert.equal(Number(committed.seeds), 1);
      assert.equal(Number(committed.job_nodes), 1);
      assert.equal(Number(committed.entry_edges), 1);
      assert.equal(Number(committed.asset_links), 1);
      assert.equal(Number(committed.audits), 1);
      assert.deepEqual(committed.target_json.network_policy, { allow_egress: true });
      assert.equal(committed.target_json.kind, "compose");
      assert.deepEqual(committed.target_json.seed_finding_ids, [findingId]);
      assert.equal(committed.target_json.schedule.start_at, scheduledStartAt);
      assert.deepEqual(committed.payload_json.related_finding_ids, [findingId]);
      assert.equal(
        committed.agent_snapshot_json.network_policy.allow_egress,
        true,
      );

      await sql`
        UPDATE jobs
        SET status = 'failed', error = 'retry fixture', finished_at = now()
        WHERE id = ${response.job.id}`;
      const retry = await app.inject({
        method: "POST",
        url: `/tasks/${response.canvas_id}/retry`,
      });
      assert.equal(retry.statusCode, 201, retry.payload);
      const [afterRetry] = await authoritySql`
        SELECT c.target_json,
               (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS jobs,
               (SELECT COUNT(*)::int FROM canvas_nodes n
                  WHERE n.canvas_id = c.id AND n.node_type = 'finding'
                    AND n.status = 'imported') AS seeds,
               (SELECT COUNT(*)::int FROM canvas_nodes n
                  WHERE n.canvas_id = c.id AND n.node_type = 'job') AS job_nodes,
               (SELECT COUNT(*)::int FROM canvas_edges e
                  WHERE e.canvas_id = c.id AND e.edge_type = 'child') AS child_edges
        FROM canvases c WHERE c.id = ${response.canvas_id}`;
      assert.equal(Number(afterRetry.jobs), 1);
      assert.equal(Number(afterRetry.seeds), 1);
      assert.equal(Number(afterRetry.job_nodes), 1);
      assert.equal(Number(afterRetry.child_edges), 2);
      assert.deepEqual(afterRetry.target_json.network_policy, { allow_egress: true });
      assert.equal(afterRetry.target_json.schedule, undefined);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (authority) await authority.end({ timeout: 5 }).catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }
      await admin.end();
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}
