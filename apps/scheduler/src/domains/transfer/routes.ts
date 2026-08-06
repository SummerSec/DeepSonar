import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { sql } from "../../db.js";
import { resolveModules } from "../../transfer/modules.js";
import { buildPreview, applyImport } from "../../transfer/import.js";
import { saveImportUpload, loadPackFile, removeFileSafe, sha256Hex, openDeepsonarPack } from "../../transfer/pack.js";
import { applyPlatformImport, buildPlatformPreview, PLATFORM_FORMAT, resolvePlatformModules } from "../../transfer/platform.js";
import { processExportRow } from "../../transfer/worker.js";

export function registerTransferRoutes(app: FastifyInstance): void {
  // ---------- 项目数据包导入导出（.deepsonarpack） ----------
  {
    app.addContentTypeParser(
      ["application/zip", "application/octet-stream", "application/x-deepsonarpack"],
      { parseAs: "buffer", bodyLimit: 256 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );

    app.post("/projects/:id/exports", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          preset: z.enum(["configuration", "project_full", "evidence_archive", "custom"]).default("configuration"),
          modules: z.array(z.string()).optional(),
          include_blobs: z.boolean().optional(),
          allow_active_jobs: z.boolean().optional(),
          credentials: z.object({ mode: z.enum(["excluded", "metadata"]).optional() }).optional(),
        })
        .parse(req.body ?? {});
      const [project] = await sql`SELECT id, name FROM projects WHERE id = ${id}`;
      if (!project) return reply.code(404).send({ error: "project not found" });
      const { modules } = resolveModules(body.preset, body.modules);
      const [row] = await sql`
        INSERT INTO data_exports ${sql({
          project_id: id,
          scope: "project",
          preset: body.preset,
          modules_json: modules as never,
          options_json: body as never,
          status: "pending",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "export.create",
        resourceType: "data_export",
        resourceId: row.id as string,
        projectId: id,
        after: { preset: body.preset, modules, scope: "project" },
      });
      setImmediate(() => {
        void processExportRow(row.id as string, "project");
      });
      return reply.code(201).send(row);
    });

    app.get("/projects/:id/exports", async (req, reply) => {
      const { id } = req.params as { id: string };
      return sql`
        SELECT id, project_id, scope, preset, modules_json, status, artifact_sha256, artifact_size,
               expires_at, error_code, error, created_by, created_at, started_at, finished_at
        FROM data_exports WHERE project_id = ${id} AND scope = 'project' ORDER BY created_at DESC LIMIT 50`;
    });

    // ---------- 平台配置导出 ----------
    app.post("/platform/exports", async (req, reply) => {
      const body = z
        .object({
          preset: z.enum(["platform_full", "custom"]).default("platform_full"),
          modules: z.array(z.string()).optional(),
          credentials: z.object({ mode: z.enum(["excluded", "metadata"]).optional() }).optional(),
        })
        .parse(req.body ?? {});
      const modules = resolvePlatformModules(body.preset, body.modules);
      const [row] = await sql`
        INSERT INTO data_exports ${sql({
          project_id: null,
          scope: "platform",
          preset: body.preset,
          modules_json: modules as never,
          options_json: body as never,
          status: "pending",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "export.platform_create",
        resourceType: "data_export",
        resourceId: row.id as string,
        after: { preset: body.preset, modules, scope: "platform" },
      });
      setImmediate(() => {
        void processExportRow(row.id as string, "platform");
      });
      return reply.code(201).send(row);
    });

    app.get("/platform/exports", async () => {
      return sql`
        SELECT id, project_id, scope, preset, modules_json, status, artifact_sha256, artifact_size,
               expires_at, error_code, error, created_by, created_at, started_at, finished_at
        FROM data_exports WHERE scope = 'platform' ORDER BY created_at DESC LIMIT 50`;
    });

    app.get("/exports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_exports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      return row;
    });

    app.get("/exports/:id/download", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_exports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.status !== "succeeded" || !row.artifact_uri) {
        return reply.code(409).send({ error: "export not ready" });
      }
      if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
        return reply.code(410).send({ error: "export expired" });
      }
      const buf = await loadPackFile(row.artifact_uri as string);
      await audit(req, {
        action: "export.download",
        resourceType: "data_export",
        resourceId: id,
        projectId: row.project_id as string,
        after: { sha256: row.artifact_sha256, size: row.artifact_size },
      });
      return reply
        .header("content-type", "application/x-deepsonarpack")
        .header("content-disposition", `attachment; filename="project-${row.project_id}.deepsonarpack"`)
        .header("x-content-sha256", String(row.artifact_sha256 ?? ""))
        .send(buf);
    });

    app.post("/exports/:id/cancel", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE data_exports SET status = 'cancelled', finished_at = now()
        WHERE id = ${id} AND status IN ('pending','collecting','packaging')
        RETURNING *`;
      if (!row) return reply.code(409).send({ error: "cannot cancel" });
      return row;
    });

    app.delete("/exports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`DELETE FROM data_exports WHERE id = ${id} RETURNING *`;
      if (!row) return reply.code(404).send({ error: "not found" });
      await removeFileSafe(row.artifact_uri as string | null);
      return { ok: true };
    });

    app.post("/imports", async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({
          error: "expected raw package body (Content-Type: application/zip or application/x-deepsonarpack)",
        });
      }
      const id = randomUUID();
      const sha = sha256Hex(body);
      const uri = await saveImportUpload(id, body);
      // 嗅探包类型
      let scope: "project" | "platform" = "project";
      try {
        const pack = await openDeepsonarPack(body);
        if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
      } catch {
        /* preview 阶段再报错 */
      }
      const [row] = await sql`
        INSERT INTO data_imports ${sql({
          id,
          source_artifact_uri: uri,
          source_sha256: sha,
          scope,
          status: "uploaded",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "import.upload",
        resourceType: "data_import",
        resourceId: id,
        after: { sha256: sha, size: body.length, scope },
      });
      return reply.code(201).send(row);
    });

    app.get("/imports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_imports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      return row;
    });

    app.post("/imports/:id/preview", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [row] = await sql`SELECT scope, source_artifact_uri FROM data_imports WHERE id = ${id}`;
        if (!row) return reply.code(404).send({ error: "not found" });
        let scope = row.scope as string;
        if (scope !== "platform") {
          try {
            const buf = await loadPackFile(row.source_artifact_uri as string);
            const pack = await openDeepsonarPack(buf);
            if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
          } catch {
            /* fall through */
          }
        }
        const preview =
          scope === "platform" ? await buildPlatformPreview(id) : await buildPreview(id);
        await audit(req, {
          action: "import.preview",
          resourceType: "data_import",
          resourceId: id,
          after: {
            scope,
            modules: (preview as { selected_modules?: string[] }).selected_modules,
          },
        });
        return preview;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "PREVIEW_FAILED";
        await sql`UPDATE data_imports SET status = 'failed', error = ${msg}, error_code = ${code} WHERE id = ${id}`;
        return reply.code(400).send({ error: msg, error_code: code });
      }
    });

    app.post("/imports/:id/apply", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          mode: z.enum(["create_new", "merge_configuration", "merge_platform"]).optional(),
          project_name: z.string().optional(),
          target_project_id: z.string().uuid().optional(),
          modules: z.array(z.string()).optional(),
          conflict_policy: z.enum(["rename", "keep_target", "use_source"]).optional(),
          credential_mappings: z.record(z.string(), z.string()).optional(),
        })
        .parse(req.body ?? {});
      try {
        const [row] = await sql`SELECT scope, source_artifact_uri FROM data_imports WHERE id = ${id}`;
        if (!row) return reply.code(404).send({ error: "not found" });
        let scope = row.scope as string;
        try {
          const buf = await loadPackFile(row.source_artifact_uri as string);
          const pack = await openDeepsonarPack(buf);
          if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
        } catch {
          /* use stored scope */
        }

        if (scope === "platform" || body.mode === "merge_platform") {
          const result = await applyPlatformImport(id, {
            conflict_policy: body.conflict_policy === "keep_target" ? "keep_target" : "use_source",
            credential_mappings: body.credential_mappings,
          });
          await audit(req, {
            action: "import.platform_apply",
            resourceType: "data_import",
            resourceId: id,
            after: { summary: result.summary },
          });
          return result;
        }

        const mode = body.mode === "merge_configuration" ? "merge_configuration" : "create_new";
        const result = await applyImport(id, {
          mode,
          project_name: body.project_name,
          target_project_id: body.target_project_id,
          modules: body.modules as never,
          conflict_policy: body.conflict_policy,
          credential_mappings: body.credential_mappings,
        });
        await audit(req, {
          action: "import.apply",
          resourceType: "data_import",
          resourceId: id,
          projectId: result.project_id,
          after: { mode, project_id: result.project_id },
        });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: msg });
      }
    });

    app.post("/imports/:id/cancel", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE data_imports SET status = 'cancelled', finished_at = now()
        WHERE id = ${id} AND status IN ('uploaded','validating','preview_ready')
        RETURNING *`;
      if (!row) return reply.code(409).send({ error: "cannot cancel" });
      return row;
    });

    app.delete("/imports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`DELETE FROM data_imports WHERE id = ${id} RETURNING *`;
      if (!row) return reply.code(404).send({ error: "not found" });
      await removeFileSafe(row.source_artifact_uri as string | null);
      return { ok: true };
    });
  }
}
