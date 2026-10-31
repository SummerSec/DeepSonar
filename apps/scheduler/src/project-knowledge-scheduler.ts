import { sql } from "./db.js";
import { createJobInTransaction, ensureCanvasForTaskInTransaction } from "./core.js";
import { createKnowledgeWorkScheduler } from "./domains/project-knowledge/work.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./domains/project-knowledge/platform-skills.js";

export const projectKnowledgeScheduler = createKnowledgeWorkScheduler({
  db: sql, governanceHash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH,
  createJobInTransaction, ensureCanvasForTaskInTransaction,
});
