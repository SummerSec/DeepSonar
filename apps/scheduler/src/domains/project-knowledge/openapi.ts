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
  get(prefix, "项目知识目录（包含候选和历史状态，无人工激活入口）", { ...page, kind: { type: "string", enum: ["memory", "skill"] }, status: { type: "string", enum: ["draft", "active", "stale", "retired", "revoked"] }, query: { type: "string", maxLength: 200 } }),
  { ...get(prefix + "/receipts", "按原 Job 读取持久操作回执，适用于终态与重启后", { ...page, job_id: { type: "string", format: "uuid" } }), requiredQuery: ["job_id"] },
  get(prefix + "/receipts/{receiptId}", "读取项目范围内持久回执"),
  get(prefix + "/{itemId}", "知识详情、版本、来源、评测审查和使用记录"),
  get(prefix + "/{itemId}/versions", "分页读取历史版本", page),
  get(version, "读取知识精确版本（来源项目管理权限）"),
  get(version + "/grants", "查看精确版本授权"),
  post(version + "/grants", "来源项目授权另一个项目使用精确 Skill 版本，不授权来源资料", {
    type: "object", additionalProperties: false, required: ["grantee_project_id"],
    properties: { grantee_project_id: { type: "string", format: "uuid" } },
  }),
  post(prefix + "/grants/{grantId}/revoke", "不可逆撤销精确授权；新授权不复活旧 Job", reason),
  post(version + "/revoke", "不可逆撤销知识版本并保留历史记录", reason),
];
