import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { sql } from "../../db.js";
import {
  PLATFORM_CLAIMS_ALREADY_PAUSED,
  PLATFORM_CLAIMS_INVALID_BODY,
  PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH,
  PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN,
  PLATFORM_CLAIMS_STATE_MISSING,
  PlatformClaimsPauseBody,
  PlatformClaimsResumeBody,
  platformClaimsActorLabel,
  projectPlatformClaimsStatus,
} from "./model.js";
import {
  loadPlatformClaimsWorkload,
  pausePlatformClaims,
  readPlatformClaimsControl,
  resumePlatformClaims,
} from "./store.js";

type Db = typeof sql;

async function currentStatus(db: Db) {
  const [control, workload] = await Promise.all([
    readPlatformClaimsControl(db),
    loadPlatformClaimsWorkload(db),
  ]);
  return projectPlatformClaimsStatus(control, workload);
}

function invalidBody(reply: FastifyReply, error: unknown) {
  return reply.code(400).send({
    error: error instanceof z.ZodError ? (error.issues[0]?.message ?? "invalid body") : "invalid body",
    error_code: PLATFORM_CLAIMS_INVALID_BODY,
    details: error instanceof z.ZodError ? error.issues : undefined,
  });
}

/** Platform-wide pause is never delegated to a project-scoped token, whatever its scopes. */
function isProjectScopedActor(req: FastifyRequest): boolean {
  return Boolean(req.actor?.projectId);
}

function projectScopedForbidden(reply: FastifyReply) {
  return reply.code(403).send({
    error: "项目级 token 不能控制平台级领取暂停",
    error_code: PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN,
  });
}

function stateMissing(reply: FastifyReply) {
  return reply.code(503).send({
    error: "global_settings 单例行缺失；调度已 fail closed，请按 schema 基线重建",
    error_code: PLATFORM_CLAIMS_STATE_MISSING,
  });
}

/**
 * #740 Slice 1：平台级全局暂停领取管理 API。
 *
 * - GET 返回持久化暂停状态与在途数量，供 Web 全局横幅和宿主机升级程序轮询排空；
 * - pause / resume 仅平台管理员（admin），写审计；不取消、不杀、不重放在途 Job。
 */
export function registerPlatformClaimsRoutes(app: FastifyInstance, db: Db = sql): void {
  app.get("/platform/claims", async (req, reply) => {
    if (isProjectScopedActor(req)) return projectScopedForbidden(reply);
    return currentStatus(db);
  });

  app.post("/platform/claims/pause", async (req, reply) => {
    if (isProjectScopedActor(req)) return projectScopedForbidden(reply);
    let body: z.infer<typeof PlatformClaimsPauseBody>;
    try {
      body = PlatformClaimsPauseBody.parse(req.body ?? {});
    } catch (error) {
      return invalidBody(reply, error);
    }
    const result = await pausePlatformClaims(db, {
      reason: body.reason,
      note: body.note ?? null,
      actor: platformClaimsActorLabel(req.actor),
    });
    if (result.kind === "missing") return stateMissing(reply);
    if (result.decision.kind === "conflict") {
      return reply.code(409).send({
        error: `平台领取已因 ${result.decision.current ?? "unknown"} 暂停；请先解除后再以新原因暂停`,
        error_code: PLATFORM_CLAIMS_ALREADY_PAUSED,
        current_reason: result.decision.current,
      });
    }
    const changed = result.decision.kind === "apply";
    if (changed) {
      await audit(req, {
        action: "platform.claims_pause",
        resourceType: "global_settings",
        resourceId: "global",
        before: { claims_paused: result.before.paused },
        after: { claims_paused: true, reason: body.reason, note_present: Boolean(body.note) },
      });
    }
    return { changed, ...(await currentStatus(db)) };
  });

  app.post("/platform/claims/resume", async (req, reply) => {
    if (isProjectScopedActor(req)) return projectScopedForbidden(reply);
    let body: z.infer<typeof PlatformClaimsResumeBody>;
    try {
      body = PlatformClaimsResumeBody.parse(req.body ?? {});
    } catch (error) {
      return invalidBody(reply, error);
    }
    const result = await resumePlatformClaims(db, { reason: body.reason });
    if (result.kind === "missing") return stateMissing(reply);
    if (result.decision.kind === "mismatch") {
      return reply.code(409).send({
        error: `平台领取暂停原因为 ${result.decision.current ?? "unknown"}，与请求的 ${body.reason} 不一致；未解除`,
        error_code: PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH,
        current_reason: result.decision.current,
      });
    }
    const changed = result.decision.kind === "apply";
    if (changed) {
      await audit(req, {
        action: "platform.claims_resume",
        resourceType: "global_settings",
        resourceId: "global",
        before: { claims_paused: true, reason: result.before.reason },
        after: { claims_paused: false },
      });
    }
    return { changed, ...(await currentStatus(db)) };
  });
}
