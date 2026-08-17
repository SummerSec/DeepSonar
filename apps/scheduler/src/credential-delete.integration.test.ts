import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential delete integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("DELETE /credentials/:id unbinds, revokes tokens, and refuses live jobs", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_delete_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      // Cover the accepted DEEPSONAR_DB_POOL_MAX=1 config: impact queries must
      // reuse the DELETE transaction connection or this test deadlocks.
      process.env.DEEPSONAR_DB_POOL_MAX = "1";

      const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./credentials.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { encryptSecret } = credentialsModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      type InjectResponse = { statusCode: number; payload: string };
      const request = async (method: "GET" | "POST" | "DELETE", url: string): Promise<InjectResponse> =>
        await (app.inject({ method, url }) as unknown as Promise<InjectResponse>);
      const json = (response: InjectResponse) => JSON.parse(response.payload) as Record<string, unknown>;

      const insertCredential = async (
        name: string,
        opts: { projectId?: string; kind?: "llm_provider" | "oci_registry"; provider?: string } = {},
      ) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        const kind = opts.kind ?? "llm_provider";
        const provider = opts.provider ?? (kind === "oci_registry" ? "ghcr.io" : "openai");
        await sql`
          INSERT INTO credentials (id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4)
          VALUES (${id}, ${name}, ${kind}, ${provider}, ${opts.projectId ?? null}, ${encrypted.ciphertext},
            ${encrypted.nonce}, ${encrypted.auth_tag}, 'delete-fingerprint', 'cret')`;
        return id;
      };

      const unusedId = await insertCredential("unused-account");
      const unusedDelete = await request("DELETE", `/credentials/${unusedId}`);
      assert.equal(unusedDelete.statusCode, 200, unusedDelete.payload);
      assert.deepEqual(json(unusedDelete), {
        ok: true,
        id: unusedId,
        unbound_role_config_count: 0,
        revoked_job_token_count: 0,
      });
      const [gone] = await sql`SELECT id FROM credentials WHERE id = ${unusedId}`;
      assert.equal(gone, undefined);

      const projectId = randomUUID();
      const canvasId = `credential-delete-${randomUUID()}`;
      const roleId = randomUUID();
      const roleConfigId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'credential delete')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'credential delete', ${sql.json({})})`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind, ui_color)
        VALUES (${roleId}, 'delete_test', 'Delete Test', 'integration fixture', false, 'role', '#c084fc')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${roleConfigId}, ${roleId}, NULL, 'claude-code', 'model-a')`;

      const projectCredId = await insertCredential("project-account", { projectId });
      const projectDelete = await request("DELETE", `/credentials/${projectCredId}`);
      assert.equal(projectDelete.statusCode, 200, projectDelete.payload);
      const [projectAudit] = await sql<{ project_id: string | null }[]>`
        SELECT project_id FROM audit_logs
        WHERE action = 'credential.delete' AND resource_id = ${projectCredId}`;
      assert.equal(projectAudit?.project_id, projectId);

      const boundId = await insertCredential("bound-account");
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${roleConfigId}, ${boundId}, 'llm')`;
      const [versionBefore] = await sql<{ version: number; updated_at: Date }[]>`
        SELECT version, updated_at FROM role_configs WHERE id = ${roleConfigId}`;
      const boundRefuse = await request("DELETE", `/credentials/${boundId}`);
      assert.equal(boundRefuse.statusCode, 409, boundRefuse.payload);
      assert.equal(json(boundRefuse).error_code, "CREDENTIAL_BOUND");
      const boundOk = await request("DELETE", `/credentials/${boundId}?unbind=true`);
      assert.equal(boundOk.statusCode, 200, boundOk.payload);
      assert.equal(json(boundOk).unbound_role_config_count, 1);
      const [binding] = await sql`SELECT role_config_id FROM role_credentials WHERE credential_id = ${boundId}`;
      assert.equal(binding, undefined);
      const [versionAfter] = await sql<{ version: number; updated_at: Date }[]>`
        SELECT version, updated_at FROM role_configs WHERE id = ${roleConfigId}`;
      assert.equal(Number(versionAfter?.version), Number(versionBefore?.version) + 1);
      assert.ok(versionAfter && versionBefore && versionAfter.updated_at > versionBefore.updated_at);

      const liveId = await insertCredential("live-account");
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', 'running',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: liveId })})`;
      const liveRefuse = await request("DELETE", `/credentials/${liveId}?unbind=true`);
      assert.equal(liveRefuse.statusCode, 409, liveRefuse.payload);
      assert.equal(json(liveRefuse).error_code, "CREDENTIAL_IN_USE");
      const [stillLive] = await sql`SELECT id FROM credentials WHERE id = ${liveId}`;
      assert.equal(String(stillLive?.id), liveId);

      for (const status of ["failed", "timeout", "orphan"] as const) {
        const recoverableId = await insertCredential(`recoverable-${status}`);
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', ${status},
            ${sql.json({ name: "delete_test", model: "model-a", credential_id: recoverableId })})`;
        const recoverableRefuse = await request("DELETE", `/credentials/${recoverableId}`);
        assert.equal(recoverableRefuse.statusCode, 409, recoverableRefuse.payload);
        assert.equal(json(recoverableRefuse).error_code, "CREDENTIAL_IN_USE");
        const impact = json(recoverableRefuse).impact as { jobs: { recoverable: { count: number } } };
        assert.equal(impact.jobs.recoverable.count, 1, status);
        const [stillRecoverable] = await sql`SELECT id FROM credentials WHERE id = ${recoverableId}`;
        assert.equal(String(stillRecoverable?.id), recoverableId);
      }

      const raceId = await insertCredential("race-account");
      const raceJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${raceJobId}, ${projectId}, ${canvasId}, 'delete_test', 'failed',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: raceId })})`;
      const [raceDelete, raceResume] = await Promise.all([
        request("DELETE", `/credentials/${raceId}`),
        request("POST", `/jobs/${raceJobId}/resume`),
      ]);
      const [raceStill] = await sql`SELECT id FROM credentials WHERE id = ${raceId}`;
      assert.ok(raceStill, "credential must survive a concurrent delete/resume");
      assert.equal(raceDelete.statusCode, 409, raceDelete.payload);
      assert.equal(json(raceDelete).error_code, "CREDENTIAL_IN_USE");
      assert.ok([200, 409].includes(raceResume.statusCode), raceResume.payload);
      const [raceJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${raceJobId}`;
      assert.ok(raceJob && ["failed", "pending"].includes(String(raceJob.status)), String(raceJob?.status));

      const historicalId = await insertCredential("historical-account");
      const historicalJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${historicalJobId}, ${projectId}, ${canvasId}, 'delete_test', 'succeeded',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: historicalId })})`;
      await sql`
        INSERT INTO job_tokens (job_id, project_id, credential_id, token_prefix, token_hash, max_requests, expires_at)
        VALUES (${historicalJobId}, ${projectId}, ${historicalId}, ${historicalId.slice(0, 8)}, 'hash', 8, now() + interval '1 hour')`;
      const historicalDelete = await request("DELETE", `/credentials/${historicalId}`);
      assert.equal(historicalDelete.statusCode, 200, historicalDelete.payload);
      assert.equal(json(historicalDelete).revoked_job_token_count, 1);
      const [jobStill] = await sql`SELECT status, agent_snapshot_json FROM jobs WHERE id = ${historicalJobId}`;
      assert.equal(jobStill?.status, "succeeded");
      assert.equal((jobStill?.agent_snapshot_json as { credential_id: string }).credential_id, historicalId);
      const [tokenGone] = await sql`SELECT id FROM job_tokens WHERE credential_id = ${historicalId}`;
      assert.equal(tokenGone, undefined);

      const ociId = await insertCredential("oci-account", { kind: "oci_registry", provider: "ghcr.io" });
      const imageId = randomUUID();
      const versionId = randomUUID();
      const scanId = randomUUID();
      const imageKey = `cred-del-${randomUUID().slice(0, 8)}`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${imageId}, ${imageKey}, 'credential delete scan', 'fixture', 'SummerSec', 'third_party', false)`;
      await sql`
        INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, trust_status)
        VALUES (${versionId}, ${imageId}, '0.0.1', 'ghcr.io/summersec/fixture:test', 'quarantined')`;
      await sql`
        INSERT INTO runtime_image_scans (id, runtime_image_version_id, status, result_json)
        VALUES (${scanId}, ${versionId}, 'queued', ${sql.json({ registry_credential_id: ociId })})`;
      const scanRefuse = await request("DELETE", `/credentials/${ociId}`);
      assert.equal(scanRefuse.statusCode, 409, scanRefuse.payload);
      assert.equal(json(scanRefuse).error_code, "CREDENTIAL_SCAN_IN_USE");
      const scanImpact = json(scanRefuse).impact as { scans: { active: { count: number } } };
      assert.equal(scanImpact.scans.active.count, 1);
      const [ociStill] = await sql`SELECT id FROM credentials WHERE id = ${ociId}`;
      assert.equal(String(ociStill?.id), ociId);
      await sql`UPDATE runtime_image_scans SET status = 'succeeded' WHERE id = ${scanId}`;
      const scanOk = await request("DELETE", `/credentials/${ociId}`);
      assert.equal(scanOk.statusCode, 200, scanOk.payload);

      const missing = await request("DELETE", `/credentials/${randomUUID()}`);
      assert.equal(missing.statusCode, 404, missing.payload);

      const audits = await sql<{ action: string; after_json: unknown }[]>`
        SELECT action, after_json FROM audit_logs WHERE action = 'credential.delete'`;
      assert.ok(audits.length >= 1);
      assert.equal(JSON.stringify(audits).includes("ciphertext"), false);
      assert.equal(JSON.stringify(audits).includes("-secret"), false);
    } finally {
      if (closeApp) await closeApp();
      if (endSql) await endSql();
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
}
