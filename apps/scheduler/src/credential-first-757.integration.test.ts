import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("#757 credential-first integration requires an isolated TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing the scheduler default database",
  }, () => {});
} else {
  test("#757 credential selection, readiness, preferences and immutable history", async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_757_${process.pid}_${Date.now()}`;
    const targetUrl = new URL(adminUrl);
    targetUrl.pathname = `/${databaseName}`;
    let created = false;
    let endSql: (() => Promise<unknown>) | undefined;
    let closeApp: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.AGENT_MODE = "fake";
      const [dbModule, snapshotModule, readinessModule, credentialModule, fastifyModule, websocketModule, routesModule] = await Promise.all([
        import("./db.js"), import("./domains/role-runtime-snapshot/application.js"),
        import("./readiness.js"), import("./credentials.js"), import("fastify"),
        import("@fastify/websocket"), import("./routes.js"),
      ]);
      const { sql, migrate } = dbModule;
      const { resolveAgentSnapshotForJob, SnapshotUnresolvableError } = snapshotModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = fastifyModule.default({ logger: false });
      await app.register(websocketModule.default);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();
      const projectId = randomUUID();
      const otherProjectId = randomUUID();
      const canvasId = randomUUID();
      const jobId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, '757 isolated'), (${otherProjectId}, '757 other scope')`;
      const [role] = await sql`SELECT id FROM agent_roles WHERE name = 'audit' AND project_id IS NULL`;
      const [seed] = await sql`SELECT agent_cli FROM role_configs WHERE role_id = ${role.id} AND project_id IS NULL`;
      assert.equal(seed.agent_cli, null, "system seed is not an explicit user preference");
      const setConfig = async (value: Record<string, unknown>) => {
        await sql`UPDATE projects SET config_json = ${sql.json(value as never)} WHERE id = ${projectId}`;
      };
      const insertCredential = async (cli: "pi" | "claude-code", scope = projectId, model = "claude-sonnet-4", plaintext = "757-fake-test-secret") => {
        const id = randomUUID();
        const secret = credentialModule.encryptSecret(plaintext);
        const settings = cli === "pi"
          ? { provider: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", models: [{ id: model }] }
          : { env: { ANTHROPIC_MODEL: model, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } };
        await sql`INSERT INTO credentials (id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4, status, agent_cli, settings_config_json)
          VALUES (${id}, ${`757-${cli}-${id}`}, 'llm_provider', 'anthropic', ${scope}, ${secret.ciphertext}, ${secret.nonce}, ${secret.auth_tag}, ${id}, 'fake', 'active', ${cli}, ${sql.json(settings as never)})`;
        return id;
      };
      const snapshot = (options?: Parameters<typeof resolveAgentSnapshotForJob>[3]) => resolveAgentSnapshotForJob(sql as unknown as Parameters<typeof resolveAgentSnapshotForJob>[0], projectId, "audit", options);
      const assertResolveError = async (code: string, options?: Parameters<typeof resolveAgentSnapshotForJob>[3]) => {
        await assert.rejects(() => snapshot(options), (error: unknown) => {
          assert.ok(error instanceof SnapshotUnresolvableError);
          assert.equal(error.code, code);
          assert.ok(error.repair?.next_action);
          assert.equal(error.repair?.category, code === "provider_credential_cli_mismatch" || code === "provider_credential_allowlist_stale" ? "permanent_failure" : "model_correctable");
          assert.equal(JSON.stringify(error.repair).includes("757-fake-test-secret"), false);
          return true;
        });
      };
      const assertReadinessCli = async (cli: string) => {
        const readiness = await readinessModule.loadReadiness(sql, { projectId });
        const checks = readiness.checks.filter((check) => check.role?.name === "audit");
        assert.ok(checks.length > 0);
        assert.ok(checks.every((check) => check.role?.agent_cli === cli), JSON.stringify(checks));
      };
      const assertReadinessError = async (code: string) => {
        const readiness = await readinessModule.loadReadiness(sql, { projectId });
        const check = readiness.checks.find((item) => item.role?.name === "audit" && item.repair?.code === code);
        assert.ok(check, JSON.stringify(readiness.checks));
        assert.equal(check.state, "fail");
        assert.ok(check.repair?.next_action);
      };
      const piId = await insertCredential("pi");
      await insertCredential("claude-code", otherProjectId);
      const first = await snapshot();
      assert.equal(first.agent_cli, "pi");
      assert.equal(first.credential_id, piId);
      await assertReadinessCli("pi");
      const settingsRead = await app.inject({ method: "GET", url: `/projects/${projectId}/settings` });
      assert.equal(settingsRead.statusCode, 200, settingsRead.payload);
      const [afterRead] = await sql`SELECT config_json FROM projects WHERE id = ${projectId}`;
      assert.equal(afterRead.config_json.enabled_credential_ids, undefined, "reads never seed credential IDs");
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, '757 history', ${sql.json({})})`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json(first as never)})`;
      await assertResolveError("provider_credential_cli_mismatch", { agentCli: "claude-code" });

      const modelOnlyId = await insertCredential("claude-code", projectId, "claude-opus-4");
      assert.equal((await snapshot({ modelRef: "claude-sonnet-4" })).credential_id, piId, "model filters candidates before CLI preference");
      assert.equal((await snapshot({ modelRef: "claude-opus-4" })).credential_id, modelOnlyId);
      await sql`DELETE FROM credentials WHERE id = ${modelOnlyId}`;
      const claudeId = await insertCredential("claude-code");
      await assertResolveError("provider_credential_multi_match");
      await assertReadinessError("provider_credential_multi_match");
      await setConfig({ default_agent_cli: "pi" });
      assert.equal((await snapshot()).credential_id, piId);
      await assertReadinessCli("pi");
      assert.equal((await snapshot({ agentCli: "claude-code" })).credential_id, claudeId);
      await setConfig({});
      await sql`UPDATE role_configs SET agent_cli = 'claude-code' WHERE role_id = ${role.id} AND project_id IS NULL`;
      assert.equal((await snapshot()).credential_id, claudeId, "explicit Claude preference differs from NULL seed");
      await assertReadinessCli("claude-code");
      await sql`UPDATE credentials SET status = 'disabled' WHERE id = ${claudeId}`;
      assert.equal((await snapshot()).credential_id, piId, "soft global preference cannot exclude unique credential");
      await assertReadinessCli("pi");
      await setConfig({ enabled_credential_ids: [claudeId] });
      await assertResolveError("provider_credential_allowlist_stale");
      await assertReadinessError("provider_credential_allowlist_stale");
      await sql`DELETE FROM credentials WHERE id = ${claudeId}`;
      await assertResolveError("provider_credential_allowlist_stale");
      await assertReadinessError("provider_credential_allowlist_stale");
      await setConfig({ enabled_credential_ids: [] });
      assert.equal((await snapshot()).credential_id, null, "fake mode may run without a provider but must never widen an empty whitelist");
      await setConfig({});
      await sql`DELETE FROM credentials WHERE id = ${piId}`;
      const replacement = await insertCredential("pi");
      assert.equal((await snapshot()).credential_id, replacement, "unrestricted project sees replacement without repair of an auto-seeded ID");
      await assertReadinessCli("pi");
      const [historical] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${jobId}`;
      assert.deepEqual(historical.agent_snapshot_json, JSON.parse(JSON.stringify(first)), "credential/settings changes never rewrite historical snapshots");
      const projectRoleWrite = await app.inject({ method: "PUT", url: `/projects/${projectId}/role-configs/${role.id}`, payload: { agent_cli: "pi", model: "claude-sonnet-4" } });
      assert.equal(projectRoleWrite.statusCode, 400, projectRoleWrite.payload);
      await t.test("#1002 two same-project pool accounts freeze independently and execute through the real Gateway", async () => {
        const [http, core, gateway, attempts, recovery] = await Promise.all([
          import("node:http"), import("./core.js"), import("./gateway.js"),
          import("./domains/job-attempt/application.js"), import("./domains/job-control/rerun.js"),
        ]);
        const seenKeys: string[] = [];
        const upstream = http.createServer((request, response) => {
          seenKeys.push(String(request.headers["x-api-key"] ?? ""));
          request.resume();
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "pool-fixture", type: "message", role: "assistant", model: "claude-sonnet-4",
            content: [{ type: "text", text: "fixture result" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
        });
        const gatewayApp = fastifyModule.default({ logger: false });
        try {
          await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
          const address = upstream.address();
          assert.ok(address && typeof address !== "string");
          gateway.registerGateway(gatewayApp);
          await gatewayApp.ready();
          const keys = ["1002-pool-a-fake-secret", "1002-pool-b-fake-secret"];
          const ids = await Promise.all(keys.map(key => insertCredential("pi", projectId, "claude-sonnet-4", key)));
          const settings = { provider: "anthropic", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${address.port}`, models: [{ id: "claude-sonnet-4" }] };
          for (const id of ids) await sql`UPDATE credentials SET settings_config_json=${sql.json(settings)} WHERE id=${id}`;
          await setConfig({ enabled_credential_ids: ids, default_agent_cli: "pi", default_model_ref: "claude-sonnet-4" });
          await sql`UPDATE canvases SET target_json=${sql.json({ network_policy: { allow_egress: false } })} WHERE id=${canvasId}`;
          const firstJob = (await core.createJob({ projectId, canvasId, type: "audit", maxRequests: 2 })).job;
          const secondJob = (await core.createJob({ projectId, canvasId, type: "audit", maxRequests: 2 })).job;
          const selected = [firstJob, secondJob].map(job => String(job.agent_snapshot_json.credential_id));
          assert.deepEqual([...selected].sort(), [...ids].sort(), "both accounts are used without changing the project default");
          const before = [firstJob, secondJob].map(job => structuredClone(job.agent_snapshot_json));
          await assertReadinessCli("pi");
          await core.createJob({ projectId, canvasId, type: "audit", maxRequests: 2 });
          const refreshed = await recovery.resolveCurrentSnapshotForExistingJob(sql, firstJob);
          assert.equal(refreshed.credential_id, selected[0], "existing Job recovery preserves its still-authorized account despite changed load");
          for (const [index, job] of [firstJob, secondJob].entries()) {
            const credentialId = selected[index]!;
            assert.equal(job.agent_snapshot_json.runtime_profile.provider_ref.credential_id, credentialId);
            await sql`UPDATE jobs SET status='running', started_at=now(), lease_expires_at=now()+interval '1 hour' WHERE id=${job.id}`;
            await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, String(job.id)));
            const token = await gateway.mintJobToken({ jobId: String(job.id), projectId, credentialId, workload: "main", ttlSec: 3600, maxRequests: 2 });
            const response = await gatewayApp.inject({ method: "POST", url: "/gateway/v1/messages",
              headers: { authorization: `Bearer ${token.plaintext}`, "x-deepsonar-request-id": randomUUID(), "x-deepsonar-workload": "main" },
              payload: { model: "claude-sonnet-4", max_tokens: 1, messages: [{ role: "user", content: "fixture request" }] } });
            assert.equal(response.statusCode, 200, response.payload);
            const [usage] = await sql`SELECT count(*)::int AS entries FROM job_usage_ledger l JOIN job_tokens tok ON tok.id=l.job_token_id
              WHERE l.job_id=${job.id} AND l.project_id=${projectId} AND tok.credential_id=${credentialId} AND l.status='settled'`;
            assert.equal(usage.entries, 1, "execution settles usage against its own frozen account");
            await assert.rejects(() => gateway.mintJobToken({ jobId: String(job.id), projectId,
              credentialId: selected[1-index]!, workload: "main", ttlSec: 3600 }), "another pool account cannot replace this Job's frozen identity");
            const [stored] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${job.id}`;
            assert.deepEqual(stored.agent_snapshot_json, before[index], "readiness, load and execution do not rewrite the snapshot or budgets");
          }
          assert.deepEqual([...seenKeys].sort(), [...keys].sort(), "the real upstream receives the two distinct test keys");
          await sql`UPDATE credentials SET status='disabled' WHERE id=${selected[0]}`;
          await assertResolveError("provider_credential_allowlist_stale");
          const [stored] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${firstJob.id}`;
          assert.deepEqual(stored.agent_snapshot_json, before[0], "disabling an account does not switch a running Job");
        } finally {
          await gatewayApp.close();
          await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
        }
      });
      const { HubIntentPayload } = await import("@deepsonar/shared-types");
      const intent = { from: [], role: "audit", description: "Inspect the test fixture", prompt: "Inspect this isolated test fixture and record structured evidence." };
      assert.equal(HubIntentPayload.safeParse(intent).success, true);
      assert.equal(HubIntentPayload.safeParse({ ...intent, credential_id: replacement }).success, false);
      assert.equal(HubIntentPayload.safeParse({ ...intent, runtime_image_key: "registry.invalid/unauthorized:latest" }).success, false);
      for (const forbidden of [{ credential_id: replacement }, { runtime_image_ref: "registry.invalid/unauthorized:latest" }]) {
        const result = await app.inject({ method: "PUT", url: `/projects/${projectId}/role-configs/${role.id}`, payload: forbidden });
        assert.equal(result.statusCode, 400, result.payload);
      }
    } finally {
      await closeApp?.().catch(() => undefined);
      await endSql?.().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });
}
