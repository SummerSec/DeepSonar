import assert from "node:assert/strict";
import test from "node:test";
import { persistPreparedJob } from "./job-creation.js";
import { withKnowledgeDatabase, seedKnowledgeJob } from "./domains/project-knowledge/test-support.js";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import { freezeAgentRuntimeProfile } from "./agent-runtime-profile.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");
test("prepared Job creation joins caller transaction and freezes Scheduler assignment", async () => {
  await withKnowledgeDatabase(async (db) => {
    const seed = await seedKnowledgeJob(db);
    const snapshot = { runtime_image: { image_key: "deepsonar-base" }, shared_assets: [], platform_tools: ["mark_job_done"] } as unknown as AgentRuntimeSnapshot;
    await assert.rejects(db.begin(async (raw) => {
      const result = await persistPreparedJob(raw as unknown as typeof db,
        { projectId: seed.projectId, canvasId: seed.canvasId, type: "explore" },
        { snapshot, payload: {}, priority: 0 });
      assert.equal(result.created.project_id, seed.projectId);
      throw new Error("fixture rollback");
    }), /fixture rollback/);
    assert.equal((await db`SELECT id FROM jobs WHERE project_id=${seed.projectId}`).length, 1);
  });
});

test("knowledge Pi Jobs remove business extension launches while preserving the provider model route", async () => {
  await withKnowledgeDatabase(async db => {
    const seed = await seedKnowledgeJob(db);
    const snapshot = { agent_cli: "pi", model: "model", reasoning: null, context_window_tokens: null,
      runtime_image: { image_key: "deepsonar-base" }, shared_assets: [], platform_tools: ["mark_job_done"],
      settings_config_json: { providers: { route: { baseUrl: "https://gateway.invalid", api: "openai-responses", models: [{ id: "model" }] } } },
      config_files: [{ path: ".pi/agent/extensions/business.ts", content: "business-only execution" }],
      pi_extensions: [{ id: "business", package: "business", version: "1", integrity: "sha256:business" }],
      runtime_profile: freezeAgentRuntimeProfile({ schema: "deepsonar.agent-runtime-profile/v1", profile_version: 1,
        agent_cli: "pi", provider_ref: null, model_ref: "model", reasoning_effort: null, context_window_tokens: null,
        extensions: [{ id: "business", version: "1", integrity: "sha256:business" }], system_prompt_ref: null, env_refs: [],
        native_options: { claude_code: null, pi: { model: "model", provider: "route", extensions: ["business"], observational_memory: null }, dsh: null },
        resolution_order: ["global", "project", "role", "task", "job"] }),
    } as unknown as AgentRuntimeSnapshot;
    const { snapshotWithKnobs: actual } = await persistPreparedJob(db,
      { projectId: seed.projectId, canvasId: seed.canvasId, type: "analyze" },
      { snapshot, payload: {}, priority: 0, assignment: {
        work_id: "fixture", stage: "maker", inputs: [], governance_hash: "a".repeat(64), source_mode: "project_collection",
      } });
    assert.deepEqual(actual.pi_extensions, []);
    assert.deepEqual(actual.runtime_profile.native_options.pi!.extensions, []);
    assert.equal(actual.runtime_profile.native_options.pi!.observational_memory, null);
    assert.equal(actual.runtime_profile.native_options.pi!.provider, "route");
    assert.ok(!JSON.stringify(actual.agent_runtime_launch).includes("business"));
    assert.deepEqual(actual.config_files.map(file => file.path), [".pi/agent/models.json"]);
    assert.ok(!JSON.stringify(actual.config_files).includes("business"));
    assert.ok(JSON.stringify(actual.config_files).includes("model"));
  });
});

test("trial creation strips answer and external capability channels without granting missing tools", async () => {
  await withKnowledgeDatabase(async db => {
    const seed = await seedKnowledgeJob(db);
    const snapshot = { runtime_image: { image_key: "deepsonar-base" }, shared_assets: [],
      agent_cli: "claude-code", model: null, reasoning: null, context_window_tokens: null,
      settings_config_json: { env: { ANTHROPIC_MODEL: "model" }, hooks: { prompt: "private grading answer" } },
      config_files: [{ path: ".claude/skills/private/SKILL.md", content: "private grading answer" }],
      env_vars: { NODE_OPTIONS: "--import business" }, env_keys: ["BUSINESS_PROMPT"],
      pi_extensions: [{ id: "private-extension" }],
      runtime_profile: freezeAgentRuntimeProfile({ schema: "deepsonar.agent-runtime-profile/v1", profile_version: 1,
        agent_cli: "claude-code", provider_ref: null, model_ref: null, reasoning_effort: null, context_window_tokens: null,
        extensions: [], system_prompt_ref: null, env_refs: [],
        native_options: { claude_code: { model_env: null, effort_level: null }, pi: null, dsh: null },
        resolution_order: ["global", "project", "role", "task", "job"] }),
      network_policy: { allow_egress: true }, instructions_markdown: "private grading answer",
      skills: [{ name: "private-answer" }], commands: ["private"], mcps: ["private"], subagents: ["private"],
      platform_tools: ["mark_job_done", "read_knowledge_input", "graph_query", "pull_skill", "publish_shared_asset"],
      job_skill_catalog: { project_id: seed.projectId, sources: [{ name: "private" }] },
    } as unknown as AgentRuntimeSnapshot;
    const { snapshotWithKnobs: actual } = await persistPreparedJob(db,
      { projectId: seed.projectId, canvasId: seed.canvasId, type: "test" },
      { snapshot, payload: {}, priority: 0, assignment: {
        work_id: "fixture", stage: "trial", inputs: [], governance_hash: "a".repeat(64),
      } });
    assert.deepEqual(actual.network_policy, { allow_egress: false });
    assert.deepEqual(actual.skills, []);
    assert.deepEqual(actual.mcps, []);
    assert.deepEqual(actual.env_vars, {});
    assert.deepEqual(actual.env_keys, []);
    assert.deepEqual(actual.pi_extensions, []);
    assert.deepEqual(actual.runtime_profile.extensions, []);
    assert.ok(!JSON.stringify(actual.config_files).includes("private"));
    assert.ok(!JSON.stringify(actual.settings_config_json).includes("hooks"));
    assert.ok(JSON.stringify(actual.config_files).includes("ANTHROPIC_MODEL"), "provider connection materialization is retained");
    assert.equal(actual.instructions_markdown, null);
    assert.deepEqual(actual.platform_tools, ["mark_job_done", "read_knowledge_input", "publish_shared_asset"]);
    assert.deepEqual(actual.job_skill_catalog.sources, []);
    assert.deepEqual(actual.project_knowledge_catalog?.entries, []);
  });
});
