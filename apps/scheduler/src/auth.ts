import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { resolveSessionToken } from "./users.js";

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
  "findings:write",
  "assets:read",
  "assets:write",
  "assets:manage",
  "skills:read",
  "skills:write",
  "agents:read",
  "agents:write",
  "images:read",
  "images:manage",
  "images:approve",
  "integrations:read",
  "integrations:write",
  "tokens:manage",
  "exports:read",
  "exports:write",
  "imports:read",
  "imports:write",
  "admin",
] as const;

export interface Actor {
  type: "bootstrap_admin" | "api_token" | "user" | "internal";
  id: string | null;
  name: string;
  projectId: string | null;
  scopes: string[];
  /** 用户角色（仅 type=user） */
  role?: "admin" | "operator" | "viewer";
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
  "GET /dashboard/overview": "projects:read",
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
  "GET /canvases/:id/broadcasts": "tasks:read",
  "GET /canvases/:id/messages": "tasks:read",
  "POST /canvases/:id/messages": "tasks:write",
  "GET /canvases/:id/summary": "tasks:read",
  "GET /canvases/:id/delta": "tasks:read",
  "GET /canvases/:id/nodes/:nodeId": "tasks:read",
  "GET /canvases/:id/facts": "tasks:read",
  "GET /canvases/:id/facts/:nodeId": "tasks:read",
  "PATCH /canvases/:id/facts/:nodeId/verification": "jobs:control",
  "GET /canvases/:id/report": "tasks:read",
  "GET /canvases/:id/report/availability": "tasks:read",
  "GET /canvases/:id/reports": "tasks:read",
  "GET /findings/:id/report": "findings:read",
  "POST /findings/:id/report": "jobs:control",
  // Internal resolver marker: authHook maps it to tasks:read or findings:read
  // after resolving the report scope. It is not an assignable token scope.
  "GET /reports/:id/markdown": "report:read",
  "GET /reports/:id/sarif": "tasks:read",
  "POST /canvases/:id/report/retry": "jobs:control",
  "POST /canvases/:id/report/refresh": "jobs:control",
  "POST /tasks/:canvasId/pause": "jobs:control",
  "POST /tasks/:canvasId/start": "jobs:control",
  "POST /tasks/:canvasId/retry": "jobs:control",
  "POST /tasks/:canvasId/resume-session": "jobs:control",
  "POST /tasks/:canvasId/archive": "tasks:write",
  "POST /tasks/:canvasId/unarchive": "tasks:write",
  "DELETE /tasks/:canvasId": "tasks:write",
  "POST /jobs": "tasks:write",
  "GET /jobs": "tasks:read",
  "GET /jobs/:id": "tasks:read",
  "GET /jobs/:id/events": "tasks:read",
  "GET /jobs/:id/evidence": "tasks:read",
  "GET /jobs/:id/evidence/session": "tasks:read",
  "GET /jobs/:id/evidence/session/download": "tasks:read",
  "GET /jobs/:id/evidence/stream": "tasks:read",
  "PATCH /jobs/:id/priority": "jobs:control",
  "POST /jobs/:id/cancel": "jobs:control",
  "POST /canvases/:id/jobs/cancel-active": "jobs:control",
  "POST /jobs/:id/resume": "jobs:control",
  "POST /jobs/:id/rerun-current": "jobs:control",
  "GET /findings": "findings:read",
  "GET /findings/:id": "findings:read",
  "PATCH /findings/:id/verify-status": "findings:write",
  "POST /findings/:id/verify": "jobs:control",
  "POST /findings/:id/evidence-jobs": "jobs:control",
  "PATCH /findings/:id/disposition": "findings:write",
  "POST /findings/:id/comments": "findings:write",
  "DELETE /findings/:id/comments/:commentId": "findings:write",
  "POST /findings/:id/links": "findings:write",
  "DELETE /findings/:id/links/:linkId": "findings:write",
  "GET /projects/:id/shared-assets": "assets:read",
  "POST /projects/:id/shared-assets": "assets:write",
  "GET /projects/:id/shared-assets/policy": "assets:read",
  "PATCH /projects/:id/shared-assets/policy": "assets:write",
  "GET /findings/:id/shared-assets": "assets:read",
  "POST /findings/:id/shared-assets": "assets:write",
  "GET /platform/shared-assets": "assets:manage",
  "POST /platform/shared-assets": "assets:manage",
  "POST /shared-assets/:id/archive": "assets:write",
  "GET /shared-assets/:id/content": "assets:read",
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
  "GET /role-configs/bindable": "agents:read",
  "PATCH /role-configs/:id/agent-cli": "agents:write",
  "PATCH /role-configs/:id/runtime-image": "agents:write",
  "PUT /role-configs/global/:roleId": "agents:write",
  "GET /projects/:id/role-configs": "agents:read",
  "PUT /projects/:id/role-configs/:roleId": "agents:write",
  "DELETE /projects/:id/role-configs/:roleId": "agents:write",
  "GET /runtime-images": "images:read",
  "GET /runtime-images/registry": "images:read",
  "PATCH /runtime-images/registry/channel": "images:manage",
  "POST /runtime-images/registry/sync": "images:manage",
  "POST /runtime-images/registry/pull": "images:manage",
  "GET /runtime-images/registry/pull-status": "images:read",
  "POST /runtime-images/:id/detect-local": "images:read",
  "POST /runtime-images/:id([0-9a-fA-F-]{36})/detect-local": "images:read",
  "POST /runtime-images/:id/adopt-local": "images:approve",
  "POST /runtime-images/:id([0-9a-fA-F-]{36})/adopt-local": "images:approve",
  "GET /runtime-images/:id": "images:read",
  "GET /runtime-images/:id([0-9a-fA-F-]{36})": "images:read",
  "POST /runtime-images/import": "images:manage",
  "POST /runtime-images/:id/official-digest": "images:approve",
  "POST /runtime-images/manual-digest": "images:approve",
  "POST /runtime-image-versions/:id/rescan": "images:manage",
  "POST /runtime-image-versions/:id/status": "images:approve",
  "GET /runtime-image-versions/:id/usage": "images:read",
  "PUT /projects/:id/runtime-images/:imageId": "images:manage",
  "GET /global-settings": "agents:read",
  "PATCH /global-settings": "agents:write",
  "GET /readiness": "agents:read",
  "GET /projects/:id/readiness": "agents:read",
  "GET /plane-info": "integrations:read",
  "GET /tokens": "tokens:manage",
  "POST /tokens": "tokens:manage",
  "POST /tokens/:id/revoke": "tokens:manage",
  "POST /tokens/:id/rotate": "tokens:manage",
  // /auth/me / logout：任意已认证主体（user / api_token / bootstrap）
  "POST /auth/change-password": "projects:read",
  "POST /auth/change-username": "projects:read",
  "POST /auth/ws-ticket": "tasks:read",
  "GET /users": "admin",
  "POST /users": "admin",
  "PATCH /users/:id": "admin",
  "POST /users/:id/password": "admin",
  "GET /credentials": "agents:read",
  "GET /credentials/providers": "agents:read",
  "GET /credentials/:id": "agents:read",
  "GET /credentials/:id/impact": "agents:read",
  "GET /credentials/:id/models": "agents:read",
  "GET /credentials/:id/compatibility": "agents:read",
  "GET /audit-logs": "admin",
  "POST /credentials": "agents:write",
  "POST /credentials/batch-bind": "agents:write",
  "PATCH /credentials/:id": "agents:write",
  "POST /credentials/:id/rotate": "agents:write",
  "POST /credentials/:id/status": "agents:write",
  "POST /credentials/:id/test": "agents:write",
  "POST /credentials/:id/models": "agents:write",
  "POST /credentials/models/preview": "agents:write",
  "DELETE /credentials/:id": "agents:write",
  "GET /ws": "tasks:read",
  "GET /terminal-ws": "jobs:control",
  "POST /projects/:id/exports": "exports:write",
  "GET /projects/:id/exports": "exports:read",
  "POST /platform/exports": "exports:write",
  "GET /platform/exports": "exports:read",
  "GET /exports/:id": "exports:read",
  "GET /exports/:id/download": "exports:read",
  "POST /exports/:id/cancel": "exports:write",
  "DELETE /exports/:id": "exports:write",
  "POST /imports": "imports:write",
  "GET /imports/:id": "imports:read",
  "POST /imports/:id/preview": "imports:write",
  "POST /imports/:id/apply": "imports:write",
  "POST /imports/:id/cancel": "imports:write",
  "DELETE /imports/:id": "imports:write",
};

