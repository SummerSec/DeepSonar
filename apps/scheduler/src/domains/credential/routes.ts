import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AgentCliWriteSchema,
  PlatformToolName,
  allowedPlatformTools,
  parseModuleSelector,
  requiredPlatformTools,
} from "@deepsonar/shared-types";
import { z } from "zod";
import { audit, credentialAuditState } from "../../audit.js";
import { config } from "../../config.js";
import {
  normalizeModelCatalog,
  encryptSecret,
  fingerprintOf,
  isProviderKnown,
  isProviderAllowedForKind,
  last4Of,
  projectCredentialProviderError,
  projectCredentialMetadata,
  projectJobEventPayload,
  projectJobPayload,
  projectCredentialProvider,
  providerSupportsBaseUrl,
  PROVIDER_CATALOG,
  sanitizeCredentialMetadata,
  UNKNOWN_PROVIDER_ERROR,
  type CredentialHealthErrorCategory,
  validateCredentialAgentCliExclusive,
  validateCredentialCompatibility,
  validateCredentialRuntimeMutation,
  type Encrypted,
} from "../../credentials.js";
import { CredentialProbeError, discoverModelCatalog, listCredentialModelsPreview, testCredential } from "../../credential-test.js";
import {
  extractBaseUrlFromSettings,
  normalizeProviderSettings,
  parseContextWindowTokens,
  projectProviderRuntimeSnapshot,
  resolveEffectiveModel,
  resolveRequestedModel,
  type ProviderRuntimeSnapshotProjection,
} from "../../provider-settings.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "../../core.js";
import {
  accumulateDispatchCounts,
  activeConcurrencyForCredential,
  queryActiveDispatchRows,
} from "../../dispatch-active-concurrency.js";
import { PLATFORM_DEFAULT_AGENT_CLI, PLATFORM_DEFAULT_AGENT_MODEL } from "../role-runtime-snapshot/index.js";
import { parseProjectImagePolicy, persistableProjectRoleConfigModel } from "../role-runtime-snapshot/application.js";
import { findProviderAdapter, resolveModelDescriptorCatalog } from "../provider-adapter/index.js";
import { sql } from "../../db.js";
import { RESUMABLE_JOB_STATUSES } from "../job-lifecycle/transition-policy.js";
import {
  containsSecretMask,
  MASKED_SECRET_PLACEHOLDER,
  restoreMaskedSecretValues,
} from "../../credential-secret-projection.js";

