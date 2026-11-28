/**
 * 知识整理链路的审计动作与 trigger 前缀。
 *
 * 旧的项目批量整理（业务 Job 终态登记来源 + collector 批量收集）已在 #1219 第四阶段
 * 第 3 步整体退役；这些常量仍被收尾评估（closeout-evaluation）与在途工作判定（work）
 * 引用，因此单独保留在本模块，不再依赖已删除的 collector / automatic 模块。
 */
export const SOURCE_REGISTERED_ACTION = "project_knowledge.source_registered";
export const SOURCE_COLLECTED_ACTION = "project_knowledge.source_collected";
export const SOURCE_SKIPPED_ACTION = "project_knowledge.source_collection_skipped";
export const PROJECT_COLLECTION_PREFIX = "knowledge:project:";
