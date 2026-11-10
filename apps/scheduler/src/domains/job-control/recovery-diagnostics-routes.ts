/**
 * 只读恢复诊断与管理面（#1036 A1/D3 slice）。
 *
 * 语义边界：
 * — 两条 GET 都只读（管理 grant 不从这里产生新动作），POST/结算仍走既有路由；
 * — output 只含枚举 / UUID / 计数 / 戳，不携带 summary、message、finding 标题
 *   或 effect error 原文（ 业务文本经 evidence 端点检索，诊断面不做证据重放）；
 * — scope 与单条 effect 结清一致（admin + 项目范围），跨项目全量面仅 admin。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { PROJECT_MISMATCH, projectScopeAllows } from "../../project-scope.js";
import {
  readRecoveryDiagnostics,
  readWaitingClassification,
  WAITING_CLASSIFICATION_MAX_LIMIT,
  WAITING_CLASSIFICATION_STATUSES,
} from "./recovery-diagnostics.js";

const WaitingQuery = z.object({
  project_id: z.string().trim().max(2000).optional().default("").transform((value: string) => {
    if (!value) return [] as string[];
    return value.split(",").map((part: string) => part.trim().toLowerCase()).filter(Boolean);
  }),
  status: z.string().trim().max(120).optional().default("").transform((value: string) => {
    if (!value) return undefined;
    return value.split(",").map((part: string) => part.trim()).filter(Boolean);
  }),
  limit: z.coerce.number().int().min(1).max(WAITING_CLASSIFICATION_MAX_LIMIT).optional().default(50),
});
const WaitingQueryInput = z.object({
  project_id: z.array(z.string().uuid().toLowerCase()),
  status: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(WAITING_CLASSIFICATION_MAX_LIMIT),
});
const Params = z.object({ id: z.string().uuid().toLowerCase() });
const fail = (reply: FastifyReply, status: number, code: string, error: string) => reply.code(status).send({ error, error_code: code });

export function registerRecoveryDiagnosticsRoutes(app: FastifyInstance): void {
  app.get("/jobs/waiting-classification", async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = req.actor;
    if (!actor) return fail(reply, 401, "AUTH_REQUIRED", "authentication required");
    if (!actorHasScope(actor, "admin")) {
      return fail(reply, 403, "WAITING_CLASSIFICATION_FORBIDDEN", "waiting inventory requires admin");
    }
    const raw = WaitingQuery.safeParse(req.query);
    if (!raw.success) return fail(reply, 400, "WAITING_CLASSIFICATION_INVALID", hq(raw.error));
    const parsed = WaitingQueryInput.safeParse(raw.data);
    if (!parsed.success) return fail(reply, 400, "WAITING_CLASSIFICATION_INVALID", "query fields are invalid");
    const statuses = (parsed.data.status ?? []).filter((value: string) =>
      (WAITING_CLASSIFICATION_STATUSES as readonly string[]).includes(value)) as
      (typeof WAITING_CLASSIFICATION_STATUSES)[number][];
    if (parsed.data.status && parsed.data.status.length !== statuses.length) {
      return fail(reply, 400, "WAITING_CLASSIFICATION_INVALID", "status must be a subset of waiting/terminal recovery set");
    }
    const projectIds = parsed.data.project_id;
    if (projectIds.length && !projectScopeAllows(actor.projectId, projectIds[0])) {
      return fail(reply, 403, PROJECT_MISMATCH, "project mismatch");
    }
    // List-only read: audit noise would exceed the ledger design; denial path
    // stays in the standard auth pipeline typed above.
    const entries = await readWaitingClassification({ projectIds, statuses: statuses.length ? statuses : undefined, limit: parsed.data.limit });
    return {
      items: entries,
      count: entries.length,
      limit: parsed.data.limit,
      project_scoped: Boolean(projectIds.length),
    };
  });

  app.get("/jobs/:id/recovery-diagnostics", async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = req.actor;
    if (!actor) return fail(reply, 401, "AUTH_REQUIRED", "authentication required");
    if (!actorHasScope(actor, "admin")) {
      return fail(reply, 403, "RECOVERY_DIAGNOSTICS_FORBIDDEN", "recovery diagnostics requires admin");
    }
    const params = Params.safeParse(req.params);
    if (!params.success) return fail(reply, 400, "RECOVERY_DIAGNOSTICS_INVALID", "invalid job id");
    const diagnostics = await readRecoveryDiagnostics(sql, params.data.id);
    if (!diagnostics) return fail(reply, 404, "JOB_NOT_FOUND", "job not found");
    if (!projectScopeAllows(actor.projectId, diagnostics.project_id)) {
      return fail(reply, 403, PROJECT_MISMATCH, "project mismatch");
    }
    return diagnostics;
  });
}

/** 与 route-surface 表一致：管理面 query 校验失败固定 400 + 稳定 error_code。 */
function hq(error: z.ZodError): string {
  const first = error.issues[0];
  return first ? `${first.path.join(".") || "query"}: ${first.message}` : "query fields are invalid";
}
