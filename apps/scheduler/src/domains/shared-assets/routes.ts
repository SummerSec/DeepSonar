import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import {
  createSharedAsset,
  listSharedAssets,
  readSharedAssetBlob,
  type SharedAssetScope,
} from "./application.js";

const Id = z.string().uuid();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });
const UploadHeaders = z.object({
  "x-asset-key": z.string().min(1).max(240),
  "content-type": z.string().min(1).max(160),
  "x-asset-content-type": z.string().min(1).max(160).optional(),
  "x-asset-labels": z.string().max(4000).optional(),
}).passthrough();

function errorReply(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : "shared_asset_error";
  const status = code.includes("not_in_project") || code.includes("forbidden") ? 403
    : code.includes("not_found") ? 404
      : code.includes("quota") || code.includes("too_large") ? 413
        : code.includes("exists") ? 409 : 400;
  return reply.code(status).send({ error: code });
}

function requireProject(req: FastifyRequest, reply: FastifyReply, projectId: string): boolean {
  if (!projectScopeAllows(req.actor?.projectId ?? null, projectId)) {
    reply.code(403).send({ error: "project_scope_forbidden" });
    return false;
  }
  return true;
}

function requireWriter(req: FastifyRequest, reply: FastifyReply, platform = false): boolean {
  if (platform && req.actor?.role !== "admin" && !req.actor?.scopes.includes("admin")) {
    reply.code(403).send({ error: "platform_asset_admin_required" });
    return false;
  }
  if (req.actor?.role === "viewer") {
    reply.code(403).send({ error: "asset_write_forbidden" });
    return false;
  }
  return true;
}

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return z.record(z.string().min(1).max(60), z.string().max(200)).parse(parsed);
}

async function upload(req: FastifyRequest, reply: FastifyReply, input: {
  scope: SharedAssetScope;
  projectId?: string;
  findingId?: string;
}) {
  let key: string | undefined;
  try {
    const headers = UploadHeaders.parse(req.headers);
    key = headers["x-asset-key"];
    if (!Buffer.isBuffer(req.body)) throw new Error("asset_upload_body_required");
    const bytes = req.body;
    const created = await createSharedAsset({
      ...input,
      key,
      contentType: headers["x-asset-content-type"] ?? headers["content-type"],
      bytes,
      origin: "human",
      actor: req.actor?.name ?? "anonymous",
      labels: parseLabels(headers["x-asset-labels"]),
    });
    await audit(req, { action: "shared_asset.upload", projectId: input.projectId ?? null, resourceType: "shared_asset", resourceId: String(created.id), after: { scope: input.scope, key, sha256: created.content_sha256, bytes: created.bytes } });
    return reply.code(201).send(created);
  } catch (error) {
    await audit(req, { action: "shared_asset.upload", projectId: input.projectId ?? null, resourceType: "shared_asset", result: "denied", errorCode: error instanceof Error ? error.message : "shared_asset_error", after: { scope: input.scope, key: key ?? null } });
    return errorReply(reply, error);
  }
}

async function resolveAsset(req: FastifyRequest, assetId: string) {
  const [asset] = await sql`
    SELECT a.*,v.id AS version_id,v.content_sha256,v.bytes,v.content_type,b.blob_uri
    FROM shared_assets a
    JOIN shared_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE a.id=${assetId}`;
  if (!asset) throw new Error("asset_not_found");
  if (asset.scope_type === "platform") {
    if (req.method !== "GET" && req.actor?.role !== "admin" && !req.actor?.scopes.includes("admin")) throw new Error("asset_scope_forbidden");
    if (req.actor?.projectId) {
      const [policy] = await sql`SELECT 1 FROM shared_asset_project_policies WHERE project_id=${req.actor.projectId} AND platform_enabled=true`;
      if (!policy) throw new Error("asset_scope_forbidden");
    }
  } else if (!projectScopeAllows(req.actor?.projectId ?? null, asset.project_id as string)) throw new Error("asset_scope_forbidden");
  return asset;
}

