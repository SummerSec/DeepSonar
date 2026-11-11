import assert from "node:assert/strict";
import test from "node:test";
import { persistPreparedJob } from "./job-creation.js";
import { withKnowledgeDatabase, seedKnowledgeJob } from "./domains/project-knowledge/test-support.js";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";

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

test("trial creation strips answer and external capability channels without granting missing tools", async () => {
  await withKnowledgeDatabase(async db => {
    const seed = await seedKnowledgeJob(db);
    const snapshot = { runtime_image: { image_key: "deepsonar-base" }, shared_assets: [],
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
    assert.equal(actual.instructions_markdown, null);
    assert.deepEqual(actual.platform_tools, ["mark_job_done", "read_knowledge_input", "publish_shared_asset"]);
    assert.deepEqual(actual.job_skill_catalog.sources, []);
    assert.deepEqual(actual.project_knowledge_catalog?.entries, []);
  });
});
