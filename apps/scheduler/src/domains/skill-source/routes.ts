import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { sql } from "../../db.js";
import { syncSkillSource, validateSourceUrl } from "../../skill-sources.js";

const SkillSourceBody = z.object({
  name: z.string().min(1),
  repo_url: z.string().min(1),
  branch: z.string().default("main"),
});

export function registerSkillSourceRoutes(app: FastifyInstance): void {
  // ---------- Git 模块源（§8.2） ----------
  app.get("/skill-sources", async () =>
    sql`SELECT id, name, repo_url, branch, synced_at, created_at,
               trust_status, enabled, last_commit_sha, last_content_hash, synced_by,
               jsonb_array_length(catalog_json) AS module_count
        FROM skill_sources ORDER BY created_at DESC`);

  // 目录详情（模块列表；文件内容不下发，太大了）
  app.get("/skill-sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [src] = await sql`SELECT * FROM skill_sources WHERE id = ${id}`;
    if (!src) return reply.code(404).send({ error: "source not found" });
    const catalog = ((src.catalog_json as { files?: Record<string, string> }[]) ?? []).map(
      ({ files, ...rest }) => ({ ...rest, file_count: Object.keys(files ?? {}).length }),
    );
    return { ...src, catalog_json: catalog };
  });

  app.post("/skill-sources", async (req, reply) => {
    const body = SkillSourceBody.parse(req.body);
    // §5.1：新源 URL 必须先过安全校验（https + host 白名单 + 无内嵌凭据）
    try {
      validateSourceUrl(body.repo_url);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
    try {
      // 新源默认 quarantined + disabled（0013 迁移默认值），审批后才下发
      const [row] = await sql`
        INSERT INTO skill_sources ${sql({ name: body.name, repo_url: body.repo_url, branch: body.branch })}
        RETURNING id, name, repo_url, branch, synced_at, created_at, trust_status, enabled`;
      await audit(req, {
        action: "skill_source.create",
        resourceType: "skill_source",
        resourceId: row.id as string,
        after: { name: row.name, repo_url: row.repo_url, branch: row.branch },
      });
      return reply.code(201).send(row);
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "同名模块源已存在" });
      }
      throw e;
    }
  });

  // 同步：浅克隆 → 扫描 SKILL.md/commands → catalog 落库（内容缓存，运行不再访问 Git）
  app.post("/skill-sources/:id/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await syncSkillSource(id, req.actor?.name ?? null);
      await audit(req, { action: "skill_source.sync", resourceType: "skill_source", resourceId: id, after: r });
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // §5.1 信任审批：quarantined → trusted（可下发）/ disabled（禁用同步与下发）
  app.post("/skill-sources/:id/trust", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      trust_status: z.enum(["quarantined", "trusted", "disabled"]),
      enabled: z.boolean().optional(),
    }).parse(req.body);
    const enabled = body.enabled ?? body.trust_status === "trusted";
    const [row] = await sql`
      UPDATE skill_sources SET trust_status = ${body.trust_status}, enabled = ${enabled}
      WHERE id = ${id}
      RETURNING id, name, trust_status, enabled, last_commit_sha, last_content_hash`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    await audit(req, {
      action: "skill_source.trust",
      resourceType: "skill_source",
      resourceId: id,
      after: { name: row.name, trust_status: row.trust_status, enabled: row.enabled, commit: row.last_commit_sha },
    });
    return row;
  });

  app.delete("/skill-sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM skill_sources WHERE id = ${id} RETURNING id, name`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    await audit(req, {
      action: "skill_source.delete",
      resourceType: "skill_source",
      resourceId: id,
      before: { name: row.name },
    });
    return { ok: true };
  });
}
