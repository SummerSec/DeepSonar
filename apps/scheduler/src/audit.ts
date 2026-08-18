/**
 * 审计日志（§7.2）：管理动作统一入口，append-only（0015 触发器兜底）。
 *
 * 红线（文档原文）：Credential 明文、Authorization Header、Cookie、
 * 模型 API Key 永远不进入审计日志 —— 调用方只传安全字段（id/名称/状态/指纹）。
 */
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "./db.js";
import { allowedModelIds, projectCredentialProvider } from "./credentials.js";

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

function canonicalizeMetadata(input: unknown): unknown {
  if (Array.isArray(input)) return { type: "array", length: input.length, items: input.map(canonicalizeMetadata) };
  if (input && typeof input === "object") {
    const object = input as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, canonicalizeMetadata(object[key])]),
    );
  }
  if (typeof input === "string") return { type: "string", length: input.length };
  if (typeof input === "number") return { type: "number", integer: Number.isInteger(input) };
  if (typeof input === "boolean") return { type: "boolean" };
  if (input === null) return { type: "null" };
  return { type: typeof input };
}

/**
 * Return only bounded, non-secret evidence for a Credential metadata change.
 *
 * public_metadata_json is intentionally extensible and user-controlled, so
 * neither its keys nor values may be copied into an audit entry.  Keep only
 * fixed-shape counts/presence flags and a SHA-256 fingerprint of value shapes
 * as change evidence.  This makes the summary useful without allowing a
 * secret to be smuggled through a metadata key, model id, URL, or arbitrary value.
 */
export function summarizeCredentialMetadata(input: unknown): Record<string, unknown> {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const allKeys = Object.keys(record);
  const metadataSha256 = createHash("sha256")
    .update(JSON.stringify(canonicalizeMetadata(record)), "utf8")
    .digest("hex");
  const allowed = allowedModelIds(record);
  const rawConcurrency = record.model_concurrency;
  const modelConcurrencyCount = rawConcurrency && typeof rawConcurrency === "object" && !Array.isArray(rawConcurrency)
    ? Object.keys(rawConcurrency).length
    : 0;
  const summary: Record<string, unknown> = {
    metadata_key_count: allKeys.length,
    metadata_shape_sha256: metadataSha256,
    base_url_present: Object.prototype.hasOwnProperty.call(record, "base_url"),
    allowed_model_ids_present: Object.prototype.hasOwnProperty.call(record, "allowed_model_ids"),
    allowed_model_count: allowed.length,
    model_concurrency_present: Object.prototype.hasOwnProperty.call(record, "model_concurrency"),
    model_concurrency_count: modelConcurrencyCount,
    max_concurrent_present: Object.prototype.hasOwnProperty.call(record, "max_concurrent"),
  };

  if (typeof record.max_concurrent === "number" && Number.isInteger(record.max_concurrent)
    && record.max_concurrent >= 0 && record.max_concurrent <= 1000) {
    summary.max_concurrent = record.max_concurrent;
  }
  return summary;
}

/** Safe before/after shape used by credential.update audit entries. */
export function credentialAuditState(input: {
  name: unknown;
  provider: unknown;
  kind?: unknown;
  projectId: unknown;
  metadata: unknown;
}): Record<string, unknown> {
  const providerProjection = typeof input.provider === "string" && input.provider !== ""
    ? projectCredentialProvider(input.kind ?? "llm_provider", input.provider)
    : {
        provider: typeof input.provider === "string" ? input.provider : null,
        provider_valid: false,
      };
  return {
    name: typeof input.name === "string" ? input.name : null,
    ...providerProjection,
    project_id: typeof input.projectId === "string" ? input.projectId : null,
    metadata: summarizeCredentialMetadata(input.metadata),
  };
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

/** Scheduler / Worker 系统动作：无 HTTP 请求上下文。 */
export async function auditSystem(entry: AuditEntry & { actorId?: string }): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_logs ${sql({
        actor_type: "system",
        actor_id: entry.actorId ?? "scheduler",
        action: entry.action,
        project_id: entry.projectId ?? null,
        resource_type: entry.resourceType ?? null,
        resource_id: entry.resourceId ?? null,
        request_id: null,
        ip: null,
        user_agent: null,
        before_json: entry.before === undefined ? null : sql.json(entry.before as never),
        after_json: entry.after === undefined ? null : sql.json(entry.after as never),
        result: entry.result ?? "ok",
        error_code: entry.errorCode ?? null,
      })}`;
  } catch (e) {
    console.error(`[audit] 系统写入失败 ${entry.action}:`, e instanceof Error ? e.message : e);
  }
}
