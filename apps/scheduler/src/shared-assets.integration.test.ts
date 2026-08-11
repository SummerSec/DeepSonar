import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("shared asset integration requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("shared assets enforce scope, immutable versions, CAS, audit, and frozen Job references", async () => {
    const adminUrl = new URL(testDatabaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_shared_assets_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl); targetUrl.pathname = `/${databaseName}`; targetUrl.search = "";
    const blobDir = path.resolve(process.cwd(), `data/shared-assets-test-${process.pid}-${Date.now()}`);
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`); databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.BLOB_DIR = blobDir;
      process.env.BLOB_STORE = "fs";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_ADMIN_TOKEN = "issue41-admin";
      process.env.AGENT_MODE = "fake";
      const [{ default: Fastify }, websocketModule, dbModule, routesModule, authModule, sharedModule, coreModule, blobStoreModule] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"), import("./auth.js"), import("./domains/shared-assets/index.js"), import("./core.js"), import("./blob-store/index.js"),
      ]);
      blobStoreModule.resetSharedAssetBlobStoreForTests();
      const { sql, migrate } = dbModule; endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      app.addHook("onRequest", authModule.authHook);
      await app.register(websocketModule.default); routesModule.registerRoutes(app); await app.ready(); closeApp = () => app.close();

      const projectId = randomUUID(), otherProjectId = randomUUID();
      const canvasId = randomUUID(), otherCanvasId = randomUUID(), jobId = randomUUID(), agentJobId = randomUUID(), findingId = randomUUID();
      await sql`INSERT INTO projects (id,canvas_id,name) VALUES (${projectId},${canvasId},'assets'),(${otherProjectId},${otherCanvasId},'other')`;
      await sql`INSERT INTO canvases (id,project_id,title,target_json) VALUES (${canvasId},${projectId},'assets',${sql.json({ network_policy: { allow_egress: false } })}),(${otherCanvasId},${otherProjectId},'other',${sql.json({})})`;
      await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES
        (${jobId},${projectId},${canvasId},'audit','succeeded',${sql.json({})}),
        (${agentJobId},${projectId},${canvasId},'audit','running',${sql.json({})})`;
      await sql`UPDATE jobs SET sandbox_id=${"issue41-agent-sandbox"}, lease_expires_at=now() + interval '10 minutes' WHERE id=${agentJobId}`;
      await sql`INSERT INTO findings (id,project_id,job_id,fingerprint,title) VALUES (${findingId},${projectId},${jobId},'asset-finding','Asset finding')`;

      const token = authModule.generateToken();
      await sql`INSERT INTO api_tokens (name,project_id,token_prefix,token_hash,scopes) VALUES ('assets-project',${projectId},${token.prefix},${token.hash},${["assets:read","assets:write"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}`, "content-type": "application/octet-stream", "x-asset-key": "scripts/reproduce.sh", "x-asset-content-type": "text/plain", "x-asset-labels": JSON.stringify({ kind: "script" }) };
      const firstBytes = Buffer.from("#!/bin/sh\necho first\n");
      const upload = await app.inject({ method: "POST", url: `/projects/${projectId}/shared-assets`, headers, payload: firstBytes });
      assert.equal(upload.statusCode, 201, upload.payload);
      const first = upload.json() as { id: string; version_id: string; content_sha256: string };
      assert.equal(first.content_sha256, createHash("sha256").update(firstBytes).digest("hex"));
      assert.equal((await app.inject({ method: "POST", url: `/projects/${projectId}/shared-assets`, headers, payload: firstBytes })).statusCode, 409);
      const invalidBody = await app.inject({ method: "POST", url: `/projects/${projectId}/shared-assets`, headers: { ...headers, "content-type": "application/json", "x-asset-key": "docs/not-binary.json" }, payload: { injected: true } });
      assert.equal(invalidBody.statusCode, 400, invalidBody.payload);
      assert.equal(invalidBody.json().error, "asset_upload_body_required");

      const findingUpload = await app.inject({ method: "POST", url: `/findings/${findingId}/shared-assets`, headers: { ...headers, "x-asset-key": "poc/request.txt" }, payload: Buffer.from("GET /private") });
      assert.equal(findingUpload.statusCode, 201, findingUpload.payload);
      const findingVersionId = (findingUpload.json() as { version_id: string }).version_id;
      assert.equal((await app.inject({ method: "GET", url: `/findings/${findingId}/shared-assets`, headers: { authorization: `Bearer ${token.plaintext}` } })).json().items.length, 1);

      const platformUpload = await app.inject({ method: "POST", url: "/platform/shared-assets", headers: { authorization: "Bearer issue41-admin", "content-type": "application/octet-stream", "x-asset-key": "docs/baseline.md", "x-asset-content-type": "text/markdown" }, payload: Buffer.from("baseline") });
      assert.equal(platformUpload.statusCode, 201, platformUpload.payload);
      await app.inject({ method: "PATCH", url: `/projects/${projectId}/shared-assets/policy`, headers: { authorization: `Bearer ${token.plaintext}`, "content-type": "application/json" }, payload: { platform_enabled: true } });
      await coreModule.assertJobCanPublishSharedAsset(agentJobId, "issue41-agent-sandbox");

      const relatedJob = await coreModule.createJob({
        projectId,
        canvasId,
        type: "audit",
        payload: { related_finding_ids: [findingId] },
      });
      assert.ok(relatedJob.job);
      const relatedRefs = await sql`SELECT version_id FROM job_shared_asset_versions WHERE job_id=${relatedJob.job.id as string}`;
      assert.ok(relatedRefs.some((row) => row.version_id === findingVersionId));

      await assert.rejects(
        sharedModule.createSharedAsset({ scope: "project", projectId, key: "scripts/reproduce.sh", contentType: "text/plain", bytes: Buffer.from("poison"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId }),
        /immutable_asset_key_exists/,
      );
      const agentFirst = await sharedModule.createSharedAsset({ scope: "project", projectId, key: "dist/build.jar", contentType: "application/java-archive", bytes: Buffer.from("agent-v1"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId });

      const frozen = await sharedModule.resolveSharedAssetSelection(sql, projectId, [findingId]);
      assert.deepEqual(new Set(frozen.assets.map((asset) => asset.scope)), new Set(["platform", "project", "finding"]));
      assert.ok(frozen.assets.every((asset) => !asset.mount_path.includes("..")));
      assert.deepEqual(frozen.assets.find((asset) => asset.key === "scripts/reproduce.sh")?.labels, { kind: "script" });
      const frozenSnapshot = JSON.parse(JSON.stringify({ shared_assets_revision: frozen.revision, shared_assets: frozen.assets }));
      const [frozenJob] = await sql`INSERT INTO jobs (project_id,canvas_id,finding_id,type,status,agent_snapshot_json) VALUES (${projectId},${canvasId},${findingId},'test','pending',${sql.json(frozenSnapshot)}) RETURNING id`;
      await sharedModule.recordJobSharedAssets(sql, frozenJob.id as string, frozen.assets);

      const second = await sharedModule.createSharedAsset({ scope: "project", projectId, key: "dist/build.jar", contentType: "application/java-archive", bytes: Buffer.from("agent-v2"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId });
      assert.equal(second.current_version, 2);
      const duplicate = await sharedModule.createSharedAsset({ scope: "project", projectId, key: "dist/build.jar", contentType: "application/java-archive", bytes: Buffer.from("agent-v2"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId });
      assert.equal(duplicate.current_version, 2);
      assert.equal(duplicate.version_id, second.version_id);
      assert.equal(duplicate.content_sha256, second.content_sha256);
      assert.equal((await sql`SELECT count(*)::int AS count FROM shared_asset_versions WHERE asset_id=${second.id as string}`)[0].count, 2);
      await assert.rejects(
        sharedModule.createSharedAsset({ scope: "project", projectId, key: "dist/build.jar", contentType: "application/java-archive", bytes: Buffer.from("agent-v1"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId }),
        /asset_content_version_exists/,
      );
      assert.equal((await sql`SELECT count(*)::int AS count FROM shared_asset_versions WHERE asset_id=${second.id as string}`)[0].count, 2);
      assert.equal(Number((await sql`SELECT current_version FROM shared_assets WHERE id=${second.id as string}`)[0].current_version), 2);
      const frozenRefs = await sql`SELECT version_id,content_sha256 FROM job_shared_asset_versions WHERE job_id=${frozenJob.id as string}`;
      assert.ok(frozenRefs.some((row) => row.version_id === first.version_id));
      assert.ok(frozenRefs.some((row) => row.version_id === agentFirst.version_id));
      assert.ok(!frozenRefs.some((row) => row.version_id === second.version_id));
      const [blob] = await sql`SELECT blob_uri FROM shared_asset_blobs WHERE content_sha256=${first.content_sha256}`;
      assert.deepEqual(await sharedModule.readSharedAssetBlob(String(blob.blob_uri)), firstBytes);
      const audits = await sql`SELECT action FROM audit_logs WHERE action IN ('shared_asset.upload','shared_asset.publish') ORDER BY action`;
      assert.deepEqual(new Set(audits.map((row) => row.action)), new Set(["shared_asset.publish", "shared_asset.upload"]));

      await sql`UPDATE jobs SET status='succeeded', finished_at=now(), lease_expires_at=NULL WHERE id=${agentJobId}`;
      await assert.rejects(
        sharedModule.createSharedAsset({ scope: "project", projectId, key: "dist/late.jar", contentType: "application/java-archive", bytes: Buffer.from("late"), origin: "agent", actor: `job:${agentJobId}`, jobId: agentJobId }),
        /shared_asset_publish_job_not_running/,
      );

      await sql`DELETE FROM findings WHERE id=${findingId}`;
      assert.equal((await sql`SELECT count(*)::int AS count FROM shared_assets WHERE finding_id=${findingId}`)[0].count, 0);
      assert.equal((await sql`SELECT count(*)::int AS count FROM shared_asset_versions WHERE id=${findingVersionId}`)[0].count, 0);
      assert.equal((await sql`SELECT count(*)::int AS count FROM job_shared_asset_versions WHERE version_id=${findingVersionId}`)[0].count, 0);
      assert.equal((await sql`SELECT count(*)::int AS count FROM shared_assets WHERE project_id=${projectId} AND logical_key='scripts/reproduce.sh'`)[0].count, 1);

      await sql`WITH inserted AS (
        INSERT INTO shared_assets (scope_type,project_id,logical_key,origin,current_version)
        SELECT 'project',${projectId},'bulk/item-' || n || '.txt','system',1 FROM generate_series(1,501) n
        RETURNING id
      ) INSERT INTO shared_asset_versions (asset_id,version,content_sha256,bytes,content_type,origin)
        SELECT id,1,${first.content_sha256},${firstBytes.byteLength},'text/plain','system' FROM inserted`;
      const largeCatalog = await sharedModule.resolveSharedAssetSelection(sql, projectId, []);
      assert.ok(largeCatalog.assets.length > 500, "large active catalogs must stay usable instead of blocking Job creation");
    } finally {
      if (closeApp) await closeApp();
      if (endSql) await endSql();
      await rm(blobDir, { recursive: true, force: true });
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });
}
