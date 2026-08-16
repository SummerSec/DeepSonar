import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import {
  countUsers,
  createUser,
  defaultAdminCredentialsActive,
  issueUserSession,
  listUsers,
  loginUser,
  revokeSession,
  setUserPassword,
  setUserUsername,
  toPublicUser,
  updateUser,
  verifyPassword,
  type UserRole,
} from "../../users.js";
import { LoginRateLimitError } from "../../login-rate-limit.js";
import { issueWsTicket } from "../../ws-tickets.js";

const STREAMABLE_JOB_STATUSES = new Set(["running", "waiting_human"]);

export function registerAuthRoutes(app: FastifyInstance): void {
  // ---------- 用户认证（人机登录；与 api_tokens 服务账号分离） ----------
  app.get("/auth/status", async () => {
    const n = await countUsers();
    return {
      auth_required: config.auth.required,
      has_users: n > 0,
      bootstrap_available: n === 0,
      default_admin_credentials_active: await defaultAdminCredentialsActive(),
      session_ttl_days: 7,
    };
  });

  /**
   * Exchange the normal Bearer/session credential for a one-use browser WS
   * ticket.  The returned opaque value is scoped to one running Job and expires
   * in seconds; long-lived API tokens never enter the WebSocket URL.
   */
  app.post("/auth/ws-ticket", async (req, reply) => {
    const body = z.object({
      job_id: z.string().uuid(),
      purpose: z.enum(["stream", "terminal"]).default("stream"),
    }).parse(req.body ?? {});
    const actor = req.actor;
    if (!actor) return reply.code(401).send({ error: "缺少认证主体", error_code: "AUTH_REQUIRED" });
    const [job] = await sql`SELECT id, project_id, status FROM jobs WHERE id = ${body.job_id}`;
    if (!job) return reply.code(404).send({ error: "job not found", error_code: "JOB_NOT_FOUND" });
    if (actor.projectId && actor.projectId !== job.project_id) {
      return reply.code(403).send({ error: "token 仅限项目 " + actor.projectId, error_code: "PROJECT_MISMATCH" });
    }
    if (body.purpose === "terminal" && !actor.scopes.includes("admin") && !actor.scopes.includes("jobs:control")) {
      await audit(req, {
        action: "terminal.ticket.denied",
        projectId: String(job.project_id),
        resourceType: "job",
        resourceId: body.job_id,
        result: "denied",
        errorCode: "TERMINAL_PERMISSION_DENIED",
      });
      return reply.code(403).send({ error: "terminal permission denied", error_code: "TERMINAL_PERMISSION_DENIED" });
    }
    if (!STREAMABLE_JOB_STATUSES.has(String(job.status))) {
      return reply.code(409).send({
        error: "job is not running",
        error_code: "JOB_NOT_RUNNING",
        status: job.status,
      });
    }
    const ticket = issueWsTicket(body.job_id, actor, body.purpose);
    return { ...ticket, job_id: body.job_id, purpose: body.purpose };
  });

  app.post("/auth/bootstrap", async (req, reply) => {
    const n = await countUsers();
    if (n > 0) return reply.code(409).send({ error: "已有用户，无法 bootstrap", error_code: "ALREADY_BOOTSTRAPPED" });
    const body = z
      .object({
        username: z.string().min(2).max(64),
        password: z.string().min(8).max(200),
        display_name: z.string().max(100).optional(),
      })
      .parse(req.body);
    try {
      const user = await createUser({
        username: body.username,
        password: body.password,
        display_name: body.display_name,
        role: "admin",
        created_by: "bootstrap",
      });
      const session = await loginUser(body.username, body.password, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(req, {
        action: "auth.bootstrap",
        resourceType: "user",
        resourceId: user.id,
        after: { username: user.username, role: user.role },
      });
      return reply.code(201).send({
        user: session.user,
        token: session.token,
        expires_at: session.expires_at,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "BOOTSTRAP_FAILED";
      return reply.code(400).send({ error: msg, error_code: code });
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    try {
      const session = await loginUser(body.username, body.password, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(req, {
        action: "auth.login",
        resourceType: "user",
        resourceId: session.user.id,
        after: { username: session.user.username },
      });
      return session;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "LOGIN_FAILED";
      await audit(req, {
        action: "auth.login_failed",
        resourceType: "user",
        resourceId: body.username,
        result: "denied",
        errorCode: code,
      });
      if (e instanceof LoginRateLimitError || code === "LOGIN_RATE_LIMITED") {
        const retryAfter = e instanceof LoginRateLimitError ? e.retryAfterSec : 300;
        return reply
          .code(429)
          .header("Retry-After", String(retryAfter))
          .send({ error: msg, error_code: "LOGIN_RATE_LIMITED", retry_after_sec: retryAfter });
      }
      return reply.code(401).send({ error: msg, error_code: code });
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token.startsWith("deepsonar_user_")) {
      await revokeSession(token);
    }
    await audit(req, {
      action: "auth.logout",
      resourceType: "user",
      resourceId: req.actor?.id ?? null,
    });
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const actor = req.actor;
    if (!actor || actor.type === "internal") {
      return {
        auth_required: config.auth.required,
        authenticated: !config.auth.required,
        actor: actor
          ? { type: actor.type, name: actor.name, role: actor.role ?? null, project_id: actor.projectId, scopes: actor.scopes }
          : null,
        user: null,
      };
    }
    if (actor.type === "user" && actor.id) {
      const [row] = await sql`SELECT * FROM users WHERE id = ${actor.id}`;
      return {
        auth_required: config.auth.required,
        authenticated: true,
        actor: { type: actor.type, name: actor.name, role: actor.role ?? null, project_id: actor.projectId, scopes: actor.scopes },
        user: row ? toPublicUser(row as Record<string, unknown>) : null,
      };
    }
    return {
      auth_required: config.auth.required,
      authenticated: true,
      actor: { type: actor.type, name: actor.name, role: null, project_id: actor.projectId, scopes: actor.scopes },
      user: null,
    };
  });

  app.post("/auth/change-password", async (req, reply) => {
    if (req.actor?.type !== "user" || !req.actor.id) {
      return reply.code(403).send({ error: "仅登录用户可修改自己的密码" });
    }
    const body = z
      .object({
        current_password: z.string().min(1),
        new_password: z.string().min(8).max(200),
      })
      .parse(req.body);
    const [row] = await sql`SELECT * FROM users WHERE id = ${req.actor.id}`;
    if (!row) return reply.code(404).send({ error: "user not found" });
    if (!verifyPassword(body.current_password, row.password_salt as string, row.password_hash as string)) {
      await audit(req, {
        action: "auth.change_password",
        resourceType: "user",
        resourceId: req.actor.id,
        result: "denied",
        errorCode: "BAD_CURRENT_PASSWORD",
      });
      return reply.code(401).send({ error: "当前密码错误" });
    }
    await setUserPassword(req.actor.id, body.new_password);
    const session = await issueUserSession(req.actor.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    await audit(req, {
      action: "auth.change_password",
      resourceType: "user",
      resourceId: req.actor.id,
    });
    return { ok: true, token: session.token, expires_at: session.expires_at, user: session.user };
  });

  app.post("/auth/change-username", async (req, reply) => {
    if (req.actor?.type !== "user" || !req.actor.id) {
      return reply.code(403).send({ error: "仅登录用户可修改自己的登录名" });
    }
    const body = z
      .object({
        current_password: z.string().min(1),
        new_username: z.string().min(2).max(64),
      })
      .parse(req.body);
    const [row] = await sql`SELECT * FROM users WHERE id = ${req.actor.id}`;
    if (!row) return reply.code(404).send({ error: "user not found" });
    if (!verifyPassword(body.current_password, row.password_salt as string, row.password_hash as string)) {
      await audit(req, {
        action: "auth.change_username",
        resourceType: "user",
        resourceId: req.actor.id,
        result: "denied",
        errorCode: "BAD_CURRENT_PASSWORD",
      });
      return reply.code(401).send({ error: "当前密码错误" });
    }
    try {
      const user = await setUserUsername(req.actor.id, body.new_username);
      if (!user) return reply.code(404).send({ error: "user not found" });
      // Username changes revoke all existing sessions (including this one),
      // then issue one fresh session for the authenticated browser.
      const session = await issueUserSession(user.id, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(req, {
        action: "auth.change_username",
        resourceType: "user",
        resourceId: user.id,
        before: { username: row.username as string },
        after: { username: user.username },
      });
      return { ok: true, token: session.token, expires_at: session.expires_at, user: session.user };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "CHANGE_USERNAME_FAILED";
      const status = code === "USERNAME_TAKEN" ? 409 : code === "BAD_USERNAME" ? 400 : 500;
      return reply.code(status).send({ error: msg, error_code: code });
    }
  });

  app.get("/users", async () => listUsers());

  app.post("/users", async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(2).max(64),
        password: z.string().min(8).max(200),
        display_name: z.string().max(100).optional(),
        role: z.enum(["admin", "operator", "viewer"]).default("operator"),
      })
      .parse(req.body);
    try {
      const user = await createUser({
        username: body.username,
        password: body.password,
        display_name: body.display_name,
        role: body.role as UserRole,
        created_by: req.actor?.name ?? null,
      });
      await audit(req, {
        action: "user.create",
        resourceType: "user",
        resourceId: user.id,
        after: { username: user.username, role: user.role },
      });
      return reply.code(201).send(user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "CREATE_FAILED";
      return reply.code(400).send({ error: msg, error_code: code });
    }
  });

  app.patch("/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        display_name: z.string().max(100).optional(),
        role: z.enum(["admin", "operator", "viewer"]).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body ?? {});
    const user = await updateUser(id, body);
    if (!user) return reply.code(404).send({ error: "not found" });
    await audit(req, {
      action: "user.update",
      resourceType: "user",
      resourceId: id,
      after: body,
    });
    return user;
  });

  app.post("/users/:id/password", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ password: z.string().min(8).max(200) }).parse(req.body);
    const [row] = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: "not found" });
    await setUserPassword(id, body.password);
    await audit(req, {
      action: "user.reset_password",
      resourceType: "user",
      resourceId: id,
    });
    return { ok: true };
  });
}
