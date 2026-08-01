/**
 * 审计日志（§7.2）：管理动作统一入口，append-only（0015 触发器兜底）。
 *
 * 红线（文档原文）：Credential 明文、Authorization Header、Cookie、
 * 模型 API Key 永远不进入审计日志 —— 调用方只传安全字段（id/名称/状态/指纹）。
 */
import type { FastifyRequest } from "fastify";
import { sql } from "./db.js";

export interface AuditEntry {
  action: string;
  projectId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  result?: "ok" | "denied" | "error";
  errorCode?: string | null;
}

/** 从请求上下文写审计（actor 由 authHook 放置；无 actor 记 anonymous，如认证失败） */
export async function audit(req: FastifyRequest, entry: AuditEntry): Promise<void> {
  const actor = req.actor;
  try {
    await sql`
      INSERT INTO audit_logs ${sql({
        actor_type: actor?.type ?? "anonymous",
        actor_id: actor?.name ?? "anonymous",
        action: entry.action,
        project_id: entry.projectId ?? null,
        resource_type: entry.resourceType ?? null,
        resource_id: entry.resourceId ?? null,
        request_id: (req.id as string) ?? null,
        ip: req.ip ?? null,
        user_agent: (req.headers["user-agent"] as string)?.slice(0, 300) ?? null,
        before_json: entry.before === undefined ? null : sql.json(entry.before as never),
        after_json: entry.after === undefined ? null : sql.json(entry.after as never),
        result: entry.result ?? "ok",
        error_code: entry.errorCode ?? null,
      })}`;
  } catch (e) {
    // 审计失败不阻断业务，但必须留痕（否则静默丢审计）
    console.error(`[audit] 写入失败 ${entry.action}:`, e instanceof Error ? e.message : e);
  }
}
