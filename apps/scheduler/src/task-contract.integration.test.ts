import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("task contract SQL and HTTP integration requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("contract preflight rechecks project and credentials; HTTP rejection creates no task", async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_contract_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | undefined;
    let endSql: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";
      const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }, { generateToken }, { encryptSecret }, { taskContractPreflight }] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"),
        import("./auth.js"), import("./credentials.js"), import("./task-contract-preflight.js"),
      ]);
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      closeApp = () => app.close();
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();

      const projectId = randomUUID();
      const otherProjectId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'contract fixture'), (${otherProjectId}, 'other contract fixture')`;
      const createCredential = async (kind: "git" | "llm_provider", owner: string | null) => {
        const id = randomUUID();
        const encrypted = encryptSecret("task-contract-test-fixture");
        await sql`INSERT INTO credentials (id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4, status, health_status)
          VALUES (${id}, ${`contract-${id}`}, ${kind}, ${kind === "git" ? "github" : "anthropic"}, ${owner},
            ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag}, ${id}, 'ture', 'active', 'ok')`;
        return id;
      };
      const gitId = await createCredential("git", projectId);
      const otherGitId = await createCredential("git", otherProjectId);
      const globalGitId = await createCredential("git", null);
      const providerId = await createCredential("llm_provider", projectId);
      const contract = (credentialRefs: string[] = []) => normalizeTaskContract({
        schema_version: 1, template_id: "engineering", template_version: 1,
        objective: "Inspect fixture source", targets: ["repository:fixture"], scope: ["parser"],
        allowed_actions: ["read"], required_actions: ["read"], credential_refs: credentialRefs,
        acceptance: ["Report evidence and unverified limitations"], evidence: ["File and line references"],
        stop_conditions: ["Stop when a required resource is unavailable"], budget: { max_minutes: 30, max_steps: 10 },
      });
      const preflight = (refs: string[]) => taskContractPreflight(sql, projectId, contract(refs), false);
      const denied = async (refs: string[]) => {
        const blockers = await preflight(refs);
        assert.ok(blockers.some((item) => item.code === "task_contract_credential_unavailable"), JSON.stringify(blockers));
      };

      await t.test("own and global active Git references work, but another project's references do not", async () => {
        assert.deepEqual(await preflight([gitId, globalGitId]), []);
        await denied([otherGitId]);
        await denied([randomUUID()]);
      });
      await t.test("disable, health failure and revocation are observed on the same frozen reference", async () => {
        const frozen = contract([gitId]);
        assert.deepEqual(await taskContractPreflight(sql, projectId, frozen, false), []);
        await sql`UPDATE credentials SET status = 'disabled' WHERE id = ${gitId}`;
        assert.ok((await taskContractPreflight(sql, projectId, frozen, false)).some((item) => item.code === "task_contract_credential_unavailable"));
        await sql`UPDATE credentials SET status = 'active', health_status = 'error' WHERE id = ${gitId}`;
        await denied([gitId]);
        await sql`UPDATE credentials SET health_status = 'ok' WHERE id = ${gitId}`;
        assert.deepEqual(await preflight([gitId]), []);
        assert.deepEqual(frozen.credential_refs, [gitId]);
      });
      await t.test("current LLM allowlist is enforced without applying the LLM-only restriction to Git", async () => {
        assert.deepEqual(await preflight([providerId]), []);
        await sql`UPDATE projects SET config_json = ${sql.json({ enabled_credential_ids: [providerId] })} WHERE id = ${projectId}`;
        assert.deepEqual(await preflight([providerId]), []);
        await sql`UPDATE projects SET config_json = ${sql.json({ enabled_credential_ids: [] })} WHERE id = ${projectId}`;
        await denied([providerId]);
        assert.deepEqual(await preflight([gitId]), []);
        await sql`UPDATE projects SET config_json = '{}'::jsonb WHERE id = ${projectId}`;
      });
      await t.test("archived or nonexistent projects are rejected before resource checks", async () => {
        await sql`UPDATE projects SET status = 'archived' WHERE id = ${projectId}`;
        assert.equal((await preflight([]))[0]?.code, "task_contract_project_unavailable");
        assert.equal((await taskContractPreflight(sql, randomUUID(), contract(), false))[0]?.code, "task_contract_project_unavailable");
        await sql`UPDATE projects SET status = 'active' WHERE id = ${projectId}`;
      });

      const token = generateToken();
      await sql`INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('contract writer', ${projectId}, ${token.prefix}, ${token.hash}, ${["projects:read", "tasks:read", "tasks:write"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const counts = async () => {
        const [row] = await sql`SELECT (SELECT count(*)::int FROM canvases WHERE project_id = ${projectId}) AS canvases,
          (SELECT count(*)::int FROM jobs WHERE project_id = ${projectId}) AS jobs`;
        return { canvases: row.canvases, jobs: row.jobs };
      };
      await t.test("unsupported contract version returns 400 without creating canvas or job", async () => {
        const before = await counts();
        const response = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`, headers,
          payload: { title: "Invalid contract", content: "Review fixture", task_contract: { ...contract(), schema_version: 9 } } });
        assert.equal(response.statusCode, 400, response.payload);
        const body = response.json();
        assert.equal(body.error_code, "invalid_payload");
        assert.ok(body.issues.some((item: { path: string }) => item.path === "task_contract.schema_version"));
        assert.deepEqual(await counts(), before);
      });
      await t.test("client-authorized target writing returns 409 with actionable blockers and no task side effects", async () => {
        const before = await counts();
        const response = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`, headers,
          payload: { title: "Write test", content: "save then publish then trigger", task_contract: {
            ...contract(), template_id: "blackbox", allowed_actions: ["read", "write"], required_actions: ["read", "write"],
            identity: { tenant: "test", role: "editor", resource: "fixture-flow" },
          } } });
        assert.equal(response.statusCode, 409, response.payload);
        const body = response.json();
        assert.equal(body.error_code, "task_contract_blocked");
        assert.ok(body.task_contract_blockers.some((item: { code: string }) => item.code === "task_contract_write_unverified"));
        assert.ok(body.task_contract_blockers.every((item: { path: string; suggestion: string }) => item.path && item.suggestion));
        assert.deepEqual(await counts(), before);
      });
      await t.test("successful engineering creation freezes canonical contracts and preserves original prose", async () => {
        // Fake mode supports an explicitly empty provider allowlist. No model request,
        // dispatcher, runtime provisioning or real credential is needed for creation.
        await sql`UPDATE projects SET config_json = ${sql.json({ enabled_credential_ids: [] })} WHERE id = ${projectId}`;
        const originalContent = "请修改解析器并提供测试结果。\nThis original request must remain intact.";
        const submitted = { ...contract([gitId]), scope: [" parser ", "parser"],
          allowed_actions: ["workspace_write", "read"], required_actions: ["workspace_write", "read"] };
        const expected = normalizeTaskContract(submitted);
        const response = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`, headers,
          payload: { title: "Contracted engineering", content: originalContent, task_contract: submitted } });
        assert.equal(response.statusCode, 201, response.payload);
        const body = response.json();
        assert.deepEqual(body.task_contract_warnings, []);
        const [canvas] = await sql`SELECT target_json FROM canvases WHERE id = ${body.canvas_id}`;
        const [job] = await sql`SELECT status, payload_json, agent_snapshot_json FROM jobs WHERE id = ${body.job.id}`;
        assert.equal(canvas.target_json.content, originalContent);
        assert.equal(job.payload_json.content, originalContent);
        assert.equal(job.status, "pending");
        assert.deepEqual(canvas.target_json.task_contract, expected);
        assert.deepEqual(job.agent_snapshot_json.task_contract, expected);
        assert.equal(job.agent_snapshot_json.task_contract.template_version, 1);
        const edited = await app.inject({ method: "PATCH", url: `/tasks/${body.canvas_id}`, headers,
          payload: { content: "Later task text" } });
        assert.equal(edited.statusCode, 200, edited.payload);
        const [frozen] = await sql`SELECT payload_json, agent_snapshot_json FROM jobs WHERE id = ${body.job.id}`;
        assert.equal(frozen.payload_json.content, originalContent);
        assert.deepEqual(frozen.agent_snapshot_json.task_contract, expected);
      });
      await t.test("successful legacy creation without contract needs no Markdown headings or audit template", async () => {
        const content = "Fix the parser";
        const response = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`, headers,
          payload: { title: "Plain engineering request", content } });
        assert.equal(response.statusCode, 201, response.payload);
        const body = response.json();
        assert.equal(body.task_contract_warnings[0].code, "task_contract_not_assessed");
        const [canvas] = await sql`SELECT target_json FROM canvases WHERE id = ${body.canvas_id}`;
        const [job] = await sql`SELECT payload_json, agent_snapshot_json FROM jobs WHERE id = ${body.job.id}`;
        assert.equal(canvas.target_json.content, content);
        assert.equal(job.payload_json.content, content);
        assert.equal(canvas.target_json.task_contract, undefined);
        assert.equal(job.agent_snapshot_json.task_contract, undefined);
      });
      await t.test("cross-project management submission is still forbidden before contract handling", async () => {
        const response = await app.inject({ method: "POST", url: `/projects/${otherProjectId}/tasks`, headers,
          payload: { title: "Other project", content: "Review fixture", task_contract: contract() } });
        assert.equal(response.statusCode, 403, response.payload);
        assert.equal(response.json().error_code, "PROJECT_MISMATCH");
      });
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });
}
