import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "../../db.js";
import { PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN } from "./model.js";
import { readPlatformUpdateCheck } from "./store.js";

type Db = typeof sql;

/** Platform update status is never delegated to a project-scoped token. */
function isProjectScopedActor(req: FastifyRequest): boolean {
  return Boolean(req.actor?.projectId);
}

function projectScopedForbidden(reply: FastifyReply) {
  return reply.code(403).send({
    error: "项目级 token 不能读取平台更新检查",
    error_code: PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN,
  });
}

/**
 * #740 Slice 2：平台版本发现只读 API。
 *
 * GET 返回最近一次清单同步写入的检查结果，供 Web 管理端提示；不提供升级 apply。
 * 仅平台管理员（admin）；项目级 token 拒绝。
 */
export function registerPlatformUpdateRoutes(app: FastifyInstance, db: Db = sql): void {
  app.get("/platform/updates", async (req, reply) => {
    if (isProjectScopedActor(req)) return projectScopedForbidden(reply);
    return readPlatformUpdateCheck(db);
  });
}