export function registerSharedAssetRoutes(app: FastifyInstance): void {
  app.get("/projects/:id/shared-assets", async (req, reply) => {
    const projectId = Id.parse((req.params as { id: string }).id);
    if (!requireProject(req, reply, projectId)) return;
    return listSharedAssets({ scope: "project", projectId, ...ListQuery.parse(req.query) });
  });
  app.post("/projects/:id/shared-assets", { bodyLimit: config.sharedAssets.maxFileBytes }, async (req, reply) => {
    const projectId = Id.parse((req.params as { id: string }).id);
    if (!requireProject(req, reply, projectId) || !requireWriter(req, reply)) return;
    return upload(req, reply, { scope: "project", projectId });
  });

  app.get("/projects/:id/shared-assets/policy", async (req, reply) => {
    const projectId = Id.parse((req.params as { id: string }).id);
    if (!requireProject(req, reply, projectId)) return;
    const [policy] = await sql`SELECT * FROM shared_asset_project_policies WHERE project_id=${projectId}`;
    return policy ?? { project_id: projectId, platform_enabled: false, revision: 0 };
  });
  app.patch("/projects/:id/shared-assets/policy", async (req, reply) => {
    const projectId = Id.parse((req.params as { id: string }).id);
    if (!requireProject(req, reply, projectId) || !requireWriter(req, reply)) return;
    const body = z.object({ platform_enabled: z.boolean() }).strict().parse(req.body);
    const [policy] = await sql`INSERT INTO shared_asset_project_policies (project_id,platform_enabled,updated_by) VALUES (${projectId},${body.platform_enabled},${req.actor?.name ?? "anonymous"}) ON CONFLICT (project_id) DO UPDATE SET platform_enabled=EXCLUDED.platform_enabled,revision=shared_asset_project_policies.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`;
    await audit(req, { action: "shared_asset.policy.update", projectId, resourceType: "shared_asset_policy", resourceId: projectId, after: { platform_enabled: body.platform_enabled, revision: policy.revision } });
    return policy;
  });

  app.get("/findings/:id/shared-assets", async (req, reply) => {
    const findingId = Id.parse((req.params as { id: string }).id);
    const [finding] = await sql`SELECT project_id FROM findings WHERE id=${findingId}`;
    if (!finding) return reply.code(404).send({ error: "finding_not_found" });
    const projectId = finding.project_id as string;
    if (!requireProject(req, reply, projectId)) return;
    return listSharedAssets({ scope: "finding", projectId, findingId, ...ListQuery.parse(req.query) });
  });
  app.post("/findings/:id/shared-assets", { bodyLimit: config.sharedAssets.maxFileBytes }, async (req, reply) => {
    const findingId = Id.parse((req.params as { id: string }).id);
    const [finding] = await sql`SELECT project_id FROM findings WHERE id=${findingId}`;
    if (!finding) return reply.code(404).send({ error: "finding_not_found" });
    const projectId = finding.project_id as string;
    if (!requireProject(req, reply, projectId) || !requireWriter(req, reply)) return;
    return upload(req, reply, { scope: "finding", projectId, findingId });
  });

  app.get("/platform/shared-assets", async (req, reply) => {
    if (!requireWriter(req, reply, true)) return;
    return listSharedAssets({ scope: "platform", ...ListQuery.parse(req.query) });
  });
  app.post("/platform/shared-assets", { bodyLimit: config.sharedAssets.maxFileBytes }, async (req, reply) => {
    if (!requireWriter(req, reply, true)) return;
    return upload(req, reply, { scope: "platform" });
  });

  app.post("/shared-assets/:id/archive", async (req, reply) => {
    if (!requireWriter(req, reply)) return;
    try {
      const id = Id.parse((req.params as { id: string }).id);
      const asset = await resolveAsset(req, id);
      const [archived] = await sql`UPDATE shared_assets SET status='archived',archived_at=now() WHERE id=${id} AND status<>'archived' RETURNING *`;
      if (!archived) return reply.code(409).send({ error: "asset_already_archived" });
      await audit(req, { action: "shared_asset.archive", projectId: asset.project_id as string | null, resourceType: "shared_asset", resourceId: id, before: { status: asset.status }, after: { status: "archived" } });
      return archived;
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/shared-assets/:id/content", async (req, reply) => {
    try {
      const id = Id.parse((req.params as { id: string }).id);
      const asset = await resolveAsset(req, id);
      const bytes = await readSharedAssetBlob(String(asset.blob_uri));
      await audit(req, { action: "shared_asset.download", projectId: asset.project_id as string | null, resourceType: "shared_asset", resourceId: id, after: { sha256: asset.content_sha256, bytes: asset.bytes } });
      return reply.header("content-type", String(asset.content_type)).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(String(asset.logical_key).split("/").at(-1) ?? "asset")}`).send(bytes);
    } catch (error) { return errorReply(reply, error); }
  });
}
