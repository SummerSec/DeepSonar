import { sql } from "./db.js";
import { createJobInTransaction, ensureCanvasForTaskInTransaction } from "./core.js";
import { createKnowledgeWorkScheduler } from "./domains/project-knowledge/work.js";
import { noteKnowledgeWakeChange, refreshScheduleWakeFromDb } from "./schedule-wake.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./domains/project-knowledge/platform-skills.js";

const workScheduler = createKnowledgeWorkScheduler({
  db: sql, governanceHash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH,
  createJobInTransaction, ensureCanvasForTaskInTransaction,
});

export const projectKnowledgeScheduler = {
  ...workScheduler,
  async tick(stopped: () => boolean = () => false): Promise<number> {
    if (stopped()) return 0;
    // #1219 第四阶段第 3 步：项目批量整理（来源登记 + collector）已退役，
    // 这里只推进显式提出的知识工作，不再扫描历史登记来源。
    const progressed = await workScheduler.tick(stopped);
    // #1287：只有真的推进了才强制回库；没有进展时不能借刷新自激重跑采集查询。
    if (progressed > 0) noteKnowledgeWakeChange();
    if (!stopped()) await refreshScheduleWakeFromDb({ kickDueTasks: false });
    return progressed;
  },
};
