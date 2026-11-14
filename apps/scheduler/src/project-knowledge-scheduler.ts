import { sql } from "./db.js";
import { createJobInTransaction, ensureCanvasForTaskInTransaction } from "./core.js";
import { createKnowledgeWorkScheduler } from "./domains/project-knowledge/work.js";
import { refreshScheduleWakeFromDb } from "./schedule-wake.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./domains/project-knowledge/platform-skills.js";
import { collectProjectKnowledgeSources } from "./domains/project-knowledge/collector.js";

const workScheduler = createKnowledgeWorkScheduler({
  db: sql, governanceHash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH,
  createJobInTransaction, ensureCanvasForTaskInTransaction,
});

export const projectKnowledgeScheduler = {
  ...workScheduler,
  async tick(stopped: () => boolean = () => false): Promise<number> {
    if (stopped()) return 0;
    const collected = await collectProjectKnowledgeSources(sql, PROJECT_KNOWLEDGE_GOVERNANCE_HASH, stopped);
    const progressed = collected + await workScheduler.tick(stopped);
    if (!stopped()) await refreshScheduleWakeFromDb({ kickDueTasks: false });
    return progressed;
  },
};