/** 精确豁免路径（健康检查 + 登录引导 + schema 文档 + Plane webhook） */
const EXEMPT = new Set([
  "/health",
  "/openapi.json",
  "/schema",
  "/schema.md",
  "/webhooks/plane",
  "/auth/status",
  "/auth/login",
  "/auth/bootstrap",
  // Browser WebSocket upgrades cannot reliably carry an Authorization header;
  // the route consumes a short-lived one-use ticket in its handler instead.
  "/ws",
  "/terminal-ws",
]);

/** 前缀豁免：Gateway 与 Job-scoped Control API 各自使用独立短期 token 自鉴权。 */
const EXEMPT_PREFIXES = ["/gateway", "/control/v1/jobs"];

function isExempt(routeUrl: string, rawPath: string): boolean {
  if (EXEMPT.has(routeUrl) || EXEMPT.has(rawPath)) return true;
  return EXEMPT_PREFIXES.some((p) => rawPath === p || rawPath.startsWith(p + "/"));
}

function requiredScope(method: string, routeUrl: string): string | null {
  const key = `${method} ${routeUrl}`;
  if (key in ROUTE_SCOPES) return ROUTE_SCOPES[key];
  return method === "GET" ? null : "admin";
}

/** Expose the route-scope lookup for contract tests and generated API checks. */
export function requiredScopeForRoute(method: string, routeUrl: string): string | null {
  return requiredScope(method, routeUrl);
}

