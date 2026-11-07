import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { RoleConfigPutBody } from "./role-config-schema.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../skills/deepsonar-management/scripts/deepsonar-api.py", import.meta.url));
const schema = fileURLToPath(new URL("../../../database/schema.sql", import.meta.url));
const prompts = [...readFileSync(schema, "utf8").matchAll(/\('([a-z][a-z0-9_]*)',\s*\$instructions\$([\s\S]*?)\$instructions\$\)/g)]
  .map((match) => ({ name: match[1]!, prompt: match[2]! }));
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type View = Record<string, unknown> & { role_id: string; instructions_markdown: string };
type Request = { method: string | undefined; path: string | undefined; body: unknown };

function fixtures() {
  assert.equal(prompts.length, 9, "read the current SQL seed, not a second prompt template");
  return prompts.map(({ name, prompt }, index) => {
    const expected = {
      agent_cli: index === 0 ? null : "dsh",
      dsh_task_mode: index % 2 === 0 ? "standard" : "ptc",
      model: index === 0 ? null : `fixture-model-${index}`,
      allow_model_catalog_passthrough: false,
      context_window_tokens: index === 0 ? null : 131072,
      env_keys: ["LANG"],
      env_vars: { LANG: "C.UTF-8", FIXTURE_EMPTY: "" },
      modules: ["11111111-1111-4111-8111-111111111111:review/module"],
      skills: [{ name: "fixture-skill", content: "保留技能\n", enabled: false }],
      commands: [{ name: "fixture-command", command: "printf fixture", args: ["one", "two"] }],
      mcps: [{ name: "fixture-mcp", command: "fixture-mcp", env: { LANG: "C.UTF-8" } }],
      subagents: [{ name: "fixture-subagent", description: "retain", tools: ["read"] }],
      platform_tools: { emit_progress: false, mark_job_done: true, ack_human_message: true },
      instructions_markdown: prompt,
      runtime_image_key: index === 0 ? null : "deepsonar-base",
      // Numeric sandbox overrides are project-only; global GET must remain empty.
      sandbox_limits: {},
      runtime_knobs: { stallSec: 0, jobTokenMaxRequests: 37, timeoutSec: 600 },
      config_files: [{ path: index === 0 ? ".pi/agent/models.json" : ".dsh/settings.yaml", content: "{}\r\n" }],
    };
    // Match roleConfigView / upsertRoleConfigInTx, including read-only metadata.
    const view: View = {
      id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      role_id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      project_id: null, role_name: name, role_title: name,
      role_kind: name === "hub_reason" ? "hub" : ["verify", "report"].includes(name) ? "system" : "role",
      version: 7, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
      agent_cli: expected.agent_cli, dsh_task_mode: expected.dsh_task_mode,
      model: expected.model, allow_model_catalog_passthrough: expected.allow_model_catalog_passthrough,
      context_window_tokens: expected.context_window_tokens,
      env_keys: expected.env_keys, env_vars_json: expected.env_vars,
      modules_json: expected.modules, skills_json: expected.skills,
      commands_json: expected.commands, mcps_json: expected.mcps, subagents_json: expected.subagents,
      platform_tools_json: expected.platform_tools, instructions_markdown: `old prompt for ${name}\n`,
      runtime_image_key: expected.runtime_image_key,
      sandbox_limits_json: expected.sandbox_limits, runtime_knobs_json: expected.runtime_knobs,
      config_files: expected.config_files.map((file) => ({ ...file, content_sha256: hash(file.content) })),
    };
    return { view, expected };
  });
}

