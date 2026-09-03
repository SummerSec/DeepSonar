import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_MODE = "fake";

type SnapshotDb = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  json?: (value: unknown) => unknown;
};

const { resolveAgentSnapshotForJob, SnapshotUnresolvableError } = await import("./application.js");

function snapshotDb(input: {
  projectConfig?: unknown;
  projectCfg: Record<string, unknown> | undefined;
  globalCfg: Record<string, unknown> | undefined;
  credential?: Record<string, unknown>;
}): SnapshotDb {
  const query = async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM agent_roles")) {
      return [{ id: "role-audit", name: "audit", description: "audit", kind: "role", ui_color: "#f59e0b" }];
    }
    if (sql.includes("FROM projects")) {
      return [{ config_json: input.projectConfig }];
    }
    if (sql.includes("FROM role_configs") && sql.includes("project_id IS NULL")) {
      return input.globalCfg ? [input.globalCfg] : [];
    }
    if (sql.includes("FROM role_configs")) {
      return input.projectCfg ? [input.projectCfg] : [];
    }
    if (sql.includes("FROM role_credentials") || sql.includes("JOIN credentials")) {
      return input.credential ? [input.credential] : [];
    }
    if (sql.includes("FROM role_config_files")) return [];
    return [];
  };
  return Object.assign(query, { json: (value: unknown) => value });
}

test("inherit_global leftover project RoleConfig.model does not steal snapshot model", async () => {
  const leftoverProject = {
    id: "project-audit-cfg",
    project_id: "project-1",
    agent_cli: "claude-code",
    model: "grok-4.5",
    version: 3,
    env_vars_json: {},
    env_keys: [],
    modules_json: [],
    skills_json: [],
    commands_json: [],
    mcps_json: [],
    subagents_json: [],
  };
  const globalCfg = {
    id: "global-audit-cfg",
    project_id: null,
    agent_cli: "claude-code",
    model: "grok-4.6",
    version: 8,
    env_vars_json: {},
    env_keys: [],
    modules_json: [],
    skills_json: [],
    commands_json: [],
    mcps_json: [],
    subagents_json: [],
  };
  const credential = {
    id: "cred-local",
    name: "local",
    provider: "anthropic",
    status: "active",
    cred_project_id: null,
    agent_cli: "claude-code",
    settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    meta_json: {},
    public_metadata_json: {},
  };

  for (const projectConfig of [undefined, {}, { image_strategy: "inherit_global" }, { image_strategy: "dirty" }]) {
    const snapshot = await resolveAgentSnapshotForJob(
      snapshotDb({ projectConfig, projectCfg: leftoverProject, globalCfg, credential }),
      "project-1",
      "audit",
    );
    assert.equal(snapshot.model, "grok-4.6", `model under ${JSON.stringify(projectConfig)}`);
    assert.equal(snapshot.upstream_model, "grok-4.6", `upstream_model under ${JSON.stringify(projectConfig)}`);
    assert.equal(snapshot.agent_cli, "claude-code");
  }
});

test("凭据 agent_cli 与角色不一致但 Provider 兼容时按角色解析", async () => {
  const projectCfg = {
    id: "project-hub-cfg",
    project_id: "project-1",
    agent_cli: "pi",
    model: "grok-4.6",
    version: 1,
    env_vars_json: {},
    env_keys: [],
    modules_json: [],
    skills_json: [],
    commands_json: [],
    mcps_json: [],
    subagents_json: [],
  };
  const credential = {
    id: "cred-local",
    name: "local",
    provider: "anthropic",
    status: "active",
    cred_project_id: null,
    agent_cli: "claude-code",
    settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    meta_json: {},
    public_metadata_json: {},
  };
  const snapshot = await resolveAgentSnapshotForJob(
    snapshotDb({
      projectConfig: { image_strategy: "project_managed" },
      projectCfg,
      globalCfg: undefined,
      credential,
    }),
    "project-1",
    "audit",
  );
  assert.equal(snapshot.agent_cli, "pi");
  assert.equal(snapshot.credential_id, "cred-local");
  assert.deepEqual(snapshot.pi_extensions, []);
});

test("Pi RoleConfig 声明冻结已注册扩展，未注册 id 使快照不可解析", async () => {
  const projectCfg = {
    id: "project-hub-cfg",
    project_id: "project-1",
    agent_cli: "pi",
    model: "grok-4.6",
    version: 1,
    env_vars_json: {},
    env_keys: [],
    modules_json: [],
    skills_json: [],
    commands_json: [],
    mcps_json: [],
    subagents_json: [],
    pi_extensions_json: ["pi-web-access"],
  };
  const credential = {
    id: "cred-local",
    name: "local",
    provider: "anthropic",
    status: "active",
    cred_project_id: null,
    agent_cli: "pi",
    settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    meta_json: {},
    public_metadata_json: {},
  };
  const snapshot = await resolveAgentSnapshotForJob(
    snapshotDb({
      projectConfig: { image_strategy: "project_managed" },
      projectCfg,
      globalCfg: undefined,
      credential,
    }),
    "project-1",
    "audit",
  );
  assert.equal(snapshot.pi_extensions.length, 1);
  assert.equal(snapshot.pi_extensions[0]?.id, "pi-web-access");
  assert.equal(snapshot.pi_extensions[0]?.workspace_path, ".pi/agent/extensions/pi-web-access.ts");

  await assert.rejects(
    () => resolveAgentSnapshotForJob(
      snapshotDb({
        projectConfig: { image_strategy: "project_managed" },
        projectCfg: { ...projectCfg, pi_extensions_json: ["not-registered"] },
        globalCfg: undefined,
        credential,
      }),
      "project-1",
      "audit",
    ),
    (error: unknown) => error instanceof SnapshotUnresolvableError && /未注册/.test(error.message),
  );
});

test("凭据 Provider 与角色 CLI 不兼容时是 SnapshotUnresolvableError", async () => {
  const projectCfg = {
    id: "project-hub-cfg",
    project_id: "project-1",
    agent_cli: "claude-code",
    model: "grok-4.6",
    version: 1,
    env_vars_json: {},
    env_keys: [],
    modules_json: [],
    skills_json: [],
    commands_json: [],
    mcps_json: [],
    subagents_json: [],
  };
  const credential = {
    id: "cred-local",
    name: "local",
    provider: "openai",
    status: "active",
    cred_project_id: null,
    agent_cli: "pi",
    settings_config_json: { env: { OPENAI_MODEL: "grok-4.6" } },
    meta_json: {},
    public_metadata_json: {},
  };
  await assert.rejects(
    () => resolveAgentSnapshotForJob(
      snapshotDb({
        projectConfig: { image_strategy: "project_managed" },
        projectCfg,
        globalCfg: undefined,
        credential,
      }),
      "project-1",
      "audit",
    ),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotUnresolvableError);
      assert.match(error.message, /agent_cli claude-code 仅兼容 anthropic，不能使用 provider openai/);
      return true;
    },
  );
});
