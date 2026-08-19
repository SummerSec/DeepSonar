import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { projectCredentialMetadata } from "../../credentials.js";
import { sql } from "../../db.js";
import { createSqlJobLifecycleApplication } from "../job-lifecycle/index.js";
import { revokeJobCapabilityTokens } from "../platform-api/tokens.js";
import { revokeJobTokens } from "../../gateway.js";
import { runner } from "../../runtime.js";
import { activateRuntimeImageConfiguration } from "../../runtime-image-config-activation.js";
import {
  applyUploadedRuntimeCatalog,
  hostRuntimePlatform,
  immutableDigest,
  inspectLocalRuntimeImage,
  localImageDigest,
  requestRuntimeImagePreparation,
  resolveConfiguredRuntimeImagesForChannel,
  resolveRuntimeImageForProjectBinding,
  runtimeImagePullStatus,
  runtimeImageVersionPin,
  runtimeImageRegistryWithOverrides,
  readRuntimeRegistryChannel,
  RuntimeImageChannelUnavailableError,
  RuntimeImagePreparationBusyError,
  runtimeImageHttpError,
  sanitizeRuntimeImageError,
  startRuntimeImagePull,
  syncOfficialRuntimeCatalog,
  updateRuntimeRegistryChannel,
  RUNTIME_IMAGE_REGISTRY_CHANNELS,
  type RuntimeImageRegistryChannel,
} from "../../runtime-images.js";

const RuntimeImageImportBody = z.object({
  image_key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(""),
  publisher: z.string().trim().min(1).max(120),
  source_url: z.string().url().optional(),
  image_ref: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(100).optional(),
  registry_credential_id: z.string().uuid().optional(),
});
const RuntimeImageStatusBody = z.object({
  status: z.enum(["trusted", "rejected", "disabled", "revoked"]),
  reason: z.string().trim().min(1).max(2_000).optional(),
});
export const RuntimeImageRegistryChannelBody = z.object({
  channel: z.enum(RUNTIME_IMAGE_REGISTRY_CHANNELS),
}).strict();
const OfficialRuntimeImageDigestBody = z.object({
  image_ref: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(100).optional(),
  source: z.enum(["registry", "local-build"]).default("registry"),
});
const LocalRuntimeImageInspectBody = z.object({
  image_ref: z.string().trim().min(1).max(500),
});
const LocalRuntimeImageAdoptBody = LocalRuntimeImageInspectBody.extend({
  expected_image_id: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/i),
  version: z.string().trim().min(1).max(100).optional(),
});

class RevokedRuntimeImageVersionError extends Error {
  constructor(public readonly versionId: string) {
    super("runtime image version is revoked and cannot be adopted");
    this.name = "RevokedRuntimeImageVersionError";
  }
}

const ManualRuntimeImageDigestBody = RuntimeImageImportBody.omit({ registry_credential_id: true }).extend({
  image_ref: z.string().trim().min(3).max(500),
});
const ProjectRuntimeImageBody = z.object({
  enabled: z.boolean().default(true),
  version_id: z.string().uuid().nullish(),
});

