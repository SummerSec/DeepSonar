import type { Op } from "../../openapi.js";
const prefix = "/projects/{id}/knowledge";
const version = prefix + "/{itemId}/versions/{versionId}";
const page = { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }, offset: { type: "integer", minimum: 0, default: 0 } };
const reason = { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } } };
const get = (path: string, summary: string, query?: Record<string, unknown>): Op =>
  ({ method: "get", path, summary, tags: ["Project knowledge"], scope: "projects:read", ...(query ? { query } : {}) });
const post = (path: string, summary: string, body: Record<string, unknown>): Op =>
  ({ method: "post", path, summary, tags: ["Project knowledge"], scope: "projects:write", body });
export const KNOWLEDGE_MANAGEMENT_OPERATIONS: Op[] = [
  get(prefix + "/activity", "项目知识来源、积累、复用/反馈摘要及分页整理工作；反馈不是质量认证", {
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }, offset: page.offset,
  }),
  get(prefix + "/backfill", "只读查询历史任务沉淀：来源登记/采集/跳过审计与旧收尾状态；不判定资格、不触发整理", {
    ...page,
  }),
  get(prefix + "/closeout/{rootId}", "按原任务轮次只读查看知识沉淀，建议正文按来源和目标权限显示", {
    limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }, offset: page.offset,
  }),
  post(prefix + "/closeout/{rootId}/evaluate", "送评一条原画布候选（还需读取任务和来源的权限），评测后保留草稿", {
    type: "object", additionalProperties: false, required: ["candidate_ref"],
    properties: { candidate_ref: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  }),
  get(prefix, "项目知识目录（包含候选和历史状态，无人工激活入口；每项附带当前版本短文摘要 summary 与按该版本聚合的 feedback 计数，含 unrated，零记录时各计数为 0）", { ...page, kind: { type: "string", enum: ["memory", "skill"] }, status: { type: "string", enum: ["draft", "active", "stale", "retired", "revoked"] }, query: { type: "string", maxLength: 200 } }),
  { ...get(prefix + "/receipts", "按原 Job 读取持久操作回执，适用于终态与重启后", { ...page, job_id: { type: "string", format: "uuid" } }), requiredQuery: ["job_id"] },
  get(prefix + "/receipts/{receiptId}", "读取项目范围内持久回执"),
  get(prefix + "/{itemId}", "知识详情、版本、来源、评测审查和使用记录"),
  get(prefix + "/{itemId}/versions", "分页读取历史版本", page),
  get(version + "/feedback", "某版本的评价计数与明细（时间倒序；outcome=success|failure|inapplicable|unrated，unrated 表示读过但未分类评价；只有所属项目可读，来源引用保持不透明）", { ...page, outcome: { type: "string", enum: ["success", "failure", "inapplicable", "unrated"] } }),
  get(version, "读取知识精确版本（来源项目管理权限）"),
  get(version + "/grants", "查看精确版本授权"),
  post(version + "/grants", "来源项目授权另一个项目使用精确 Skill 版本，不授权来源资料", {
    type: "object", additionalProperties: false, required: ["grantee_project_id"],
    properties: { grantee_project_id: { type: "string", format: "uuid" } },
  }),
  post(prefix + "/grants/{grantId}/revoke", "不可逆撤销精确授权；新授权不复活旧 Job", reason),
  post(version + "/revoke", "不可逆撤销知识版本并保留历史记录", reason),
  post(prefix, "项目操作员新建人类维护的知识条目（记忆正文或已验证的 Skill 文件包），直接生效并记录作者", {
    type: "object", additionalProperties: false, required: ["kind", "logical_key", "title"],
    properties: {
      kind: { type: "string", enum: ["memory", "skill"] },
      logical_key: { type: "string", minLength: 1, maxLength: 160, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._/-]*$" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      keywords: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
      content: { type: "string", maxLength: 12288 },
      files: { type: "object", description: "Skill 文件包；与 content 互斥" },
    },
  }),
  post(prefix + "/{itemId}/versions", "按 expected_version 编辑人类维护的知识，生成新版本并保留历史", {
    type: "object", additionalProperties: false, required: ["expected_version", "title"],
    properties: {
      expected_version: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      keywords: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
      content: { type: "string", maxLength: 12288 },
      files: { type: "object", description: "Skill 文件包；与 content 互斥" },
      reason: { type: "string", minLength: 1, maxLength: 2000, description: "可选的修订原因；与这一版一起保留" },
    },
  }),
  post(prefix + "/{itemId}/archive", "项目操作员下架知识（retired + archived_by_user），不删除历史版本", {
    type: "object", additionalProperties: false, properties: {},
  }),
  post(prefix + "/{itemId}/restore", "只恢复被用户下架的条目；评测淘汰与撤回不可恢复", {
    type: "object", additionalProperties: false, properties: {},
  }),
];
