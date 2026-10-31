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
