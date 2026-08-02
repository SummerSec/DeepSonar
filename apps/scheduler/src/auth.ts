import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";

/**
 * 平台 API Token 鉴权（§6.1/SEC-01）
 * - Token 格式：deepsonar_<env>_<prefix>_<secret>；库中只存 sha256 哈希 + 前缀，明文仅创建/轮换时返回一次
 * - DEEPSONAR_AUTH_REQUIRED=true 时除豁免路由外全部要求 Bearer；DEEPSONAR_ADMIN_TOKEN 为引导管理员（不落库）
 * - scope 按路由表判定；admin 隐式拥有全部 scope；token 可限定单项目
 * - Provider Credential（LLM/Plane/Git 密钥）与 API Token 是两套东西，此处只管平台访问
 */

export const ALL_SCOPES = [
  "projects:read",
  "projects:write",
  "tasks:read",
  "tasks:write",
  "jobs:control",
  "findings:read",
  "skills:read",
  "skills:write",
  "agents:read",
  "agents:write",
  "integrations:read",
  "integrations:write",
  "tokens:manage",
  "admin",
] as const;

export interface Actor {
  type: "bootstrap_admin" | "api_token" | "internal";
  id: string | null;
  name: string;
  projectId: string | null;
  scopes: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const INTERNAL: Actor = { type: "internal", id: null, name: "internal", projectId: null, scopes: ["admin"] };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 生成 deepsonar_<env>_<prefix8>_<secret32>；哈希落库，明文只在此刻可见 */
export function generateToken(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `deepsonar_${config.auth.tokenEnv}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashToken(plaintext) };
}

/** 路由 → 所需 scope（§6.1 scope 表）；未列出的写操作默认 admin，读操作只需已认证 */
const ROUTE_SCOPES: Record<string, string> = {
  "GET /projects": "projects:read",
  "POST /projects": "projects:write",
  "POST /projects/sync": "integrations:write",
  "GET /projects/:id": "projects:read",
  "PATCH /projects/:id": "projects:write",
  "POST /projects/:id/archive": "projects:write",
  "POST /projects/:id/tasks": "tasks:write",
  "POST /projects/:id/events": "tasks:write",
  "GET /projects/:id/canvases": "tasks:read",
  "GET /projects/:id/canvas": "tasks:read",
  "GET /projects/:id/settings": "agents:read",
  "PATCH /projects/:id/settings": "agents:write",
  "GET /projects/:id/roles": "agents:read",
  "PUT /projects/:id/integrations/plane": "integrations:write",
  "DELETE /projects/:id/integrations/plane": "integrations:write",
  "POST /projects/:id/integrations/plane/sync": "integrations:write",
  "GET /canvases/:id": "tasks:read",
  "POST /tasks/:canvasId/retry": "jobs:control",
  "POST /jobs": "tasks:write",
  "GET /jobs": "tasks:read",
  "GET /jobs/:id": "tasks:read",
  "PATCH /jobs/:id/priority": "jobs:control",
  "POST /jobs/:id/cancel": "jobs:control",
  "POST /jobs/:id/resume": "jobs:control",
  "GET /findings": "findings:read",
  "GET /skill-sources": "skills:read",
  "GET /skill-sources/:id": "skills:read",
  "POST /skill-sources": "skills:write",
  "POST /skill-sources/:id/sync": "skills:write",
  "POST /skill-sources/:id/trust": "skills:write",
  "DELETE /skill-sources/:id": "skills:write",
  "GET /agent-roles": "agents:read",
  "POST /agent-roles": "agents:write",
  "PATCH /agent-roles/:id": "agents:write",
  "DELETE /agent-roles/:id": "agents:write",
  "GET /role-configs/global": "agents:read",
  "PUT /role-configs/global/:roleId": "agents:write",
  "GET /projects/:id/role-configs": "agents:read",
  "PUT /projects/:id/role-configs/:roleId": "agents:write",
  "DELETE /projects/:id/role-configs/:roleId": "agents:write",
  "GET /global-settings": "agents:read",
  "PATCH /global-settings": "agents:write",
  "GET /plane-info": "integrations:read",
  "GET /tokens": "tokens:manage",
  "POST /tokens": "tokens:manage",
  "POST /tokens/:id/revoke": "tokens:manage",
  "POST /tokens/:id/rotate": "tokens:manage",
  "GET /credentials": "agents:read",
  "GET /audit-logs": "admin",
  "POST /credentials": "agents:write",
  "PATCH /credentials/:id": "agents:write",
  "POST /credentials/:id/rotate": "agents:write",
  "POST /credentials/:id/status": "agents:write",
  "POST /credentials/:id/test": "agents:read",
  "GET /ws": "tasks:read",
};

/** 豁免鉴权的路由（健康检查 + schema 文档 + Plane webhook + Model Gateway，各有自保护） */
const EXEMPT = new Set([
  "/health",
  "/openapi.json",
  "/schema",
  "/schema.md",
  "/webhooks/plane",
  "/gateway/*",
]);

function requiredScope(method: string, routeUrl: string): string | null {
  const key = `${method} ${routeUrl}`;
  if (key in ROUTE_SCOPES) return ROUTE_SCOPES[key];
  return method === "GET" ? null : "admin";
}

function hasScope(actor: Actor, scope: string | null): boolean {
  if (!scope) return true;
  return actor.scopes.includes("admin") || actor.scopes.includes(scope);
}

function deny(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const routeUrl = req.routeOptions?.url ?? req.url.split("?")[0];
  if (EXEMPT.has(routeUrl)) return;

  // §7.2：认证失败与越权必须进审计（不写 Authorization 头/Token 本体）
  const denyAudited = (code: number, error: string, errorCode: string) => {
    inc("deepsonar_api_auth_failed_total", { reason: errorCode });
    void audit(req, {
      action: code === 401 ? "auth.failed" : "auth.denied",
      resourceType: "route",
      resourceId: `${req.method} ${routeUrl}`,
      result: "denied",
      errorCode,
    });
    return deny(reply, code, error);
  };

  // Level A 回环部署可关闭；一旦跨出回环必须 DEEPSONAR_AUTH_REQUIRED=true（.env.example 有警示）
  if (!config.auth.required) {
    req.actor = INTERNAL;
    return;
  }

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return denyAudited(401, "缺少 Authorization: Bearer <token>", "missing_token");

  let actor: Actor | null = null;

  // 引导管理员（环境变量，不落库；用于首次创建 DB token / 应急）
  if (config.auth.adminToken && token === config.auth.adminToken) {
    actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
  } else {
    const m = token.match(/^deepsonar_[a-z0-9]+_([0-9a-f]{8})_[A-Za-z0-9_-]{16,}$/);
    if (!m) return denyAudited(401, "token 格式非法", "bad_format");
    const [row] = await sql`
      SELECT id, name, project_id, token_hash, scopes, expires_at, revoked_at
      FROM api_tokens WHERE token_prefix = ${m[1]}`;
    if (!row) return denyAudited(401, "token 不存在或已吊销", "unknown_token");
    const a = Buffer.from(row.token_hash as string, "utf8");
    const b = Buffer.from(hashToken(token), "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return denyAudited(401, "token 校验失败", "hash_mismatch");
    if (row.revoked_at) return denyAudited(401, "token 已吊销", "revoked");
    if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) {
      return denyAudited(401, "token 已过期", "expired");
    }
    actor = {
      type: "api_token",
      id: row.id as string,
      name: row.name as string,
      projectId: (row.project_id as string | null) ?? null,
      scopes: (row.scopes as string[]) ?? [],
    };
    // 最近使用记录（失败不影响请求）
    void sql`UPDATE api_tokens SET last_used_at = now(), last_ip = ${req.ip} WHERE id = ${actor.id}`.catch(() => {});
  }

  const scope = requiredScope(req.method, routeUrl);
  if (!hasScope(actor, scope)) {
    return denyAudited(403, `scope 不足：需要 ${scope ?? "认证"}`, "insufficient_scope");
  }

  // 项目限定 token：项目路由的 :id 必须匹配（列表类路由在 handler 侧各自过滤，Level A 从简）
  if (actor.projectId && routeUrl.startsWith("/projects/:id")) {
    const pid = (req.params as { id?: string } | undefined)?.id;
    if (pid && pid !== actor.projectId) {
      return denyAudited(403, "token 仅限项目 " + actor.projectId, "project_mismatch");
    }
  }

  req.actor = actor;
}
