import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { ALL_SCOPES, generateToken } from "../../auth.js";
import { sql } from "../../db.js";
import { PROJECT_MISMATCH } from "../../project-scope.js";
import {
  actorCanGrantScopes,
  resolveCreatedTokenProjectId,
  SCOPE_EXCEEDS_ACTOR,
  tokenManagedByActor,
} from "../../token-policy.js";

export function registerApiTokenRoutes(app: FastifyInstance): void {
  // ---------- 平台 API Token 管理（§6.1/§6.4：tokens:manage） ----------
  // 与 Provider Credential（LLM/Git 密钥）严格分离；明文仅创建/轮换时返回一次
  const TOKEN_SAFE_FIELDS = sql`id, name, subject_type, subject_id, project_id, token_prefix, scopes,
                                expires_at, last_used_at, last_ip, revoked_at, created_at, created_by`;

  const CreateTokenBody = z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(ALL_SCOPES)).min(1),
    project_id: z.string().uuid().nullable().optional(),
    expires_in_days: z.number().int().positive().max(365).optional(),
  });

  app.get("/tokens", async (req) => {
    const actor = req.actor!;
    const rows = actor.projectId
      ? await sql`SELECT ${TOKEN_SAFE_FIELDS} FROM api_tokens WHERE project_id = ${actor.projectId} ORDER BY created_at DESC`
      : await sql`SELECT ${TOKEN_SAFE_FIELDS} FROM api_tokens ORDER BY created_at DESC`;
    return rows.filter((row) =>
      tokenManagedByActor(actor, {
        project_id: (row.project_id as string | null) ?? null,
        scopes: (row.scopes as string[]) ?? [],
      }),
    );
  });

  app.post("/tokens", async (req, reply) => {
    const body = CreateTokenBody.parse(req.body);
    const actor = req.actor!;
    if (!actorCanGrantScopes(actor, body.scopes)) {
      return reply.code(403).send({
        error: "token scopes must be a subset of the caller's scopes; non-admins cannot grant admin",
        error_code: SCOPE_EXCEEDS_ACTOR,
      });
    }
    const project = resolveCreatedTokenProjectId(actor.projectId, body.project_id ?? null);
    if (!project.ok) {
      return reply.code(403).send({
        error: `token 仅限项目 ${actor.projectId}`,
        error_code: PROJECT_MISMATCH,
      });
    }
    const { plaintext, prefix, hash } = generateToken();
    const [row] = await sql`
      INSERT INTO api_tokens ${sql({
        name: body.name,
        project_id: project.projectId,
        token_prefix: prefix,
        token_hash: hash,
        scopes: body.scopes as unknown as never,
        expires_at: body.expires_in_days
          ? new Date(Date.now() + body.expires_in_days * 86400_000)
          : null,
        created_by: actor.name ?? null,
      })}
      RETURNING id, name, token_prefix, scopes, project_id, expires_at, created_at`;
    // 明文只在这里出现一次（§6.1）；不落日志、不进审计
    await audit(req, {
      action: "token.create",
      resourceType: "api_token",
      resourceId: row.id as string,
      projectId: (row.project_id as string) ?? null,
      after: { name: row.name, scopes: row.scopes, expires_at: row.expires_at },
    });
    return reply.code(201).send({ ...row, token: plaintext });
  });

  const denyTokenLifecycle = (
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    actor: { projectId: string | null; scopes: string[] },
    token: { project_id: string | null; scopes: string[] },
  ) => {
    if (actor.projectId && token.project_id !== actor.projectId) {
      return reply.code(403).send({ error: `token 仅限项目 ${actor.projectId}`, error_code: PROJECT_MISMATCH });
    }
    if (!actorCanGrantScopes(actor, token.scopes)) {
      return reply.code(403).send({
        error: "cannot manage a token whose scopes exceed the caller",
        error_code: SCOPE_EXCEEDS_ACTOR,
      });
    }
    return null;
  };

  app.post("/tokens/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = req.actor!;
    const [existing] = await sql`
      SELECT id, name, project_id, scopes FROM api_tokens WHERE id = ${id} AND revoked_at IS NULL`;
    if (!existing) return reply.code(404).send({ error: "token 不存在或已吊销" });
    const denied = denyTokenLifecycle(reply, actor, {
      project_id: (existing.project_id as string | null) ?? null,
      scopes: (existing.scopes as string[]) ?? [],
    });
    if (denied) return denied;
    const [row] = await sql`
      UPDATE api_tokens SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id, name, token_prefix, revoked_at`;
    if (!row) return reply.code(404).send({ error: "token 不存在或已吊销" });
    await audit(req, { action: "token.revoke", resourceType: "api_token", resourceId: id, after: { name: row.name } });
    return row;
  });

  app.post("/tokens/:id/rotate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = req.actor!;
    const [old] = await sql`SELECT * FROM api_tokens WHERE id = ${id} AND revoked_at IS NULL`;
    if (!old) return reply.code(404).send({ error: "token 不存在或已吊销" });
    const oldScopes = (old.scopes as string[]) ?? [];
    const denied = denyTokenLifecycle(reply, actor, {
      project_id: (old.project_id as string | null) ?? null,
      scopes: oldScopes,
    });
    if (denied) return denied;
    const { plaintext, prefix, hash } = generateToken();
    const [row] = await sql`
      INSERT INTO api_tokens ${sql({
        name: old.name as string,
        subject_type: old.subject_type as string,
        subject_id: old.subject_id as string | null,
        project_id: old.project_id as string | null,
        token_prefix: prefix,
        token_hash: hash,
        scopes: old.scopes as unknown as never,
        expires_at: old.expires_at as Date | null,
        created_by: actor.name ?? null,
      })}
      RETURNING id, name, token_prefix, scopes, project_id, expires_at, created_at`;
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${id}`;
    await audit(req, {
      action: "token.rotate",
      resourceType: "api_token",
      resourceId: row.id as string,
      before: { id, name: old.name },
      after: { name: row.name, scopes: row.scopes },
    });
    return reply.code(201).send({ ...row, token: plaintext, rotated_from: id });
  });
}