async function mockApi(t: TestContext, views: View[] = []) {
  const requests: Request[] = [];
  const accepted: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : null;
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/role-configs/global") {
        res.end(JSON.stringify(views));
      } else if (req.method === "PUT" && views.some((view) => req.url === `/role-configs/global/${view.role_id}`)) {
        // The actual strict server schema must accept the wire body before success.
        const parsed = RoleConfigPutBody.parse(body);
        accepted.push(parsed);
        res.end(JSON.stringify(parsed));
      } else if (req.method === "PATCH" && req.url === "/projects/project-id/settings") {
        if (body.finding_protocol) FindingProtocolConfig.parse(body.finding_protocol);
        accepted.push(body);
        res.end(JSON.stringify(body));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unexpected fixture request" }));
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile("python3", [cli, ...args], {
      cwd: root, timeout: 15_000,
      env: { ...process.env, DEEPSONAR_BASE_URL: url, DEEPSONAR_API_TOKEN: "", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  return { requests, accepted, run };
}

const syncArgs = ["role-configs", "sync-builtin-prompts", "--schema", schema];

test("prompt sync PUT passes real Zod and round-trips every non-prompt field", async (t) => {
  const rows = fixtures();
  const api = await mockApi(t, rows.map((row) => row.view));
  const result = await api.run(syncArgs);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(api.requests[0], { method: "GET", path: "/role-configs/global", body: null });
  assert.deepEqual(api.requests.slice(1), rows.map(({ view, expected }) => ({
    method: "PUT", path: `/role-configs/global/${view.role_id}`, body: expected,
  })));
  assert.deepEqual(api.accepted, rows.map((row) => row.expected), "Zod must not strip or default away any configuration");
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.dry_run, false);
  assert.deepEqual(output.roles, rows.map(({ view, expected }) => ({
    role: view.role_name, changed: true,
    current_prompt_sha256: hash(view.instructions_markdown), prompt_sha256: hash(expected.instructions_markdown),
  })));
  assert.equal(rows[0]!.expected.agent_cli, null);
  assert.ok(rows.some((row) => row.expected.agent_cli === "dsh" && row.expected.dsh_task_mode === "standard"));
  assert.ok(rows.some((row) => row.expected.agent_cli === "dsh" && row.expected.dsh_task_mode === "ptc"));
  for (const { expected } of rows) {
    for (const removed of ["reasoning", "credentials", "pi_extensions"]) {
      assert.equal(Object.hasOwn(expected, removed), false);
      assert.equal(RoleConfigPutBody.safeParse({ ...expected, [removed]: null }).success, false);
    }
  }
});

test("unchanged prompts and dry-run never PUT; mixed changes only PUT the changed role", async (t) => {
  const rows = fixtures();
  for (const row of rows) row.view.instructions_markdown = row.expected.instructions_markdown;
  const api = await mockApi(t, rows.map((row) => row.view));
  const unchanged = await api.run(syncArgs);
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.ok(JSON.parse(unchanged.stdout).roles.every((role: { changed: boolean }) => !role.changed));
  assert.deepEqual(api.requests.map((request) => request.method), ["GET"]);
  rows[0]!.view.instructions_markdown = "changed\n";
  const dry = await api.run([...syncArgs, "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  const dryOutput = JSON.parse(dry.stdout);
  assert.equal(dryOutput.dry_run, true);
  assert.equal(dryOutput.roles.filter((role: { changed: boolean }) => role.changed).length, 1);
  assert.deepEqual(api.requests.map((request) => request.method), ["GET", "GET"]);
  assert.deepEqual(api.accepted, []);
  const mixed = await api.run(syncArgs);
  assert.equal(mixed.code, 0, mixed.stderr);
  assert.deepEqual(api.requests.map((request) => request.method), ["GET", "GET", "GET", "PUT"]);
  assert.deepEqual(api.accepted, [rows[0]!.expected]);
});

test("missing GET fields fail before PUT rather than inventing defaults", async (t) => {
  const rows = fixtures();
  delete rows[0]!.view.dsh_task_mode;
  const api = await mockApi(t, rows.map((row) => row.view));
  const result = await api.run(syncArgs);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(JSON.parse(result.stderr).error, /GET 缺少字段 dsh_task_mode/);
  assert.deepEqual(api.requests.map((request) => request.method), ["GET"]);
});

test("a real schema rejection is surfaced, not retried or reported as a successful sync", async (t) => {
  const rows = fixtures();
  rows[0]!.view.agent_cli = "codex";
  const api = await mockApi(t, rows.map((row) => row.view));
  const result = await api.run(syncArgs);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).status, 400);
  assert.deepEqual(api.requests.map((request) => request.method), ["GET", "PUT"]);
  assert.deepEqual(api.accepted, []);
});

test("old --roles forms cannot write even alongside otherwise valid settings", async (t) => {
  const api = await mockApi(t);
  const settings = ["--rules", '{"maxHubRounds":8}', "--finding-protocol", '{"mode":"hybrid"}'];
  for (const args of [["--roles", "explore,analyze"], ["--roles", "null"], ["--roles", ""],
    ["--roles"], ["--roles=null"], ["--roles="]]) {
    for (const extra of [[], settings]) {
      const result = await api.run(["project-settings", "update", "project-id", ...args, ...extra]);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr);
      assert.equal(error.ok, false);
      assert.match(error.error, /角色由 Hub\/Job 选择.*CLI\/Provider 项目授权仍有效/);
      assert.deepEqual(api.requests, []);
    }
  }
});

test("rules and finding-protocol still PATCH separately and together", async (t) => {
  const api = await mockApi(t);
  const rules = { maxHubRounds: 8, minVerifySeverity: "high" };
  const finding_protocol = { mode: "hybrid", allowed_profiles: ["vulnerability", "engineering"] };
  const bodies = [{ rules }, { finding_protocol }, { rules, finding_protocol }];
  for (const body of bodies) {
    const flags = Object.entries(body).flatMap(([key, value]) => [`--${key.replaceAll("_", "-")}`, JSON.stringify(value)]);
    const result = await api.run(["project-settings", "update", "project-id", ...flags]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), body);
  }
  assert.deepEqual(api.requests, bodies.map((body) => ({ method: "PATCH", path: "/projects/project-id/settings", body })));
});
