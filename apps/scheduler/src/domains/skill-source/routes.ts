import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, recordSystemAudit } from "../../audit.js";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import { validationHttpError } from "../../http-validation-error.js";
import { skillSourceAgeSeconds } from "../../skill-freshness.js";
import { approveSkillSourceCandidate, syncSkillSource } from "../../skill-sources.js";
import { SkillSourceCandidateError } from "../../skill-source-catalog-lifecycle.js";
import { skillSourceMetadata, sourceVersionMatches, skillSourcePolicyReply } from "./metadata.js";
import { registerSkillSource, SkillSourceRegistrationError } from "./registration.js";
import { listProjectSkillSourceBindings, setProjectSkillSourceEnabled } from "../project-skill-allowlist/index.js";

const SourceParams = z.object({ id: z.string().uuid() });
const SkillSourceBody = z.object({
  name: z.string().trim().min(1).max(200),
  repo_url: z.string().trim().min(1).max(2048),
  branch: z.string().trim().min(1).max(256).default("main"),
}).strict();
const TrustBody = z.object({
  trust_status: z.enum(["quarantined", "trusted", "disabled"]),
  enabled: z.boolean().optional(),
  expected_epoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
  expected_instance_id: z.string().uuid(),
  candidate_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().superRefine((body, context) => {
  if (body.trust_status === "trusted" && !body.candidate_hash) {
    context.addIssue({ code: "custom", path: ["candidate_hash"], message: "批准必须引用已同步的精确候选 hash" });
  }
  if (body.trust_status !== "trusted" && body.enabled === true) {
    context.addIssue({ code: "custom", path: ["enabled"], message: "隔离或禁用状态不能启用下发" });
  }
});

/** Existing auth hook checks skills:write; a project token cannot mutate a platform resource. */
async function denyProjectScopedManagement(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!req.actor?.projectId) return false;
  await audit(req, { action: "skill_source.management_denied", resourceType: "route",
    resourceId: `${req.method} /skill-sources`, result: "denied", errorCode: "PLATFORM_SCOPE_REQUIRED" });
  reply.code(403).send({ error_code: "PLATFORM_SCOPE_REQUIRED",
    error: "平台共享源操作需要未限定项目的 skills:write 权限；项目令牌只能调整本项目的启停。" });
  return true;
}

export function registerSkillSourceRoutes(app: FastifyInstance, synchronize: typeof syncSkillSource = syncSkillSource): void {
  app.get("/skill-sources", async () => {
    const rows = await sql`SELECT *, jsonb_array_length(catalog_json) AS module_count FROM skill_sources ORDER BY created_at DESC`;
    const nowMs = Date.now();
    const interval = config.skillSources.refreshIntervalSec;
    const grace = interval > 0 ? interval * 2 : config.skillSources.staleAfterDays * 86_400;
    return rows.map((row) => {
      const age = skillSourceAgeSeconds(row.synced_at as string | null, nowMs);
      return { ...skillSourceMetadata(row), age_seconds: age, stale: age === null || age > grace };
    });
  });

  app.get("/skill-sources/:id", async (req, reply) => {
    const { id } = SourceParams.parse(req.params);
    const [src] = await sql`SELECT * FROM skill_sources WHERE id = ${id}`;
    if (!src) return reply.code(404).send({ error: "source not found" });
    const catalog = ((src.catalog_json as { files?: Record<string, string> }[]) ?? []).map(
      ({ files, ...rest }) => ({ ...rest, file_count: Object.keys(files ?? {}).length }));
    return { ...skillSourceMetadata(src), catalog_json: catalog };
  });

  app.post("/skill-sources", async (req, reply) => {
    if (await denyProjectScopedManagement(req, reply)) return;
    const body = SkillSourceBody.parse(req.body);
    try {
      const result = await sql.begin(async (tx) => {
        // SAFETY: postgres transaction handles expose the tagged-template and helper interface used here.
        const found = await registerSkillSource(tx as unknown as typeof sql, body);
        await recordSystemAudit({ actorId: req.actor?.name, action: found.existing ? "skill_source.reuse" : "skill_source.create",
          resourceType: "skill_source", resourceId: String(found.row.id), after: { existing: found.existing } }, tx as unknown as typeof sql);
        return found;
      });
      return reply.code(result.existing ? 200 : 201).send({ ...skillSourceMetadata(result.row), existing: result.existing });
    } catch (error) {
      if (error instanceof SkillSourceRegistrationError) {
        return reply.code(error.error_code === "SKILL_SOURCE_URL_INVALID" ? 400 : 409).send({ error_code: error.error_code,
          error: "登记未改变任何源权限：请核对 HTTPS 来源、仓库/分支身份和名称；已有歧义须由平台管理员处理。" });
      }
      throw error;
    }
  });

  app.post("/skill-sources/:id/sync", async (req, reply) => {
    if (await denyProjectScopedManagement(req, reply)) return;
    const { id } = SourceParams.parse(req.params);
    const query = req.query as { force?: string } | undefined;
    try {
      const result = await synchronize(id, req.actor?.name ?? null, undefined, {
        skipIfUnchanged: query?.force !== "1" && query?.force !== "true",
      });
      await audit(req, { action: "skill_source.sync", resourceType: "skill_source", resourceId: id,
        after: { candidate_hash: result.candidate_hash, changed: result.changed, modules: result.modules } });
      return { ok: true, ...result };
    } catch (error) {
      const policy = skillSourcePolicyReply(error);
      if (policy) return reply.code(policy.status).send(policy.body);
      const mapped = validationHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return reply.code(502).send({ error_code: "SKILL_SOURCE_SYNC_FAILED",
        error: "候选同步失败；请核对仓库访问、分支与平台检查状态，当前已批准目录未被替换。" });
    }
  });

  app.post("/skill-sources/:id/trust", async (req, reply) => {
    if (await denyProjectScopedManagement(req, reply)) return;
    const { id } = SourceParams.parse(req.params);
    const body = TrustBody.parse(req.body);
    try {
      if (body.trust_status === "trusted") {
        await approveSkillSourceCandidate({ sourceId: id, candidateHash: body.candidate_hash!,
          expectedEpoch: body.expected_epoch, expectedSourceInstanceId: body.expected_instance_id,
          actorId: req.actor?.name ?? "scheduler", enabled: body.enabled });
      } else {
        await sql.begin(async (tx) => {
          const [source] = await tx`SELECT * FROM skill_sources WHERE id = ${id} FOR UPDATE`;
          if (!source || !sourceVersionMatches(source, body.expected_instance_id, body.expected_epoch)) {
            throw new SkillSourceCandidateError("SKILL_SOURCE_CANDIDATE_CONFLICT");
          }
          await tx`UPDATE skill_sources SET trust_status = ${body.trust_status}, enabled = false WHERE id = ${id}`;
          await recordSystemAudit({ actorId: req.actor?.name, action: "skill_source.trust", resourceType: "skill_source", resourceId: id,
            after: { trust_status: body.trust_status, enabled: false, source_instance_id: body.expected_instance_id } }, tx as unknown as typeof sql);
        });
      }
      const [row] = await sql`SELECT * FROM skill_sources WHERE id = ${id}`;
      await audit(req, { action: "skill_source.trust_request", resourceType: "skill_source", resourceId: id,
        after: { trust_status: body.trust_status, candidate_hash: body.candidate_hash ?? null } });
      return row ? skillSourceMetadata(row) : reply.code(404).send({ error: "source not found" });
    } catch (error) {
      const policy = skillSourcePolicyReply(error);
      if (policy) return reply.code(policy.status).send(policy.body);
      throw error;
    }
  });

  app.delete("/skill-sources/:id", async (req, reply) => {
    if (await denyProjectScopedManagement(req, reply)) return;
    const { id } = SourceParams.parse(req.params);
    const [row] = await sql`DELETE FROM skill_sources WHERE id = ${id} RETURNING id, name`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    await audit(req, { action: "skill_source.delete", resourceType: "skill_source", resourceId: id, before: { name: row.name } });
    return { ok: true };
  });

  app.get("/projects/:id/skill-sources", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.actor?.projectId && req.actor.projectId !== id) return reply.code(403).send({ error: "token project mismatch" });
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    return listProjectSkillSourceBindings(sql as never, id);
  });

  app.put("/projects/:id/skill-sources/:sourceId", async (req, reply) => {
    const { id, sourceId } = req.params as { id: string; sourceId: string };
    if (req.actor?.projectId && req.actor.projectId !== id) return reply.code(403).send({ error: "token project mismatch" });
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      const row = await setProjectSkillSourceEnabled(sql as never, id, sourceId, body.enabled);
      await audit(req, { action: "skill_source.project_binding", resourceType: "skill_source", resourceId: sourceId, projectId: id,
        after: { enabled: body.enabled } });
      return row;
    } catch (error) {
      return reply.code(error instanceof Error && /not found/i.test(error.message) ? 404 : 400).send({ error: "skill source binding unavailable" });
    }
  });
}