export function registerRuntimeImageRoutes(app: FastifyInstance): void {
  // ---------- 可信运行时镜像目录 / 市场（P1-P3） ----------

  app.get("/runtime-images", async (req, reply) => {
    const query = req.query as { project_id?: string; search?: string };
    if (req.actor?.projectId && query.project_id && query.project_id !== req.actor.projectId) {
      return reply.code(403).send({ error: `token 仅限项目 ${req.actor.projectId}` });
    }
    const projectId = query.project_id ?? null;
    const search = query.search?.trim() ? `%${query.search.trim()}%` : null;
    const hostPlatform = hostRuntimePlatform();
    const selectedChannel = await readRuntimeRegistryChannel(sql);
    return sql`
      SELECT ri.id, ri.image_key, ri.name, ri.description, ri.publisher, ri.source_url,
             ri.source_kind, ri.official, ri.project_opt_in, ri.enabled, ri.created_at, ri.updated_at,
             pri.enabled AS project_enabled, pri.selected_version_id,
             pin.version AS selected_version,
             pin.trust_status AS selected_trust_status,
             CASE
               WHEN pri.selected_version_id IS NULL THEN false
               WHEN latest.id IS NULL OR latest.trust_status IS DISTINCT FROM 'trusted' THEN false
               WHEN NOT (COALESCE(latest.platforms_json, '[]'::jsonb) @> ${sql.json([hostPlatform])}) THEN false
               WHEN ri.official AND latest.registry_channel IS NULL THEN false
               WHEN pin.id IS NULL THEN true
               WHEN pin.trust_status <> 'trusted' THEN true
               WHEN NOT (pin.platforms_json @> ${sql.json([hostPlatform])}) THEN true
               WHEN ri.official AND pin_ref.id IS NULL THEN true
               ELSE false
             END AS pin_stale,
             latest.id AS latest_version_id, latest.version AS latest_version,
             CASE WHEN ri.official THEN latest.channel_digest ELSE latest.digest END AS digest,
             CASE WHEN ri.official THEN latest.channel_resolved_ref ELSE latest.resolved_ref END AS resolved_ref,
             CASE WHEN ri.official THEN latest.registry_channel ELSE NULL END AS registry_channel,
             latest.platforms_json, latest.tools_json,
             latest.tools_manifest_sha256, latest.trust_status, latest.scan_summary_json,
             latest.size_bytes, latest.scanned_at, latest.approved_at, latest.promoted_at
      FROM runtime_images ri
      LEFT JOIN project_runtime_images pri
        ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
      LEFT JOIN runtime_image_versions pin
        ON pin.id = pri.selected_version_id
      LEFT JOIN runtime_image_version_refs pin_ref
        ON pin_ref.version_id = pin.id AND pin_ref.channel = ${selectedChannel}
      LEFT JOIN LATERAL (
        SELECT v.*, selected_ref.digest AS channel_digest,
               selected_ref.resolved_ref AS channel_resolved_ref,
               selected_ref.channel AS registry_channel
        FROM runtime_image_versions v
        LEFT JOIN runtime_image_version_refs selected_ref
          ON selected_ref.version_id = v.id AND selected_ref.channel = ${selectedChannel}
        WHERE v.runtime_image_id = ri.id
          AND (NOT ri.official OR selected_ref.id IS NOT NULL)
        ORDER BY CASE v.trust_status WHEN 'trusted' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
                 CASE
                   WHEN v.platforms_json @> ${sql.json([hostPlatform])} THEN 0
                   WHEN v.platforms_json IS NULL OR jsonb_array_length(v.platforms_json) = 0 THEN 1
                   ELSE 2
                 END,
                 v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
        LIMIT 1
      ) latest ON true
      WHERE (${search}::text IS NULL OR ri.name ILIKE ${search} OR ri.image_key ILIKE ${search}
             OR ri.publisher ILIKE ${search})
      ORDER BY ri.official DESC, ri.name`;
  });

  app.get("/runtime-images/registry", async () => {
    const [registry, selectedChannel] = await Promise.all([
      runtimeImageRegistryWithOverrides(),
      readRuntimeRegistryChannel(sql),
    ]);
    return { ...registry, selected_channel: selectedChannel };
  });

  app.patch("/runtime-images/registry/channel", async (req, reply) => {
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global runtime registry channel",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const parsed = RuntimeImageRegistryChannelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid runtime registry channel",
        error_code: "RUNTIME_REGISTRY_CHANNEL_INVALID",
        details: parsed.error.issues,
      });
    }
    try {
      const proposedChannel = parsed.data.channel as RuntimeImageRegistryChannel;
      const currentChannel = await readRuntimeRegistryChannel(sql);
      if (proposedChannel === currentChannel) {
        return reply.code(200).send({ selected_channel: currentChannel, previous_channel: currentChannel });
      }
      const snapshots = await resolveConfiguredRuntimeImagesForChannel(sql, proposedChannel);
      const activation = await activateRuntimeImageConfiguration({
        refs: snapshots.map((snapshot) => ({ image_key: snapshot.image_key, image_ref: snapshot.image_ref })),
        purpose: `registry_channel:${proposedChannel}`,
        persist: () => sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          return updateRuntimeRegistryChannel(tx, proposedChannel);
        }),
      });
      if (activation.status === "preparing") {
        return reply.code(202).send({
          status: "preparing",
          saved: false,
          selected_channel: currentChannel,
          proposed_channel: proposedChannel,
          task: activation.task,
        });
      }
      const result = activation.value;
      await audit(req, {
        action: "runtime_image.registry_channel_update",
        resourceType: "global_settings",
        resourceId: "global",
        before: { selected_channel: result.previous_channel },
        after: { selected_channel: result.channel },
      });
      return reply.code(200).send({
        selected_channel: result.channel,
        previous_channel: result.previous_channel,
      });
    } catch (error) {
      const mapped = runtimeImageHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return reply.code(error instanceof RuntimeImagePreparationBusyError ? 409 : 500).send({
        error: sanitizeRuntimeImageError(error) || "runtime registry channel update failed",
        error_code: error instanceof RuntimeImagePreparationBusyError ? error.code : "RUNTIME_REGISTRY_CHANNEL_UPDATE_FAILED",
      });
    }
  });

  app.post("/runtime-images/registry/sync", async (req, reply) => {
    try {
      const result = await syncOfficialRuntimeCatalog();
      await audit(req, {
        action: "runtime_image.registry_sync",
        resourceType: "runtime_image_catalog",
        after: { product_count: result.product_count, version_count: result.version_count, synced_at: result.synced_at },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "读取或同步运行时镜像注册表失败" });
    }
  });

  /** 运维手动上传 runtime-image-registry.json，校验后写入市场（不依赖 GitHub 可达性） */
  app.post("/runtime-images/registry/apply", async (req, reply) => {
    try {
      const body = req.body;
      // 允许直接贴清单对象，或包一层 { registry: ... }
      const raw = body && typeof body === "object" && body !== null && "registry" in (body as object)
        && (body as { registry?: unknown }).registry !== undefined
        ? (body as { registry: unknown }).registry
        : body;
      const result = await applyUploadedRuntimeCatalog(raw);
      await audit(req, {
        action: "runtime_image.registry_apply",
        resourceType: "runtime_image_catalog",
        after: {
          product_count: result.product_count,
          version_count: result.version_count,
          synced_at: result.synced_at,
          source: "upload",
        },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "上传的运行时镜像注册表无效",
      });
    }
  });

  app.post("/runtime-images/registry/pull", async (req, reply) => {
    try {
      const task = await startRuntimeImagePull();
      await audit(req, {
        action: "runtime_image.registry_pull",
        resourceType: "runtime_image_pull",
        resourceId: task.task_id,
        after: { task_id: task.task_id, total: task.total },
      });
      return reply.code(202).send({ task });
    } catch (error) {
      const message = sanitizeRuntimeImageError(error) || "启动镜像拉取失败";
      if (error instanceof RuntimeImageChannelUnavailableError) {
        return reply.code(error.statusCode).send({
          error: message,
          error_code: error.code,
          channel: error.channel,
          ...(error.imageKey ? { image_key: error.imageKey } : {}),
          task: runtimeImagePullStatus(),
        });
      }
      return reply.code(message.includes("已有运行中") || message.includes("没有可拉取") ? 409 : 503).send({ error: message, task: runtimeImagePullStatus() });
    }
  });

  app.get("/runtime-images/registry/pull-status", async (_req, reply) => {
    return reply.send(runtimeImagePullStatus() ?? {
      task_id: null,
      status: "idle",
      started_at: null,
      finished_at: null,
      total: 0,
      completed: 0,
      items: [],
    });
  });

  const inspectLocalRuntimeImageForProduct = async (productId: string, imageRef: string) => {
    const [image] = await sql`SELECT id, image_key, official, enabled FROM runtime_images WHERE id = ${productId}`;
    if (!image) return { image: null, inspection: null } as const;
    const refs = await sql`
      SELECT image_ref, resolved_ref FROM runtime_image_versions
      WHERE runtime_image_id = ${productId}`;
    const knownRefs = refs.flatMap((row) => [row.image_ref, row.resolved_ref])
      .filter((value): value is string => typeof value === "string");
    return {
      image,
      inspection: await inspectLocalRuntimeImage(imageRef, image.image_key as string, knownRefs),
    } as const;
  };
  const localInspectionResponse = (inspection: Awaited<ReturnType<typeof inspectLocalRuntimeImage>>) => ({
    ...inspection,
    architecture: inspection.arch,
    contract_valid: inspection.contract_matches,
    product_match: inspection.matches_product,
    adoptable: inspection.can_adopt,
    tool_manifest_valid: inspection.tool_manifest_matches,
    labels: {
      ...(inspection.labels.contract ? { "io.deepsonar.contract": inspection.labels.contract } : {}),
      ...(inspection.labels.image_key ? { "io.deepsonar.image-key": inspection.labels.image_key } : {}),
      ...(inspection.labels.toolset ? { "io.deepsonar.toolset": inspection.labels.toolset } : {}),
      ...(inspection.labels.tool_manifest && inspection.labels.tool_manifest_label
        ? { [inspection.labels.tool_manifest_label]: inspection.labels.tool_manifest } : {}),
    },
  });

  /**
   * Read-only local image check. A mutable tag is accepted as an inspect input,
   * but it is never trusted or persisted by this endpoint.
   */
  app.post("/runtime-images/:id([0-9a-fA-F-]{36})/detect-local", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LocalRuntimeImageInspectBody.parse(req.body);
    const result = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
    if (!result.image) return reply.code(404).send({ error: "runtime image not found" });
    return reply.send({
      product_id: id,
      product_key: result.image.image_key,
      ...localInspectionResponse(result.inspection!),
    });
  });

  /**
   * Explicit administrator adoption of a locally inspected image. The image is
   * inspected again here (TOCTOU guard), and expected_image_id must match the
   * fresh Docker ID before a trusted local-only version is written.
   */
  app.post("/runtime-images/:id([0-9a-fA-F-]{36})/adopt-local", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LocalRuntimeImageAdoptBody.parse(req.body);
    if (config.runtime.provider !== "local-docker") {
      return reply.code(400).send({ error: "adopt-local 仅支持 SANDBOX_PROVIDER=local-docker" });
    }
    const result = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
    if (!result.image) return reply.code(404).send({ error: "runtime image not found" });
    if (!result.image.official) {
      return reply.code(400).send({
        error: "本地直接采用仅适用于官方产品；第三方镜像仍须经过导入、准入扫描与管理员批准",
      });
    }
    const inspection = result.inspection!;
    if (!inspection.exists && inspection.reasons.includes("docker_inspect_failed")) {
      return reply.code(503).send({ error: inspection.error || "无法验证本地 Docker 镜像", inspection: localInspectionResponse(inspection) });
    }
    if (inspection.image_id?.toLowerCase() !== body.expected_image_id.toLowerCase()) {
      return reply.code(409).send({
        error: "本地镜像 image ID 已变化，请重新检测后再采用",
        expected_image_id: body.expected_image_id,
        actual_image_id: inspection.image_id,
        inspection: localInspectionResponse(inspection),
      });
    }
    if (!inspection.can_adopt || !inspection.immutable_ref) {
      return reply.code(409).send({ error: "本地镜像未通过运行时契约门禁", inspection: localInspectionResponse(inspection) });
    }
    const digest = immutableDigest(inspection.immutable_ref) ?? localImageDigest(inspection.immutable_ref);
    if (!digest) return reply.code(409).send({ error: "本地镜像没有可用的不可变引用", inspection: localInspectionResponse(inspection) });
    const now = new Date();
    const actor = req.actor?.name ?? "internal";
    let version: Record<string, unknown>;
    try {
      version = await sql.begin(async (tx) => {
        // Lock an existing digest before deciding whether it may be adopted.
        // If a concurrent transaction inserts the digest after this check, the
        // guarded ON CONFLICT below waits for it and applies the same rule.
        const [existing] = await tx`
          SELECT id, trust_status FROM runtime_image_versions
          WHERE runtime_image_id = ${id} AND digest = ${digest}
          FOR UPDATE`;
        if (existing?.trust_status === "revoked") {
          throw new RevokedRuntimeImageVersionError(existing.id as string);
        }

        const [saved] = await tx`
          INSERT INTO runtime_image_versions ${tx({
            runtime_image_id: id,
            version: body.version ?? `local-${digest.slice(7, 19)}`,
            image_ref: inspection.immutable_ref,
            resolved_ref: inspection.immutable_ref,
            digest,
            contract_version: "deepsonar.runtime.contract/v1",
            platforms_json: (inspection.os && inspection.arch ? [`${inspection.os}/${inspection.arch}`] : []) as never,
            scan_summary_json: {
              source: "local-adopt",
              risk: "local-only",
              contract: inspection.labels.contract,
              image_key: result.image.image_key,
              tool_manifest_label: inspection.labels.tool_manifest_label,
              registered_by: actor,
            } as never,
            trust_status: "trusted",
            imported_by: actor,
            approved_by: actor,
            scanned_at: now,
            approved_at: now,
            promoted_at: now,
          } as never)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = EXCLUDED.image_ref,
            resolved_ref = EXCLUDED.resolved_ref,
            trust_status = 'trusted',
            contract_version = EXCLUDED.contract_version,
            platforms_json = EXCLUDED.platforms_json,
            scan_summary_json = EXCLUDED.scan_summary_json,
            imported_by = EXCLUDED.imported_by,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            promoted_at = EXCLUDED.promoted_at,
            status_reason = NULL,
            updated_at = now()
          WHERE runtime_image_versions.trust_status <> 'revoked'
          RETURNING *`;
        if (saved) return saved as Record<string, unknown>;

        // A concurrent insert may have won the unique-index race with a
        // revoked row. Re-read it under the transaction lock so the caller
        // gets a deterministic 409 instead of silently reviving the version.
        const [current] = await tx`
          SELECT id, trust_status FROM runtime_image_versions
          WHERE runtime_image_id = ${id} AND digest = ${digest}
          FOR UPDATE`;
        if (current?.trust_status === "revoked") {
          throw new RevokedRuntimeImageVersionError(current.id as string);
        }
        throw new Error("runtime image adoption conflict; please retry");
      });
    } catch (error) {
      if (error instanceof RevokedRuntimeImageVersionError) {
        return reply.code(409).send({
          error: "runtime image version is revoked and cannot be adopted",
          runtime_image_version_id: error.versionId,
        });
      }
      throw error;
    }
    await audit(req, {
      action: "runtime_image.adopt_local",
      resourceType: "runtime_image_version",
      resourceId: version.id as string,
      after: {
        image_key: result.image.image_key,
        immutable_ref: inspection.immutable_ref,
        digest,
        trust_status: "trusted",
        local_only: true,
      },
    });
    return reply.code(201).send({
      adopted: true,
      local_only: true,
      product_id: id,
      product_key: result.image.image_key,
      immutable_ref: inspection.immutable_ref,
      image: result.image,
      version,
      inspection: localInspectionResponse(inspection),
    });
  });

  /**
   * 注意：`:id` 必须带 uuid 约束，否则会吞掉同层静态路由 `/runtime-images/registry`
   * （Fastify find-my-way 在本版本未把静态路由优先于参数路由）。
   * registry / manual-digest / import / official-digest 等静态段必须不受 :id 干扰。
   */
  app.get("/runtime-images/:id([0-9a-fA-F-]{36})", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [image] = await sql`SELECT * FROM runtime_images WHERE id = ${id}`;
    if (!image) return reply.code(404).send({ error: "runtime image not found" });
    const versions = await sql`
      SELECT v.*,
             COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC)
                       FROM runtime_image_scans s WHERE s.runtime_image_version_id = v.id), '[]'::jsonb) AS scans
      FROM runtime_image_versions v WHERE v.runtime_image_id = ${id}
      ORDER BY v.promoted_at DESC NULLS LAST, v.created_at DESC`;
    return { image, versions };
  });

  /**
   * 官方镜像登记可信 digest。
   * 官方条目不能走第三方 import；本地/运维常缺 DEEPSONAR_OFFICIAL_*_IMAGE，
   * 此接口与启动 bootstrap 相同：只接受 @sha256 不可变引用，直接 trusted。
   */
  app.post("/runtime-images/:id/official-digest", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = OfficialRuntimeImageDigestBody.parse(req.body);
    const [image] = await sql`SELECT * FROM runtime_images WHERE id = ${id}`;
    if (!image) return reply.code(404).send({ error: "runtime image not found" });
    if (!image.official) {
      return reply.code(400).send({ error: "仅官方镜像可通过此接口登记 digest；第三方请走导入 + 准入扫描 + 批准" });
    }
    const local = body.source === "local-build";
    let digest = local ? localImageDigest(body.image_ref) : immutableDigest(body.image_ref);
    let localImmutableRef = body.image_ref;
    let localInspection: Awaited<ReturnType<typeof inspectLocalRuntimeImage>> | null = null;
    if (!digest) return reply.code(400).send({
      error: local ? "local-build 必须使用完整本地 image ID：sha256:64hex" : "必须使用不可变引用 name@sha256:…；可移动 tag 不会被信任",
    });
    if (local && config.runtime.provider !== "local-docker") {
      return reply.code(400).send({ error: "local-build 仅支持 SANDBOX_PROVIDER=local-docker" });
    }
    if (!local && !config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    if (local) {
      const localResult = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
      localInspection = localResult.inspection;
      if (!localInspection?.exists) {
        return reply.code(503).send({ error: localInspection?.error || "无法验证本地 Docker 镜像；请确认 Docker 可用且该 image ID 已存在", inspection: localInspection ? localInspectionResponse(localInspection) : null });
      }
      if (localInspection.image_id?.toLowerCase() !== body.image_ref.toLowerCase()) {
        return reply.code(400).send({ error: "Docker 镜像存在，但 image ID 校验不匹配", inspection: localInspectionResponse(localInspection) });
      }
      if (!localInspection.can_adopt || !localInspection.immutable_ref) {
        return reply.code(400).send({ error: "本地镜像未通过运行时契约门禁", inspection: localInspectionResponse(localInspection) });
      }
      localImmutableRef = localInspection.immutable_ref;
      digest = immutableDigest(localImmutableRef) ?? localImageDigest(localImmutableRef);
      if (!digest) return reply.code(400).send({ error: "本地镜像没有可用的不可变引用", inspection: localInspectionResponse(localInspection) });
    }
    const versionName = body.version ?? `${local ? "local" : "configured"}-${digest.slice(7, 19)}`;
    const platforms = local
      ? (localInspection?.os && localInspection.arch ? [`${localInspection.os}/${localInspection.arch}`]
        : process.arch === "x64" ? ["linux/amd64"] : process.arch === "arm64" ? ["linux/arm64"] : [])
      : ["linux/amd64", "linux/arm64"];
    const now = new Date();
    const [version] = await sql`
      INSERT INTO runtime_image_versions ${sql({
        runtime_image_id: image.id,
        version: versionName,
        image_ref: local ? localImmutableRef : body.image_ref,
        resolved_ref: local ? localImmutableRef : digest,
        digest,
        contract_version: "deepsonar.runtime.contract/v1",
        platforms_json: platforms as never,
        scan_summary_json: {
          source: local ? "operator-registered-official-local" : "operator-registered-official",
          risk: local ? "local-only" : undefined,
          contract: local ? localInspection?.labels.contract : "declared",
          image_key: local ? localInspection?.labels.image_key ?? localInspection?.labels.toolset : undefined,
          tool_manifest_label: local ? localInspection?.labels.tool_manifest_label : undefined,
          registered_by: req.actor?.name ?? "internal",
        } as never,
        trust_status: "trusted",
        approved_by: req.actor?.name ?? "internal",
        scanned_at: now,
        approved_at: now,
        promoted_at: now,
      } as never)}
      ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
        image_ref = EXCLUDED.image_ref,
        resolved_ref = EXCLUDED.resolved_ref,
        trust_status = 'trusted',
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        promoted_at = EXCLUDED.promoted_at,
        status_reason = NULL,
        updated_at = now()
      RETURNING *`;
    await audit(req, {
      action: "runtime_image.official_digest",
      resourceType: "runtime_image_version",
      resourceId: version.id as string,
      after: {
        image_key: image.image_key,
        image_ref: body.image_ref,
        digest,
        trust_status: "trusted",
      },
    });
    return reply.code(201).send({ image, version });
  });

  app.post("/runtime-images/manual-digest", async (req, reply) => {
    const body = ManualRuntimeImageDigestBody.parse(req.body);
    const digest = immutableDigest(body.image_ref);
    if (!digest) return reply.code(400).send({ error: "必须使用不可变引用 name@sha256:64hex" });
    if (!config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    let image: Record<string, unknown>;
    let version: Record<string, unknown>;
    try {
      ({ image, version } = await sql.begin(async (tx) => {
        const [existing] = await tx`SELECT official FROM runtime_images WHERE image_key = ${body.image_key}`;
        if (existing?.official) throw new Error("官方产品不能通过手动登记绕过官方约束");
        const [savedImage] = await tx`
          INSERT INTO runtime_images ${tx({ image_key: body.image_key, name: body.name, description: body.description,
            publisher: body.publisher, source_url: body.source_url ?? null, source_kind: "third_party", official: false,
            project_opt_in: true } as never)}
          ON CONFLICT (image_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
            publisher = EXCLUDED.publisher, source_url = EXCLUDED.source_url, project_opt_in = true, enabled = true, updated_at = now()
          RETURNING *`;
        const now = new Date();
        const [savedVersion] = await tx`
          INSERT INTO runtime_image_versions ${tx({ runtime_image_id: savedImage.id, version: body.version ?? `manual-${digest.slice(7, 19)}`,
            image_ref: body.image_ref, resolved_ref: body.image_ref, digest, contract_version: "deepsonar.runtime.contract/v1",
            platforms_json: ["linux/amd64", "linux/arm64"] as never,
            scan_summary_json: { source: "manual-operator", risk: "bypasses-admission-scan" } as never,
            trust_status: "trusted", imported_by: req.actor?.name ?? "operator", approved_by: req.actor?.name ?? "operator",
            approved_at: now, promoted_at: now } as never)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET image_ref = EXCLUDED.image_ref,
            resolved_ref = EXCLUDED.resolved_ref, trust_status = 'trusted', imported_by = EXCLUDED.imported_by,
            approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, promoted_at = EXCLUDED.promoted_at,
            status_reason = NULL, updated_at = now()
          RETURNING *`;
        return { image: savedImage as Record<string, unknown>, version: savedVersion as Record<string, unknown> };
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "官方产品不能通过手动登记绕过官方约束") {
        return reply.code(400).send({ error: error.message });
      }
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "同一镜像产品的版本名称已存在且对应不同 digest，请更换 version 名称" });
      }
      throw error;
    }
    await audit(req, { action: "runtime_image.manual_digest", resourceType: "runtime_image_version", resourceId: version.id as string,
      after: { image_key: image.image_key, image_ref: body.image_ref, digest, trust_status: "trusted", source: "manual-operator" } });
    return reply.code(201).send({ image, version });
  });

  app.post("/runtime-images/import", async (req, reply) => {
    const body = RuntimeImageImportBody.parse(req.body);
    if (!config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    if (body.registry_credential_id) {
      const [credential] = await sql`
        SELECT id FROM credentials WHERE id = ${body.registry_credential_id}
          AND kind = 'oci_registry' AND status = 'active'`;
      if (!credential) return reply.code(400).send({ error: "registry Credential 不存在或不可用" });
    }
    const digest = immutableDigest(body.image_ref);
    const versionName = body.version ?? (digest ? digest.slice(7, 19) : body.image_ref.split(":").at(-1) ?? "imported");
    try {
      const result = await sql.begin(async (tx) => {
        const [existing] = await tx`SELECT id, official FROM runtime_images WHERE image_key = ${body.image_key}`;
        if (existing?.official) throw new Error("不能通过第三方导入 API 覆盖官方镜像");
        const [image] = existing
          ? await tx`
              UPDATE runtime_images SET name = ${body.name}, description = ${body.description},
                publisher = ${body.publisher}, source_url = ${body.source_url ?? null}, updated_at = now()
              WHERE id = ${existing.id as string} RETURNING *`
          : await tx`
              INSERT INTO runtime_images ${tx({
                image_key: body.image_key,
                name: body.name,
                description: body.description,
                publisher: body.publisher,
                source_url: body.source_url ?? null,
                source_kind: "third_party",
                official: false,
                enabled: true,
              })} RETURNING *`;
        const [version] = await tx`
          INSERT INTO runtime_image_versions ${tx({
            runtime_image_id: image.id,
            version: versionName,
            image_ref: body.image_ref,
            resolved_ref: digest ? body.image_ref : null,
            digest,
            trust_status: "quarantined",
            imported_by: req.actor?.name ?? "internal",
          } as never)} RETURNING *`;
        const [scan] = await tx`
          INSERT INTO runtime_image_scans ${tx({
            runtime_image_version_id: version.id,
            result_json: body.registry_credential_id
              ? { registry_credential_id: body.registry_credential_id } as never
              : {} as never,
          } as never)} RETURNING *`;
        return { image, version, scan };
      });
      await audit(req, {
        action: "runtime_image.import",
        resourceType: "runtime_image_version",
        resourceId: result.version.id as string,
        after: { image_key: body.image_key, image_ref: body.image_ref, trust_status: "quarantined" },
      });
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该镜像版本或 digest 已导入" });
      }
      throw error;
    }
  });

  app.post("/runtime-image-versions/:id/rescan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [version] = await sql`
      UPDATE runtime_image_versions SET
        trust_status = CASE WHEN trust_status = 'trusted' THEN 'trusted' ELSE 'quarantined' END,
        status_reason = NULL, updated_at = now()
      WHERE id = ${id} AND trust_status <> 'revoked' RETURNING id`;
    if (!version) return reply.code(404).send({ error: "version not found or revoked" });
    const [scan] = await sql`
      INSERT INTO runtime_image_scans (runtime_image_version_id) VALUES (${id}) RETURNING *`;
    await audit(req, { action: "runtime_image.rescan", resourceType: "runtime_image_version", resourceId: id });
    return reply.code(202).send(scan);
  });

  app.post("/runtime-image-versions/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = RuntimeImageStatusBody.parse(req.body);
    if ((body.status === "rejected" || body.status === "revoked") && !body.reason) {
      return reply.code(400).send({ error: `${body.status} 必须填写 reason` });
    }
    const [before] = await sql`
      SELECT v.*, ri.image_key FROM runtime_image_versions v
      JOIN runtime_images ri ON ri.id = v.runtime_image_id WHERE v.id = ${id}`;
    if (!before) return reply.code(404).send({ error: "version not found" });
    if (body.status === "trusted") {
      const [scan] = await sql`
        SELECT id, status FROM runtime_image_scans WHERE runtime_image_version_id = ${id}
        ORDER BY created_at DESC LIMIT 1`;
      if (!scan || scan.status !== "succeeded" || !before.resolved_ref || !before.digest) {
        return reply.code(409).send({ error: "版本最新一次准入扫描未通过或未固定 digest" });
      }
    }
    const now = new Date();
    const [version] = await sql`
      UPDATE runtime_image_versions SET
        trust_status = ${body.status}, status_reason = ${body.reason ?? null}, updated_at = now(),
        approved_by = ${body.status === "trusted" ? req.actor?.name ?? "internal" : before.approved_by},
        approved_at = ${body.status === "trusted" ? now : before.approved_at},
        promoted_at = ${body.status === "trusted" ? now : before.promoted_at},
        revoked_at = ${body.status === "revoked" ? now : before.revoked_at}
      WHERE id = ${id} RETURNING *`;

    if (body.status === "revoked") {
      const affected = await createSqlJobLifecycleApplication().cancelJobsForRuntimeImageVersion(
        id,
        `runtime image revoked: ${body.reason}`,
      );
      for (const job of affected) {
        await revokeJobTokens(job.id as string, "runtime_image_revoked").catch(() => {});
        await revokeJobCapabilityTokens(job.id as string, "runtime_image_revoked").catch(() => {});
        if (job.sandbox_id) await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
      }
    }
    await audit(req, {
      action: `runtime_image.${body.status}`,
      resourceType: "runtime_image_version",
      resourceId: id,
      before: { trust_status: before.trust_status },
      after: { trust_status: body.status, reason: body.reason ?? null },
    });
    return version;
  });

  app.get("/runtime-image-versions/:id/usage", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [version] = await sql`SELECT id FROM runtime_image_versions WHERE id = ${id}`;
    if (!version) return reply.code(404).send({ error: "version not found" });
    const jobs = await sql`
      SELECT j.id, j.project_id, p.name AS project_name, j.canvas_id, c.title AS canvas_title,
             j.type, j.status, j.created_at, j.finished_at,
             (SELECT count(*)::int FROM findings f WHERE f.job_id = j.id) AS finding_count
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY j.created_at DESC LIMIT 1000`;
    const projects = await sql`
      SELECT DISTINCT p.id, p.name
      FROM jobs j JOIN projects p ON p.id = j.project_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY p.name`;
    const findings = await sql`
      SELECT f.id, f.project_id, j.canvas_id, f.job_id, f.title, f.severity, f.verify_status, f.created_at
      FROM findings f JOIN jobs j ON j.id = f.job_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY f.created_at DESC LIMIT 1000`;
    return { version_id: id, projects, jobs, findings };
  });

  app.put("/projects/:id/runtime-images/:imageId", async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    const body = ProjectRuntimeImageBody.parse(req.body);
    const [image] = await sql`SELECT id, enabled FROM runtime_images WHERE id = ${imageId}`;
    if (!image?.enabled) return reply.code(404).send({ error: "runtime image not found or disabled" });
    const selectedVersionId = runtimeImageVersionPin(body.version_id);
    try {
      if (body.enabled) {
        if (config.runtime.agentMode === "fake") {
          const [version] = body.version_id
            ? await sql`SELECT id FROM runtime_image_versions WHERE id = ${body.version_id} AND runtime_image_id = ${imageId} AND trust_status = 'trusted'`
            : await sql`SELECT id FROM runtime_image_versions WHERE runtime_image_id = ${imageId} AND trust_status = 'trusted' ORDER BY promoted_at DESC NULLS LAST, created_at DESC LIMIT 1`;
          if (!version) return reply.code(409).send({ error: "镜像没有可启用的可信版本" });
        } else {
          const snapshot = await resolveRuntimeImageForProjectBinding(sql, imageId, selectedVersionId);
          if (config.runtime.provider === "local-docker") {
            const preparation = await requestRuntimeImagePreparation(
              [{ image_key: snapshot.image_key, image_ref: snapshot.image_ref }],
              `project_binding:${id}:${imageId}`,
            );
            if (!preparation.ready) {
              return reply.code(202).send({ status: "preparing", saved: false, task: preparation.task });
            }
          }
        }
      }
    } catch (error) {
      const mapped = runtimeImageHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      return reply.code(error instanceof RuntimeImagePreparationBusyError ? 409 : 503).send({
        error: sanitizeRuntimeImageError(error) || "runtime image preparation failed",
        code: error instanceof RuntimeImagePreparationBusyError ? error.code : "runtime_image_prepare_failed",
      });
    }
    const [row] = await sql`
      INSERT INTO project_runtime_images ${sql({
        project_id: id,
        runtime_image_id: imageId,
        selected_version_id: selectedVersionId,
        enabled: body.enabled,
      } as never)}
      ON CONFLICT (project_id, runtime_image_id) DO UPDATE SET
        selected_version_id = EXCLUDED.selected_version_id,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *`;
    await audit(req, {
      action: "runtime_image.project_binding",
      resourceType: "runtime_image",
      resourceId: imageId,
      projectId: id,
      after: { enabled: body.enabled, selected_version_id: selectedVersionId },
    });
    return row;
  });
}