export function actorHasScope(actor: Actor, scope: string | null): boolean {
  if (!scope) return true;
  // Management implies the corresponding asset/image read capability.
  if (scope === "images:read" && actor.scopes.includes("images:manage")) return true;
  if ((scope === "assets:read" || scope === "assets:write") && actor.scopes.includes("assets:manage")) return true;
  return actor.scopes.includes("admin") || actor.scopes.includes(scope);
}

function deny(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const rawPath = (req.url ?? "").split("?")[0];
  const routeUrl = req.routeOptions?.url ?? rawPath;
  if (isExempt(routeUrl, rawPath)) return;

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

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  // Level A 回环：未强制鉴权时无 internal；若带了 Bearer 仍解析真实主体（便于本地调试用户登录）
  if (!config.auth.required && !token) {
    req.actor = INTERNAL;
    return;
  }

  if (!token) return denyAudited(401, "缺少 Authorization: Bearer <token>", "missing_token");

  let actor: Actor | null = null;

  // 引导管理员（环境变量，不落库；用于首次创建 DB token / 应急）
  if (config.auth.adminToken && token === config.auth.adminToken) {
    actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
  } else if (token.startsWith("deepsonar_user_")) {
    // 用户会话
    const sess = await resolveSessionToken(token);
    if (!sess) {
      if (!config.auth.required) {
        req.actor = INTERNAL;
        return;
      }
      return denyAudited(401, "会话无效或已过期", "bad_session");
    }
    actor = {
      type: "user",
      id: sess.user.id,
      name: sess.user.username,
      projectId: null,
      scopes: sess.scopes,
      role: sess.user.role,
    };
  } else {
    const m = token.match(/^deepsonar_[a-z0-9]+_([0-9a-f]{8})_[A-Za-z0-9_-]{16,}$/);
    if (!m) {
      if (!config.auth.required) {
        req.actor = INTERNAL;
        return;
      }
      return denyAudited(401, "token 格式非法", "bad_format");
    }
    const [row] = await sql`
      SELECT id, name, project_id, token_hash, scopes, expires_at, revoked_at
      FROM api_tokens WHERE token_prefix = ${m[1]}`;
    if (!row) {
      if (!config.auth.required) {
        req.actor = INTERNAL;
        return;
      }
      return denyAudited(401, "token 不存在或已吊销", "unknown_token");
    }
    const a = Buffer.from(row.token_hash as string, "utf8");
    const b = Buffer.from(hashToken(token), "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      if (!config.auth.required) {
        req.actor = INTERNAL;
        return;
      }
      return denyAudited(401, "token 校验失败", "hash_mismatch");
    }
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

  let scope = requiredScope(req.method, routeUrl);
  if (scope === "report:read") {
    const reportId = (req.params as { id?: string } | undefined)?.id;
    const [report] = reportId
      ? await sql`
          SELECT fr.id AS finding_report_id
          FROM (SELECT 1) anchor
          LEFT JOIN task_reports tr ON tr.id::text = ${reportId}
          LEFT JOIN finding_reports fr ON fr.id::text = ${reportId}
          WHERE tr.id IS NOT NULL OR fr.id IS NOT NULL`
      : [];
    scope = report?.finding_report_id ? "findings:read" : "tasks:read";
  }
  if (config.auth.required && !actorHasScope(actor, scope)) {
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