export function registerCredentialRoutes(app: FastifyInstance): void {
  // ---------- Provider Credential（§6.2/§6.4：密钥列 AES-GCM；与 API Token 严格分离） ----------
  // #689：管理 API 的 settings_config_json 返回明文 API Key，供编辑表单回显；
  // ciphertext 列仍不对外返回。Job 快照继续走 redactSecretProjection。
  const CRED_SAFE = sql`id, name, kind, provider, project_id, key_version, public_metadata_json,
                        fingerprint, last4, status, last_used_at, rotated_at,
                        last_tested_at, health_status, health_error_category,
                        health_detail, model_catalog_json, model_catalog_fetched_at,
                        agent_cli, settings_config_json, meta_json,
                        created_at, created_by`;

  const AgentCliSchema = AgentCliWriteSchema;
  const CredentialBody = z.object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["llm_provider", "git", "oci_registry"]).default("llm_provider"),
    provider: z.string().trim().min(1).max(50),
    secret: z.string().min(1).max(4096),
    project_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** CC Switch agent_cli column for this profile (llm_provider only). #707: 不可置空. */
    agent_cli: AgentCliSchema.optional(),
    /** Full CLI settingsConfig (may include plaintext keys); empty = legacy env path. */
    settings_config: z.record(z.string(), z.unknown()).optional().superRefine((value, ctx) => {
      try {
        parseContextWindowTokens(value?.context_window_tokens);
      } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ["context_window_tokens"] });
      }
    }),
    /** Manager-only meta (apiFormat, fullUrl, reasoning maps, …). */
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  const CredentialModelsPreviewBody = z.object({
    agent_cli: AgentCliSchema.default("claude-code"),
    provider: z.string().trim().min(1).max(50),
    secret: z.string().min(1).max(4096),
    base_url: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    settings_config: z.record(z.string(), z.unknown()).optional(),
  }).superRefine((body, ctx) => {
    const error = validateCredentialCompatibility(body.agent_cli, body.provider);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provider 与 agent_cli 不兼容", path: ["provider"] });
  });

  function safeHealthDetail(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    return value;
  }

  function credentialView(row: Record<string, unknown>, extras: Record<string, unknown> = {}): Record<string, unknown> {
    const kind = String(row.kind ?? "");
    const provider = String(row.provider ?? "");
    const providerProjection = projectCredentialProvider(kind, provider);
    const metadata = projectCredentialMetadata(kind, provider, row.public_metadata_json);
    const modelCatalog = normalizeModelCatalog(row.model_catalog_json);
    const healthStatus = row.health_status === "ok" || row.health_status === "error" ? row.health_status : "unknown";
    const adapter = findProviderAdapter(provider);
    const modelDescriptors = resolveModelDescriptorCatalog({
      provider,
      catalogJson: row.model_catalog_json,
      catalogRevision: typeof row.model_catalog_fetched_at === "string"
        ? row.model_catalog_fetched_at
        : `credential:${String(row.id ?? "unknown")}`,
      compatibleAgentClis: adapter?.cli_compatibility.filter((item) => item.compatible).map((item) => item.agent_cli),
      healthStatus: healthStatus === "ok" ? "verified" : healthStatus === "error" ? "probe_failed" : undefined,
    });
    const healthErrorCategory = typeof row.health_error_category === "string" ? row.health_error_category : null;
    const healthDetail = safeHealthDetail(row.health_detail);
    const settingsConfig = row.settings_config_json && typeof row.settings_config_json === "object" && !Array.isArray(row.settings_config_json)
      ? row.settings_config_json as Record<string, unknown>
      : {};
    const metaJson = row.meta_json && typeof row.meta_json === "object" && !Array.isArray(row.meta_json)
      ? row.meta_json as Record<string, unknown>
      : {};
    return {
      ...row,
      ...providerProjection,
      public_metadata_json: metadata,
      model_catalog_json: modelCatalog,
      model_descriptors: modelDescriptors,
      adapter: adapter ? {
        adapter_id: adapter.adapter_id,
        adapter_version: adapter.adapter_version,
        provider: adapter.provider,
        label: adapter.label,
        compatible_agent_clis: adapter.cli_compatibility.filter((item) => item.compatible).map((item) => item.agent_cli),
        gateway: adapter.gateway,
      } : null,
      agent_cli: row.agent_cli ?? null,
      settings_config_json: settingsConfig,
      meta_json: metaJson,
      scope: row.project_id ? "project" : "global",
      health: {
        status: healthStatus,
        last_tested_at: row.last_tested_at ?? null,
        error_category: healthErrorCategory,
        detail: healthDetail,
        model_catalog: modelCatalog,
        model_descriptors: modelDescriptors,
        model_catalog_fetched_at: row.model_catalog_fetched_at ?? null,
      },
      ...extras,
    };
  }

  /**
   * Provider choices are a scheduler-owned catalog.  The web console may
   * render these choices, but it never decides the secret environment key or
   * accepts an arbitrary provider string from a task/Agent.
   */
  app.get("/credentials/providers", async () => {
    return PROVIDER_CATALOG;
  });

  const ACTIVE_FROZEN_JOB_STATUSES = ["claimed", "provisioning", "running", "waiting_human"] as const;
  const RECOVERABLE_JOB_STATUSES = RESUMABLE_JOB_STATUSES.filter((status) => status !== "waiting_human");
  const BLOCKING_JOB_STATUSES = ["pending", ...ACTIVE_FROZEN_JOB_STATUSES, ...RECOVERABLE_JOB_STATUSES];
  const ACTIVE_SCAN_STATUSES = ["queued", "claimed", "running"] as const;

  async function credentialImpact(
    query: typeof sql,
    id: string,
    actorProjectId: string | null = null,
  ): Promise<Record<string, unknown>> {
    const [bindingCount, bindings, jobCount, pendingJobs, activeJobs, recoverableJobs, terminalJobs, scanCount, activeScans] = await Promise.all([
      query<{ count: number }[]>`SELECT 0::int AS count`,
      query`SELECT NULL::uuid AS role_config_id WHERE false`,
      query<{ pending_unclaimed: number; active_frozen: number; recoverable: number; terminal_historical: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_unclaimed,
          COUNT(*) FILTER (WHERE status IN ('claimed','provisioning','running','waiting_human'))::int AS active_frozen,
          COUNT(*) FILTER (WHERE status IN ('failed','timeout','orphan'))::int AS recoverable,
          COUNT(*) FILTER (WHERE status IN ('succeeded','cancelled'))::int AS terminal_historical
        FROM jobs
        WHERE agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})`,
      query`
        SELECT j.id, j.status, j.project_id, p.name AS project_name,
               j.agent_snapshot_json->>'name' AS role_name,
               j.agent_snapshot_json->>'model' AS model,
               j.created_at
        FROM jobs j
        LEFT JOIN projects p ON p.id = j.project_id
        WHERE j.agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR j.project_id = ${actorProjectId})
          AND j.status = 'pending'
        ORDER BY j.created_at DESC
        LIMIT 50`,
      query`
        SELECT j.id, j.status, j.project_id, p.name AS project_name,
               j.agent_snapshot_json->>'name' AS role_name,
               j.agent_snapshot_json->>'model' AS model,
               j.created_at
        FROM jobs j
        LEFT JOIN projects p ON p.id = j.project_id
        WHERE j.agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR j.project_id = ${actorProjectId})
          AND j.status IN ('claimed','provisioning','running','waiting_human')
        ORDER BY j.created_at DESC
        LIMIT 50`,
      query`
        SELECT j.id, j.status, j.project_id, p.name AS project_name,
               j.agent_snapshot_json->>'name' AS role_name,
               j.agent_snapshot_json->>'model' AS model,
               j.created_at
        FROM jobs j
        LEFT JOIN projects p ON p.id = j.project_id
        WHERE j.agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR j.project_id = ${actorProjectId})
          AND j.status IN ('failed','timeout','orphan')
        ORDER BY j.created_at DESC
        LIMIT 50`,
      query`
        SELECT j.id, j.status, j.project_id, p.name AS project_name,
               j.agent_snapshot_json->>'name' AS role_name,
               j.agent_snapshot_json->>'model' AS model,
               j.created_at
        FROM jobs j
        LEFT JOIN projects p ON p.id = j.project_id
        WHERE j.agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR j.project_id = ${actorProjectId})
          AND j.status IN ('succeeded','cancelled')
        ORDER BY j.created_at DESC
        LIMIT 50`,
      query<{ active: number }[]>`
        SELECT COUNT(*) FILTER (WHERE status IN ('queued','claimed','running'))::int AS active
        FROM runtime_image_scans
        WHERE result_json->>'registry_credential_id' = ${id}`,
      query`
        SELECT s.id, s.status, s.runtime_image_version_id, s.created_at
        FROM runtime_image_scans s
        WHERE s.result_json->>'registry_credential_id' = ${id}
          AND s.status IN ('queued','claimed','running')
        ORDER BY s.created_at DESC
        LIMIT 50`,
    ]);
    const counts = jobCount[0] ?? { pending_unclaimed: 0, active_frozen: 0, recoverable: 0, terminal_historical: 0 };
    const item = (job: Record<string, unknown>) => ({
      id: job.id,
      status: job.status,
      project_id: job.project_id,
      project_name: job.project_name,
      role_name: job.role_name,
      model: job.model,
      created_at: job.created_at,
    });
    return {
      credential_id: id,
      role_configs: {
        count: Number(bindingCount[0]?.count ?? 0),
        items: bindings.map((binding) => ({
          role_config_id: binding.role_config_id,
          scope: binding.project_id ? "project" : "global",
          project_id: binding.project_id,
          project_name: binding.project_name,
          role_name: binding.role_name,
          purpose: binding.purpose,
        })),
      },
      jobs: {
        pending_unclaimed: { count: Number(counts.pending_unclaimed ?? 0), items: pendingJobs.map(item) },
        active_frozen: { count: Number(counts.active_frozen ?? 0), items: activeJobs.map(item) },
        recoverable: { count: Number(counts.recoverable ?? 0), items: recoverableJobs.map(item) },
        terminal_historical: { count: Number(counts.terminal_historical ?? 0), items: terminalJobs.map(item) },
      },
      scans: {
        active: {
          count: Number(scanCount[0]?.active ?? 0),
          items: activeScans.map((scan) => ({
            id: scan.id,
            status: scan.status,
            runtime_image_version_id: scan.runtime_image_version_id,
            created_at: scan.created_at,
          })),
        },
      },
    };
  }

  app.get("/credentials", async (req, reply) => {
    const actorProjectId = req.actor?.projectId ?? null;
    try {
      const [rows, activeRows] = await Promise.all([
        sql`
          SELECT ${CRED_SAFE} FROM credentials
          WHERE (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})
          ORDER BY created_at DESC`,
        queryActiveDispatchRows(sql, { projectId: actorProjectId }),
      ]);
      const counts = accumulateDispatchCounts(activeRows);
      const bindingCounts: Array<{ credential_id: string; count: number }> = [];
      const bindingCountByCredential = new Map(bindingCounts.map((row) => [String(row.credential_id), Number(row.count)]));
      return rows.map((row) => {
        const id = String(row.id);
        return credentialView(row as Record<string, unknown>, {
          bound_role_config_count: bindingCountByCredential.get(id) ?? 0,
          active_concurrency: activeConcurrencyForCredential(id, row.public_metadata_json, counts),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[credentials] list failed:", message);
      // Common local/dev failure: Scheduler code expects current schema columns before migrate.
      if (/settings_config_json|agent_cli|meta_json|column .* does not exist/i.test(message)) {
        return reply.code(500).send({
          error: "数据库 schema 缺少 credentials.settings_config_json。请用 database/schema.sql 重建数据库后重启 Scheduler",
          error_code: "SCHEMA_DRIFT",
        });
      }
      return reply.code(500).send({ error: message, error_code: "CREDENTIALS_LIST_FAILED" });
    }
  });

  app.get("/credentials/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [row] = await sql`
      SELECT ${CRED_SAFE} FROM credentials
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})`;
    if (!row) return reply.code(404).send({ error: "credential not found" });
    const [impact, activeRows] = await Promise.all([
      credentialImpact(sql, id, actorProjectId),
      queryActiveDispatchRows(sql, { projectId: actorProjectId }),
    ]);
    const counts = accumulateDispatchCounts(activeRows);
    return credentialView(row as Record<string, unknown>, {
      bound_role_config_count: (impact.role_configs as { count: number }).count,
      impact,
      active_concurrency: activeConcurrencyForCredential(id, row.public_metadata_json, counts),
    });
  });

  app.get("/credentials/:id/impact", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [row] = await sql`
      SELECT id FROM credentials
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})`;
    if (!row) return reply.code(404).send({ error: "credential not found" });
    return credentialImpact(sql, id, actorProjectId);
  });



  function normalizeCredentialMeta(raw: Record<string, unknown>, kind: string, provider: string): Record<string, unknown> {
    const metadata = sanitizeCredentialMetadata(raw, { kind, provider, mode: "reject" });
    if (Object.prototype.hasOwnProperty.call(metadata, "base_url") && !providerSupportsBaseUrl(kind, provider)) {
      throw new Error("Provider catalog disallows base_url for this provider");
    }
    return metadata;
  }

  function credentialMutableToActor(projectId: unknown, actorProjectId: string | null): boolean {
    return !actorProjectId || (projectId !== null && projectId !== undefined && String(projectId) === actorProjectId);
  }

  app.post("/credentials", async (req, reply) => {
    // #707: 显式 null 不走 Zod invalid_payload，返回 CREDENTIAL_CLI_REQUIRED。
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)
      && Object.prototype.hasOwnProperty.call(req.body, "agent_cli")
      && (req.body as { agent_cli?: unknown }).agent_cli === null) {
      return reply.code(400).send({ error: "Credential.agent_cli 不能为空", error_code: "CREDENTIAL_CLI_REQUIRED" });
    }
    const body = CredentialBody.parse(req.body);
    if (containsSecretMask(body.secret) || (body.settings_config && containsSecretMask(body.settings_config))) {
      return reply.code(400).send({ error: `创建 Credential 不接受 ${MASKED_SECRET_PLACEHOLDER} 作为密钥` });
    }
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && body.project_id && body.project_id !== actorProjectId) {
      return reply.code(403).send({ error: "project-scoped actors must create credentials in their own project", error_code: "PROJECT_MISMATCH" });
    }
    const effectiveProjectId = actorProjectId ?? body.project_id ?? null;
    if (!isProviderAllowedForKind(body.kind, body.provider) || (body.kind !== "oci_registry" && !isProviderKnown(body.provider))) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    // #707 / #658: llm_provider 必须独占绑定 agent_cli，缺省 fail-closed。
    if (body.kind === "llm_provider" && !body.agent_cli) {
      return reply.code(400).send({ error: "llm_provider Credential 必须指定 agent_cli", error_code: "CREDENTIAL_CLI_REQUIRED" });
    }
    if (body.kind === "llm_provider" && body.agent_cli) {
      const compatibilityError = validateCredentialCompatibility(body.agent_cli, body.provider);
      if (compatibilityError) return reply.code(400).send({ error: "provider 与 agent_cli 不兼容", error_code: "CREDENTIAL_CLI_INCOMPATIBLE" });
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = normalizeCredentialMeta(body.metadata, body.kind, body.provider);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "metadata 非法" });
    }
    if (body.kind === "oci_registry") {
      const registry = typeof metadata.registry === "string" ? metadata.registry : "";
      const username = typeof metadata.username === "string" ? metadata.username : "";
      if (!registry || !username || !config.images.isRegistryAllowed(`${registry}/probe`)) {
        return reply.code(400).send({ error: "OCI Registry Credential 必须提供允许列表内的 metadata.registry 与 metadata.username" });
      }
    }
    let enc: Encrypted;
    try {
      enc = encryptSecret(body.secret);
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) });
    }
    if (body.kind !== "llm_provider" && (body.agent_cli || body.settings_config || body.meta)) {
      return reply.code(400).send({ error: "agent_cli/settings_config/meta 仅适用于 llm_provider" });
    }
    let settingsConfig: Record<string, unknown>;
    try {
      settingsConfig = normalizeProviderSettings(body.agent_cli, body.settings_config ?? {}, body.provider);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const metaJson = body.meta ?? {};
    // Keep public_metadata.base_url / models in sync with settingsConfig so health
    // probes and binding gates share one closed loop with the CC Switch profile.
    if (body.kind === "llm_provider") {
      const fromSettings = extractBaseUrlFromSettings(settingsConfig);
      if (fromSettings && typeof metadata.base_url !== "string") metadata.base_url = fromSettings;
    }
    const [row] = await sql`
      INSERT INTO credentials ${sql({
        name: body.name,
        kind: body.kind,
        provider: body.provider,
        project_id: effectiveProjectId,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        auth_tag: enc.auth_tag,
        public_metadata_json: metadata as never,
        fingerprint: fingerprintOf(body.secret),
        last4: last4Of(body.secret),
        created_by: req.actor?.name ?? null,
        agent_cli: body.kind === "llm_provider" ? body.agent_cli! : null,
        settings_config_json: (body.kind === "llm_provider" ? settingsConfig : {}) as never,
        meta_json: (body.kind === "llm_provider" ? metaJson : {}) as never,
      })}
      RETURNING ${CRED_SAFE}`;
    // §7.2 红线：只记指纹/last4/元数据，密文与明文都不进审计
    await audit(req, {
      action: "credential.create",
      resourceType: "credential",
      resourceId: row.id as string,
      projectId: effectiveProjectId,
      after: {
        name: row.name,
        kind: row.kind,
        ...projectCredentialProvider(row.kind, row.provider),
        fingerprint: row.fingerprint,
        last4: row.last4,
      },
    });
    return reply.code(201).send(credentialView(row as Record<string, unknown>));
  });

  // 非敏感字段可改：名称 / 项目归属 / public metadata（如 base_url）；provider 可安全迁移
  // 密钥仍只能走 rotate；kind 创建后不可改
  app.patch("/credentials/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    // #707: 显式 null → CREDENTIAL_CLI_REQUIRED（schema 不再 nullable）。
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)
      && Object.prototype.hasOwnProperty.call(req.body, "agent_cli")
      && (req.body as { agent_cli?: unknown }).agent_cli === null) {
      return reply.code(400).send({ error: "Credential.agent_cli 不能为空", error_code: "CREDENTIAL_CLI_REQUIRED" });
    }
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        provider: z.string().trim().min(1).max(50).optional(),
        project_id: z.string().uuid().nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        agent_cli: AgentCliSchema.optional(),
        settings_config: z.record(z.string(), z.unknown()).optional().superRefine((value, ctx) => {
          try {
            parseContextWindowTokens(value?.context_window_tokens);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ["context_window_tokens"] });
          }
        }),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .refine((b) => b.name !== undefined || b.provider !== undefined || b.project_id !== undefined || b.metadata !== undefined || b.agent_cli !== undefined || b.settings_config !== undefined || b.meta !== undefined, {
        message: "至少提供 name / provider / project_id / metadata / agent_cli / settings_config / meta 之一",
      })
      .parse(req.body);

    const result = await sql.begin(async (tx) => {
      const runtimeFieldsChanged = body.provider !== undefined || body.project_id !== undefined || body.metadata !== undefined
        || body.agent_cli !== undefined || body.settings_config !== undefined || body.meta !== undefined;
      if (runtimeFieldsChanged) {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      }
      const [existing] = await tx`
        SELECT id, name, kind, provider, project_id, public_metadata_json, agent_cli, settings_config_json, meta_json
        FROM credentials WHERE id = ${id} FOR UPDATE`;
      if (!existing) return null;
      if (!credentialMutableToActor(existing.project_id, actorProjectId)) {
        return { scope: true, error: "project-scoped actors may modify only their own project credentials" };
      }
      if (existing.kind !== "llm_provider" && (body.agent_cli !== undefined || body.settings_config !== undefined || body.meta !== undefined)) {
        return { error: "agent_cli/settings_config/meta 仅适用于 llm_provider" };
      }
      const providerChanged = body.provider !== undefined && body.provider !== existing.provider;
      const targetProvider = body.provider ?? String(existing.provider);
      const targetProjectId = body.project_id !== undefined
        ? body.project_id
        : (existing.project_id as string | null) ?? null;
      const submittedSettingsConfig = body.settings_config !== undefined
        ? restoreMaskedSecretValues(existing.settings_config_json, body.settings_config)
        : existing.settings_config_json;
      if (body.settings_config !== undefined && containsSecretMask(submittedSettingsConfig)) {
        return { error: `settings_config 不接受无法恢复的 ${MASKED_SECRET_PLACEHOLDER} 密钥标记` };
      }
      let targetSettingsConfig: Record<string, unknown>;
      try {
        targetSettingsConfig = normalizeProviderSettings(
          body.agent_cli !== undefined ? body.agent_cli : existing.agent_cli,
          submittedSettingsConfig,
          targetProvider,
        );
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const targetAgentCli = body.agent_cli !== undefined
        ? body.agent_cli
        : (existing.agent_cli as string | null) ?? null;
      if (existing.kind === "llm_provider" && targetAgentCli) {
        const compatibilityError = validateCredentialCompatibility(targetAgentCli, targetProvider);
        if (compatibilityError) return { error: compatibilityError, error_code: "CREDENTIAL_CLI_INCOMPATIBLE" };
      }
      if (actorProjectId && targetProjectId !== actorProjectId) {
        return { scope: true, error: "project-scoped actors may keep credentials only in their own project" };
      }
      if (!isProviderAllowedForKind(String(existing.kind), targetProvider)
        || (existing.kind !== "oci_registry" && !isProviderKnown(targetProvider))) {
        return { error: UNKNOWN_PROVIDER_ERROR };
      }
      let targetMetadata: Record<string, unknown>;
      try {
        targetMetadata = body.metadata !== undefined
          ? normalizeCredentialMeta(body.metadata, String(existing.kind), targetProvider)
          : projectCredentialMetadata(String(existing.kind), targetProvider, existing.public_metadata_json);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "metadata 非法" };
      }
      const impact = { role_config_count: 0, pending_job_count: 0 };
      if (providerChanged && existing.kind !== "llm_provider") {
        return { error: "只有 llm_provider Credential 可以迁移 provider" };
      }
      if (runtimeFieldsChanged && existing.kind === "llm_provider") {
        // #707: 改 agent_cli / provider 时，若仍被在跑 Job 引用则拒绝（要求先排空）。
        const agentCliChanging = body.agent_cli !== undefined
          && body.agent_cli !== ((existing.agent_cli as string | null) ?? null);
        const affiliationChanging = providerChanged || agentCliChanging;
        const active = await tx`
          SELECT id FROM jobs
          WHERE status IN ('claimed','provisioning','running')
            AND agent_snapshot_json->>'credential_id' = ${id}
          LIMIT 1`;
        if (affiliationChanging && active.length > 0) {
          return {
            conflict: true,
            error: "Credential 仍被 claimed/provisioning/running Job 引用，不能修改 agent_cli 或 provider；请先排空在跑任务",
            error_code: "CREDENTIAL_IN_USE_BY_RUNNING_JOBS",
          };
        }
        const bindings: Array<Record<string, unknown>> = [];
        const runtimeJobs = await tx`
          SELECT id, status, project_id,
                 COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
                 NULLIF(agent_snapshot_json->>'model', '') AS model
          FROM jobs
          WHERE status IN ('pending','claimed','provisioning','running','waiting_human')
            AND agent_snapshot_json->>'credential_id' = ${id}`;
        const mutationError = validateCredentialRuntimeMutation({
          provider: targetProvider,
          projectId: targetProjectId,
          metadata: targetMetadata,
          settingsConfig: targetSettingsConfig,
          credentialAgentCli: targetAgentCli,
          consumers: [
            ...bindings.map((binding) => ({
              source: `RoleConfig ${String(binding.role_config_id)}`,
              agentCli: String(binding.agent_cli),
              model: typeof binding.model === "string" && binding.model ? binding.model : null,
              projectId: (binding.project_id as string | null) ?? null,
            })),
            ...runtimeJobs.map((job) => ({
              source: `${job.status === "pending" ? "pending" : "活动"} Job ${String(job.id)}`,
              agentCli: String(job.agent_cli),
              model: typeof job.model === "string" && job.model ? job.model : null,
              projectId: (job.project_id as string | null) ?? null,
            })),
          ],
        });
        if (mutationError) return { error: mutationError };
        impact.role_config_count = bindings.length;
      }
      const sets: Record<string, unknown> = {};
      if (body.name !== undefined) sets.name = body.name;
      if (body.provider !== undefined) sets.provider = body.provider;
      if (body.project_id !== undefined) sets.project_id = body.project_id;
      if (body.metadata !== undefined) {
        sets.public_metadata_json = targetMetadata;
      }
      if (body.agent_cli !== undefined) sets.agent_cli = body.agent_cli;
      if (body.settings_config !== undefined) {
        sets.settings_config_json = targetSettingsConfig;
        // Keep probe metadata aligned when settingsConfig is updated.
        const fromSettings = extractBaseUrlFromSettings(targetSettingsConfig);
        if (fromSettings) {
          const nextMeta = body.metadata !== undefined
            ? targetMetadata
            : projectCredentialMetadata(String(existing.kind), targetProvider, existing.public_metadata_json);
          if (typeof nextMeta.base_url !== "string" || !nextMeta.base_url) {
            nextMeta.base_url = fromSettings;
            sets.public_metadata_json = nextMeta;
          }
        }
      }
      if (body.meta !== undefined) sets.meta_json = body.meta;
      if (body.provider !== undefined || body.metadata !== undefined || body.settings_config !== undefined) {
        sets.health_status = "unknown";
        sets.health_error_category = null;
        sets.health_detail = null;
        sets.last_tested_at = null;
        sets.model_catalog_json = [];
        sets.model_catalog_fetched_at = null;
      }
      if (providerChanged) {
        const pending = await tx`
          UPDATE jobs
          SET agent_snapshot_json = jsonb_set(agent_snapshot_json, '{credential_provider}', to_jsonb(${targetProvider}::text), true)
          WHERE status = 'pending' AND agent_snapshot_json->>'credential_id' = ${id}
          RETURNING id`;
        impact.pending_job_count = pending.length;
      }
      const [row] = await tx`
        UPDATE credentials SET ${tx(sets as never)} WHERE id = ${id} RETURNING ${CRED_SAFE}`;
      return {
        row,
        impact,
        before: {
          name: existing.name,
          kind: existing.kind,
          provider: existing.provider,
          project_id: existing.project_id,
          public_metadata_json: existing.public_metadata_json,
        },
      };
    });
    if (!result) return reply.code(404).send({ error: "credential not found" });
    if ("scope" in result && result.scope) return reply.code(403).send({ error: result.error, error_code: "PROJECT_MISMATCH" });
    if ("conflict" in result && result.conflict) {
      return reply.code(409).send({
        error: result.error,
        ...(("error_code" in result && result.error_code) ? { error_code: result.error_code } : {}),
      });
    }
    if ("error" in result) return reply.code(400).send({ error: result.error });
    await audit(req, {
      action: "credential.update",
      resourceType: "credential",
      resourceId: id,
      projectId: (result.row.project_id as string | null) ?? null,
      before: credentialAuditState({
        name: result.before.name,
        provider: result.before.provider,
        kind: result.before.kind,
        projectId: result.before.project_id,
        metadata: result.before.public_metadata_json,
      }),
      after: {
        ...credentialAuditState({
          name: result.row.name,
          provider: result.row.provider,
          kind: result.row.kind,
          projectId: result.row.project_id,
          metadata: result.row.public_metadata_json,
        }),
        impact: result.impact,
      },
    });
    return credentialView(result.row as Record<string, unknown>, { impact: result.impact });
  });

  app.post("/credentials/:id/rotate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const body = z.object({ secret: z.string().min(1).max(4096) }).parse(req.body);
    if (containsSecretMask(body.secret)) {
      return reply.code(400).send({ error: `轮换 Credential 不接受 ${MASKED_SECRET_PLACEHOLDER} 作为密钥` });
    }
    const [existing] = await sql`SELECT id, project_id FROM credentials WHERE id = ${id}`;
    if (!existing) return reply.code(404).send({ error: "credential not found" });
    if (!credentialMutableToActor(existing.project_id, actorProjectId)) {
      return reply.code(403).send({ error: "project-scoped actors may rotate only their own project credentials", error_code: "PROJECT_MISMATCH" });
    }
    let enc: Encrypted;
    try {
      enc = encryptSecret(body.secret);
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) });
    }
    const [row] = await sql`
      UPDATE credentials SET
        ciphertext = ${enc.ciphertext}, nonce = ${enc.nonce}, auth_tag = ${enc.auth_tag},
        fingerprint = ${fingerprintOf(body.secret)}, last4 = ${last4Of(body.secret)},
        rotated_at = now(), status = 'active', key_version = key_version + 1,
        health_status = 'unknown', health_error_category = NULL, health_detail = NULL,
        last_tested_at = NULL, model_catalog_json = '[]'::jsonb,
        model_catalog_fetched_at = NULL
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
      RETURNING ${CRED_SAFE}`;
    if (!row) {
      const [current] = await sql`SELECT id, project_id FROM credentials WHERE id = ${id}`;
      if (current && !credentialMutableToActor(current.project_id, actorProjectId)) {
        return reply.code(403).send({ error: "credential project scope changed during rotation", error_code: "PROJECT_MISMATCH" });
      }
      return reply.code(409).send({ error: "credential changed during rotation; retry", error_code: "CREDENTIAL_CHANGED" });
    }
    await audit(req, {
      action: "credential.rotate",
      resourceType: "credential",
      resourceId: id,
      after: {
        name: row.name,
        kind: row.kind,
        ...projectCredentialProvider(row.kind, row.provider),
        key_version: row.key_version,
        fingerprint: row.fingerprint,
      },
    });
    return credentialView(row as Record<string, unknown>);
  });

  app.post("/credentials/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const body = z.object({ status: z.enum(["active", "disabled", "rotation_required"]) }).parse(req.body);
    const [existing] = await sql`SELECT id, project_id FROM credentials WHERE id = ${id}`;
    if (!existing) return reply.code(404).send({ error: "credential not found" });
    if (!credentialMutableToActor(existing.project_id, actorProjectId)) {
      return reply.code(403).send({ error: "project-scoped actors may change status only for their own project credentials", error_code: "PROJECT_MISMATCH" });
    }
    const [row] = await sql`
      UPDATE credentials SET status = ${body.status}
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
      RETURNING ${CRED_SAFE}`;
    if (!row) {
      const [current] = await sql`SELECT id, project_id FROM credentials WHERE id = ${id}`;
      if (current && !credentialMutableToActor(current.project_id, actorProjectId)) {
        return reply.code(403).send({ error: "credential project scope changed during status update", error_code: "PROJECT_MISMATCH" });
      }
      return reply.code(409).send({ error: "credential changed during status update; retry", error_code: "CREDENTIAL_CHANGED" });
    }
    await audit(req, {
      action: "credential.status",
      resourceType: "credential",
      resourceId: id,
      after: { name: row.name, status: row.status },
    });
    return credentialView(row as Record<string, unknown>);
  });

  app.delete("/credentials/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    // #690: RoleConfig credential bindings removed; no unbind query.

    type DeleteOk = {
      ok: true;
      id: string;
      name: string;
      kind: string;
      provider: string;
      project_id: string | null;
      unbound_role_config_count: number;
      revoked_job_token_count: number;
      impact: Record<string, unknown>;
    };
    type DeleteErr = { ok: false; statusCode: number; body: Record<string, unknown> };

    const result = await sql.begin(async (txRaw): Promise<DeleteOk | DeleteErr> => {
      // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
      const tx = txRaw as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      const [existing] = await tx`
        SELECT id, name, kind, provider, project_id
        FROM credentials WHERE id = ${id} FOR UPDATE`;
      if (!existing) {
        return { ok: false, statusCode: 404, body: { error: "credential not found", error_code: "CREDENTIAL_NOT_FOUND" } };
      }
      if (!credentialMutableToActor(existing.project_id, actorProjectId)) {
        return {
          ok: false,
          statusCode: 403,
          body: {
            error: "project-scoped actors may delete only their own project credentials",
            error_code: "PROJECT_MISMATCH",
          },
        };
      }

      // Serialize with resume: lock every non-terminal Job and active scan that
      // still points at this credential before reading impact on the same tx.
      // SAFETY: 状态清单是 readonly 字面量元组，postgres.js 的 ANY() 需要可变 string[]。
      await tx`
        SELECT id FROM jobs
        WHERE agent_snapshot_json->>'credential_id' = ${id}
          AND status = ANY(${BLOCKING_JOB_STATUSES as unknown as string[]})
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
        FOR UPDATE`;
      // SAFETY: 同上，扫描状态清单同样需要可变 string[]。
      await tx`
        SELECT id FROM runtime_image_scans
        WHERE result_json->>'registry_credential_id' = ${id}
          AND status = ANY(${ACTIVE_SCAN_STATUSES as unknown as string[]})
        FOR UPDATE`;

      const impact = await credentialImpact(tx, id, actorProjectId);
      const jobs = impact.jobs as {
        pending_unclaimed: { count: number };
        active_frozen: { count: number };
      };
      const scans = impact.scans as { active: { count: number } };
      const pendingCount = Number(jobs.pending_unclaimed.count ?? 0);
      const activeCount = Number(jobs.active_frozen.count ?? 0);
      const activeScanCount = Number(scans.active.count ?? 0);
      if (pendingCount > 0 || activeCount > 0) {
        return {
          ok: false,
          statusCode: 409,
          body: {
            error: "credential is still referenced by pending or active jobs",
            error_code: "CREDENTIAL_IN_USE",
            impact,
          },
        };
      }
      if (activeScanCount > 0) {
        return {
          ok: false,
          statusCode: 409,
          body: {
            error: "credential is still referenced by an active image-admission scan",
            error_code: "CREDENTIAL_SCAN_IN_USE",
            impact,
          },
        };
      }

      const revokedTokens = await tx`
        UPDATE job_tokens
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'credential_deleted'
        WHERE credential_id = ${id} AND status = 'active'
        RETURNING id`;
      await tx`DELETE FROM job_tokens WHERE credential_id = ${id}`;
      const [deleted] = await tx`
        DELETE FROM credentials
        WHERE id = ${id}
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
        RETURNING id`;
      if (!deleted) {
        return { ok: false, statusCode: 409, body: { error: "credential changed during delete; retry", error_code: "CREDENTIAL_CHANGED" } };
      }
      return {
        ok: true,
        id: String(existing.id),
        name: String(existing.name),
        kind: String(existing.kind),
        provider: String(existing.provider),
        project_id: existing.project_id ? String(existing.project_id) : null,
        unbound_role_config_count: 0,
        revoked_job_token_count: revokedTokens.length,
        impact,
      };
    });

    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    await audit(req, {
      action: "credential.delete",
      resourceType: "credential",
      resourceId: id,
      projectId: result.project_id,
      after: {
        name: result.name,
        kind: result.kind,
        ...projectCredentialProvider(result.kind, result.provider),
        unbound_role_config_count: result.unbound_role_config_count,
        revoked_job_token_count: result.revoked_job_token_count,
      },
    });
    return {
      ok: true,
      id: result.id,
      unbound_role_config_count: result.unbound_role_config_count,
      revoked_job_token_count: result.revoked_job_token_count,
    };
  });

  // 连接测试：用解密后的凭据对 provider 做一次轻量调用（明文不出进程）
  app.post("/credentials/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [cred] = await sql`
      SELECT * FROM credentials WHERE id = ${id}`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (!credentialMutableToActor(cred.project_id, actorProjectId)) {
      return reply.code(403).send({ error: "project-scoped actors may test only their own project credentials", error_code: "PROJECT_MISMATCH" });
    }
    if (!projectCredentialProvider(cred.kind, cred.provider).provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    const result = await testCredential(cred as never);
    const [updated] = await sql`
      UPDATE credentials SET
        last_tested_at = ${result.fetched_at},
        health_status = ${result.ok ? "ok" : "error"},
        health_error_category = ${result.ok ? null : (result.category ?? "unknown")},
        health_detail = ${result.detail.slice(0, 300)}
      WHERE id = ${id}
        AND key_version = ${cred.key_version}
        AND provider = ${cred.provider}
        AND public_metadata_json = ${sql.json(cred.public_metadata_json as never)}
        AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
      RETURNING id`;
    if (!updated) {
      return reply.code(409).send({ error: "Credential 在测试期间已变更，请重试" });
    }
    await audit(req, {
      action: "credential.test",
      resourceType: "credential",
      resourceId: id,
      result: result.ok ? "ok" : "error",
      after: {
        ok: result.ok,
        // readiness 用 category 区分「账号被拒」与「探测路径不可用」（目录侧 401 → unknown）。
        category: result.ok ? null : (result.category ?? "unknown"),
        probe_path: result.probe_path ?? null,
      },
    });
    return result;
  });

  // Probe an unsaved account without persisting its secret or model catalog.
  app.post("/credentials/models/preview", async (req, reply) => {
    const parsed = CredentialModelsPreviewBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "模型目录预览参数非法" });
    const body = parsed.data;
    if (containsSecretMask(body.secret) || (body.settings_config && containsSecretMask(body.settings_config))) {
      return reply.code(400).send({ error: `模型预览不接受 ${MASKED_SECRET_PLACEHOLDER} 作为密钥` });
    }
    if (!projectCredentialProvider("llm_provider", body.provider).provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    const previewMetadata = { ...body.metadata, ...(body.base_url ? { base_url: body.base_url } : {}) };
    let normalizedMetadata: Record<string, unknown>;
    try {
      normalizedMetadata = sanitizeCredentialMetadata(previewMetadata, { kind: "llm_provider", provider: body.provider, mode: "reject" });
    } catch {
      return reply.code(400).send({ error: "Credential metadata 非法" });
    }
    try {
      const result = await listCredentialModelsPreview({
        provider: body.provider,
        kind: "llm_provider",
        public_metadata_json: normalizedMetadata,
        settings_config_json: body.settings_config ?? {},
      }, body.secret);
      if (!result.available && result.category === "configuration") {
        return reply.code(400).send({ error: (result.detail ?? "模型目录预览参数非法").slice(0, 300), error_category: result.category });
      }
      if (!result.available) {
        console.warn(`[credentials] model catalog preview failed (${result.category ?? "unknown"}): ${result.detail ?? ""}`);
      }
      return {
        models: result.available ? result.models : [],
        model_descriptors: result.available
          ? resolveModelDescriptorCatalog({
              provider: body.provider,
              catalogJson: result.models,
              catalogRevision: result.fetched_at ?? `preview:${body.provider}`,
            })
          : [],
        catalog_revision: result.fetched_at ?? null,
        state: result.available ? "verified" : "probe_failed",
        source_url: result.source_url,
        fetched_at: result.available ? result.fetched_at : null,
      };
    } catch (error) {
      const validCategories = new Set<CredentialHealthErrorCategory>([
        "configuration", "authentication", "authorization", "rate_limited", "timeout",
        "network", "upstream", "invalid_response", "unknown",
      ]);
      const categoryCandidate = error instanceof CredentialProbeError ? error.category : "unknown";
      const category = validCategories.has(categoryCandidate) ? categoryCandidate : "unknown";
      const message = error instanceof CredentialProbeError ? error.message.slice(0, 300) : "模型目录获取失败";
      if (category === "configuration") return reply.code(400).send({ error: message, error_category: category });
      console.warn(`[credentials] model catalog preview failed (${category}): ${message}`);
      return { models: [], source_url: undefined, fetched_at: null };
    }
  });

  // Persisted model catalog read (no Provider call, no secret material).
  app.get("/credentials/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [cred] = await sql`
      SELECT id, project_id, kind, provider, public_metadata_json, model_catalog_json, model_catalog_fetched_at,
             health_status, health_error_category, health_detail, last_tested_at
      FROM credentials
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (cred.kind !== "llm_provider") return reply.code(400).send({ error: "该 Credential 不是 LLM Provider" });
    const providerProjection = projectCredentialProvider(cred.kind, cred.provider);
    if (!providerProjection.provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    const connectionHealth = cred.health_status === "ok" || cred.health_status === "error" ? cred.health_status : "unknown";
    const catalogHealth =
      connectionHealth === "ok" ? "verified"
        : connectionHealth === "error" ? "probe_failed"
          : cred.model_catalog_fetched_at ? "stale"
            : "unsupported";
    const models = normalizeModelCatalog(cred.model_catalog_json);
    const catalogRevision = typeof cred.model_catalog_fetched_at === "string"
      ? cred.model_catalog_fetched_at
      : `credential:${id}`;
    const modelDescriptors = resolveModelDescriptorCatalog({
      provider: String(cred.provider),
      catalogJson: cred.model_catalog_json,
      catalogRevision,
      healthStatus: catalogHealth,
    });
    return {
      credential_id: id,
      ...providerProjection,
      models,
      model_descriptors: modelDescriptors,
      catalog_revision: cred.model_catalog_fetched_at ?? null,
      /** Catalog-level ModelCatalogHealthStatus (not credential connection ok/error). */
      catalog_health_status: catalogHealth,
      state: catalogHealth,
      fetched_at: cred.model_catalog_fetched_at ?? null,
      connection_health: {
        status: connectionHealth,
        last_tested_at: cred.last_tested_at ?? null,
        error_category: typeof cred.health_error_category === "string" ? cred.health_error_category : null,
        detail: safeHealthDetail(cred.health_detail),
      },
    };
  });

  // Server-owned compatibility projection for model selectors.  The actual
  // RoleConfig write path still calls the same shared validator under lock.
  app.get("/credentials/:id/compatibility", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const queryResult = z.object({
      agent_cli: AgentCliWriteSchema.default("claude-code"),
      model: z.string().trim().min(1).max(200).optional(),
    }).safeParse(req.query);
    if (!queryResult.success) return reply.code(400).send({ error: "兼容性查询参数非法" });
    const query = queryResult.data;
    const [cred] = await sql`
      SELECT id, project_id, kind, provider, public_metadata_json,
             agent_cli, settings_config_json
      FROM credentials
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (cred.kind !== "llm_provider") return reply.code(400).send({ error: "该 Credential 不是 LLM Provider" });
    const providerProjection = projectCredentialProvider(cred.kind, cred.provider);
    if (!providerProjection.provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    const agentCli = query.agent_cli;
    const requestedModel = resolveRequestedModel({
      roleModel: query.model ?? null,
      agentCli,
      settingsConfig: cred.settings_config_json,
    });
    const model = resolveEffectiveModel({
      roleModel: query.model ?? null,
      agentCli,
      settingsConfig: cred.settings_config_json,
    });
    const compatibilityError = validateCredentialCompatibility(agentCli, String(cred.provider));
    const exclusiveError = validateCredentialAgentCliExclusive(
      agentCli,
      typeof cred.agent_cli === "string" ? cred.agent_cli : null,
    );
    const error = compatibilityError ?? exclusiveError;
    return {
      credential_id: id,
      ...providerProjection,
      agent_cli: agentCli,
      model: requestedModel,
      upstream_model: model,
      model_source: query.model ? "role_override" : model ? "credential_settings" : "none",
      compatible: !error,
      error,
      warning: null,
    };
  });

  app.post("/credentials/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [cred] = await sql`SELECT * FROM credentials WHERE id = ${id}`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (!credentialMutableToActor(cred.project_id, actorProjectId)) {
      return reply.code(403).send({ error: "project-scoped actors may refresh only their own project credentials", error_code: "PROJECT_MISMATCH" });
    }
    if (cred.kind !== "llm_provider") return reply.code(400).send({ error: "该 Credential 不是 LLM Provider" });
    if (!projectCredentialProvider(cred.kind, cred.provider).provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    try {
      const result = await discoverModelCatalog(cred as never);
      const available = result.available;
      const models = available ? normalizeModelCatalog(result.models) : [];
      const modelDescriptors = resolveModelDescriptorCatalog({
        provider: String(cred.provider),
        catalogJson: models,
        catalogRevision: result.fetched_at ?? `probe:${String(cred.provider)}`,
        healthStatus: available ? "verified" : "probe_failed",
      });
      const fetchedAt = available ? result.fetched_at : null;
      const testedAt = fetchedAt ?? new Date().toISOString();
      const category = available ? null : (result.category ?? "unknown");
      const detail = available
        ? `模型目录获取成功（${models.length} 个）`
        : (result.detail ?? "模型目录获取失败").slice(0, 300);
      if (!available) {
        console.warn(`[credentials] model catalog probe failed (${category}): ${detail}`);
      }
      const [updated] = await sql`
        UPDATE credentials SET
          last_tested_at = ${testedAt},
          health_status = ${available ? "ok" : "error"},
          health_error_category = ${category},
          health_detail = ${detail},
          model_catalog_json = ${sql.json(models as never)},
          model_catalog_fetched_at = ${fetchedAt}
        WHERE id = ${id}
          AND key_version = ${cred.key_version}
          AND provider = ${cred.provider}
          AND public_metadata_json = ${sql.json(cred.public_metadata_json as never)}
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
        RETURNING id`;
      if (!updated) return reply.code(409).send({ error: "Credential 在模型发现期间已变更，请重试" });
      await audit(req, {
        action: "credential.models_discover",
        resourceType: "credential",
        resourceId: id,
        result: available ? "ok" : "error",
        ...(available ? { after: { model_count: models.length } } : { errorCode: "MODEL_DISCOVERY_FAILED" }),
      });
      return {
        models,
        model_descriptors: modelDescriptors,
        catalog_revision: result.fetched_at ?? modelDescriptors[0]?.catalog_revision ?? null,
        state: available ? "verified" : "probe_failed",
        source_url: result.source_url,
        fetched_at: fetchedAt,
      };
    } catch (error) {
      const validCategories = new Set<CredentialHealthErrorCategory>([
        "configuration", "authentication", "authorization", "rate_limited", "timeout",
        "network", "upstream", "invalid_response", "unknown",
      ]);
      const categoryCandidate = error instanceof CredentialProbeError ? error.category : "unknown";
      const category = validCategories.has(categoryCandidate) ? categoryCandidate : "unknown";
      const message = error instanceof CredentialProbeError ? error.message.slice(0, 300) : "模型目录获取失败";
      console.warn(`[credentials] model catalog probe failed (${category}): ${message}`);
      const [updated] = await sql`
        UPDATE credentials SET
          last_tested_at = now(), health_status = 'error',
          health_error_category = ${category as CredentialHealthErrorCategory},
          health_detail = ${message},
          model_catalog_json = '[]'::jsonb,
          model_catalog_fetched_at = NULL
        WHERE id = ${id}
          AND key_version = ${cred.key_version}
          AND provider = ${cred.provider}
          AND public_metadata_json = ${sql.json(cred.public_metadata_json as never)}
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
        RETURNING id`;
      if (!updated) return reply.code(409).send({ error: "Credential 在模型发现期间已变更，请重试" });
      await audit(req, {
        action: "credential.models_discover",
        resourceType: "credential",
        resourceId: id,
        result: "error",
        errorCode: "MODEL_DISCOVERY_FAILED",
      });
      if (category === "configuration") {
        return reply.code(400).send({ error: message, error_category: category, models: [], fetched_at: null });
      }
      return { models: [], fetched_at: null };
    }
  });
}
