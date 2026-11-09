import { sql } from "./db.js";
import { createJobInTransaction, ensureCanvasForTaskInTransaction } from "./core.js";
import { createKnowledgeWorkScheduler } from "./domains/project-knowledge/work.js";
import { refreshScheduleWakeFromDb } from "./schedule-wake.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./domains/project-knowledge/platform-skills.js";

const workScheduler = createKnowledgeWorkScheduler({
  db: sql, governanceHash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH,
  createJobInTransaction, ensureCanvasForTaskInTransaction,
});

export const projectKnowledgeScheduler = {
  ...workScheduler,
  async tick(stopped: () => boolean = () => false): Promise<number> {
    if (stopped()) return 0;
    const progressed = await workScheduler.tick(stopped);
    if (!stopped()) await refreshScheduleWakeFromDb({ kickDueTasks: false });
    return progressed;
  },
};
