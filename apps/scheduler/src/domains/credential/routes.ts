import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  PlatformToolName,
  allowedPlatformTools,
  CredentialBatchBindingImpact,
  CredentialBatchBindingErrorCode,
  CredentialBatchBindingRepairAction,
  CredentialBatchBindingRequest,
  parseModuleSelector,
  requiredPlatformTools,
} from "@deepsonar/shared-types";
import { z } from "zod";
import { audit, credentialAuditState } from "../../audit.js";
import { config } from "../../config.js";
import {
  allowedModelIds,
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
  validateCredentialCompatibility,
  validateCredentialRuntimeMutation,
  type Encrypted,
} from "../../credentials.js";
import { CredentialProbeError, listCredentialModels, listCredentialModelsPreview, testCredential } from "../../credential-test.js";
import { extractBaseUrlFromSettings, normalizeProviderSettings, resolveEffectiveModel } from "../../provider-settings.js";
import {
  DISPATCH_CLAIM_ADVISORY_KEY,
  PLATFORM_DEFAULT_AGENT_CLI,
  PLATFORM_DEFAULT_AGENT_MODEL,
} from "../../core.js";
import { sql } from "../../db.js";
import {
  containsSecretMask,
  MASKED_SECRET_PLACEHOLDER,
  redactSecretProjection,
  restoreMaskedSecretValues,
} from "../../credential-secret-projection.js";

export function registerCredentialRoutes(app: FastifyInstance): void {
  // ---------- Provider Credential（§6.2/§6.4：加密存储，与 API Token 严格分离） ----------
  // 列表/详情永不返回密文；明文只在创建/轮换请求体里进、运行时解密用
  const CRED_SAFE = sql`id, name, kind, provider, project_id, key_version, public_metadata_json,
                        fingerprint, last4, status, last_used_at, rotated_at,
                        last_tested_at, health_status, health_error_category,
                        health_detail, model_catalog_json, model_catalog_fetched_at,
                        agent_cli, settings_config_json, meta_json,
                        created_at, created_by`;

  const AgentCliSchema = z.enum(["claude-code", "codex", "open-code", "pi"]);
  const CredentialBody = z.object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["llm_provider", "plane", "git", "oci_registry"]).default("llm_provider"),
    provider: z.string().trim().min(1).max(50),
    secret: z.string().min(1).max(4096),
    project_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** CC Switch agent_cli column for this profile (llm_provider only). */
    agent_cli: AgentCliSchema.nullable().optional(),
    /** Full CLI settingsConfig (may include plaintext keys); empty = legacy env path. */
    settings_config: z.record(z.string(), z.unknown()).optional(),
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
      agent_cli: row.agent_cli ?? null,
      settings_config_json: redactSecretProjection(settingsConfig),
      meta_json: metaJson,
      scope: row.project_id ? "project" : "global",
      health: {
        status: healthStatus,
        last_tested_at: row.last_tested_at ?? null,
        error_category: healthErrorCategory,
        detail: healthDetail,
        model_catalog: modelCatalog,
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

  async function credentialImpact(id: string, actorProjectId: string | null = null): Promise<Record<string, unknown>> {
    const [bindingCount, bindings, jobCount, pendingJobs, activeJobs, terminalJobs] = await Promise.all([
      sql<{ count: number }[]>`
        SELECT COUNT(DISTINCT rc2.role_config_id)::int AS count
        FROM role_credentials rc2
        JOIN role_configs rc ON rc.id = rc2.role_config_id
        WHERE rc2.credential_id = ${id}
          AND (${actorProjectId}::uuid IS NULL OR rc.project_id IS NULL OR rc.project_id = ${actorProjectId})`,
      sql`
        SELECT DISTINCT rc.id AS role_config_id, rc.project_id, rc2.purpose,
               ar.name AS role_name, p.name AS project_name
        FROM role_credentials rc2
        JOIN role_configs rc ON rc.id = rc2.role_config_id
        JOIN agent_roles ar ON ar.id = rc.role_id
        LEFT JOIN projects p ON p.id = rc.project_id
        WHERE rc2.credential_id = ${id}
          AND (${actorProjectId}::uuid IS NULL OR rc.project_id IS NULL OR rc.project_id = ${actorProjectId})
        ORDER BY rc.project_id NULLS FIRST, ar.name
        LIMIT 50`,
      sql<{ pending_unclaimed: number; active_frozen: number; terminal_historical: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_unclaimed,
          COUNT(*) FILTER (WHERE status IN ('claimed','provisioning','running','waiting_human'))::int AS active_frozen,
          COUNT(*) FILTER (WHERE status NOT IN ('pending','claimed','provisioning','running','waiting_human'))::int AS terminal_historical
        FROM jobs
        WHERE agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})`,
      sql`
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
      sql`
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
      sql`
        SELECT j.id, j.status, j.project_id, p.name AS project_name,
               j.agent_snapshot_json->>'name' AS role_name,
               j.agent_snapshot_json->>'model' AS model,
               j.created_at
        FROM jobs j
        LEFT JOIN projects p ON p.id = j.project_id
        WHERE j.agent_snapshot_json->>'credential_id' = ${id}
          AND (${actorProjectId}::uuid IS NULL OR j.project_id = ${actorProjectId})
          AND j.status NOT IN ('pending','claimed','provisioning','running','waiting_human')
        ORDER BY j.created_at DESC
        LIMIT 50`,
    ]);
    const counts = jobCount[0] ?? { pending_unclaimed: 0, active_frozen: 0, terminal_historical: 0 };
    const item = (job: Record<string, unknown>) => ({
      id: job.id,
      status: job.status,
      project_id: job.project_id,
      project_name: job.project_name,
      role_name: job.role_name,
      model: job.model,
      created_at: job.created_at,
    });
    const pending = pendingJobs.map(item);
    const active = activeJobs.map(item);
    const terminal = terminalJobs.map(item);
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
        pending_unclaimed: { count: Number(counts.pending_unclaimed ?? 0), items: pending },
        active_frozen: { count: Number(counts.active_frozen ?? 0), items: active },
        terminal_historical: { count: Number(counts.terminal_historical ?? 0), items: terminal },
      },
    };
  }

  app.get("/credentials", async (req, reply) => {
    const actorProjectId = req.actor?.projectId ?? null;
    try {
      const [rows, usage] = await Promise.all([
        sql`
          SELECT ${CRED_SAFE} FROM credentials
          WHERE (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})
          ORDER BY created_at DESC`,
        sql`SELECT agent_snapshot_json->>'credential_id' AS credential_id,
                   agent_snapshot_json->>'model' AS model,
                   COUNT(*)::int AS count
            FROM jobs
            WHERE status IN ('claimed','provisioning','running')
              AND (${actorProjectId}::uuid IS NULL OR project_id = ${actorProjectId})
              AND agent_snapshot_json->>'credential_id' IS NOT NULL
            GROUP BY 1, 2`,
      ]);
      const bindingCounts = await sql<{ credential_id: string; count: number }[]>`
        SELECT rc2.credential_id, COUNT(DISTINCT rc2.role_config_id)::int AS count
        FROM role_credentials rc2
        JOIN role_configs rc ON rc.id = rc2.role_config_id
        WHERE (${actorProjectId}::uuid IS NULL OR rc.project_id IS NULL OR rc.project_id = ${actorProjectId})
        GROUP BY rc2.credential_id`;
      const bindingCountByCredential = new Map(bindingCounts.map((row) => [String(row.credential_id), Number(row.count)]));
      return rows.map((row) => {
        const own = usage.filter((item) => item.credential_id === row.id);
        return credentialView(row as Record<string, unknown>, {
          bound_role_config_count: bindingCountByCredential.get(String(row.id)) ?? 0,
          active_count: own.reduce((total, item) => total + Number(item.count), 0),
          active_by_model: Object.fromEntries(own.filter((item) => item.model).map((item) => [String(item.model), Number(item.count)])),
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
    const impact = await credentialImpact(id, actorProjectId);
    return credentialView(row as Record<string, unknown>, {
      bound_role_config_count: (impact.role_configs as { count: number }).count,
      impact,
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
    return credentialImpact(id, actorProjectId);
  });

  /**
   * Bind or migrate one Provider account to many global/project RoleConfigs.
   * The complete operation is serialized with dispatcher claim and committed
   * as one transaction. Running/frozen Jobs are never mutated; callers may
   * explicitly choose to refresh pending snapshots only.
   */
  app.post("/credentials/batch-bind", async (req, reply) => {
    const parsed = CredentialBatchBindingRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error_code: "BATCH_REQUEST_INVALID",
        error: "invalid batch credential binding request",
        field: parsed.error.issues[0]?.path.join(".") || "body",
      });
    }
    const body = parsed.data;
    if (body.mode === "bind" && body.source_credential_id) {
      return reply.code(400).send({
        error_code: "BATCH_REQUEST_INVALID",
        error: "source_credential_id is only valid for migration",
        field: "source_credential_id",
      });
    }
    const actorProjectId = req.actor?.projectId ?? null;
    const roleConfigIds = [...new Set(body.role_config_ids)].sort();
    const credentialIds = [body.credential_id, ...(body.source_credential_id ? [body.source_credential_id] : [])].sort();
    const sourceCredentialId = body.mode === "migrate" ? body.source_credential_id ?? null : null;
    const actorKey = `${req.actor?.type ?? "anonymous"}:${req.actor?.id ?? req.actor?.name ?? "anonymous"}`;
    const idempotencyRequestId = `credential-batch:${actorKey}:${body.idempotency_key}`;
    const idempotencyPayload = {
      credential_id: body.credential_id,
      role_config_ids: roleConfigIds,
      mode: body.mode,
      source_credential_id: body.source_credential_id ?? null,
      model: body.model ?? null,
      effect: body.effect,
    };
    const idempotencyPayloadSha256 = createHash("sha256")
      .update(JSON.stringify(idempotencyPayload), "utf8")
      .digest("hex");

    type BindingErrorCode = z.infer<typeof CredentialBatchBindingErrorCode>;
    type BatchFailure = {
      ok: false;
      statusCode: number;
      body: {
        error_code: BindingErrorCode;
        error: string;
        field?: string;
        repair?: { action: z.infer<typeof CredentialBatchBindingRepairAction>; credential_id: string; role_config_id?: string };
      };
    };
    const gateFailure = (
      statusCode: number,
      error_code: BindingErrorCode,
      error: string,
      credentialId: string,
      action?: z.infer<typeof CredentialBatchBindingRepairAction>,
      roleConfigId?: string,
      field?: string,
    ): BatchFailure => ({
      ok: false,
      statusCode,
      body: {
        error_code,
        error,
        ...(field ? { field } : {}),
        ...(action ? { repair: { action, credential_id: credentialId, ...(roleConfigId ? { role_config_id: roleConfigId } : {}) } } : {}),
      },
    });
    type BatchSuccess = {
      ok: true;
      impact: Record<string, unknown>;
      audit: { projectIds: string[]; targetName: string; sourceId: string | null };
    };
    let result: BatchFailure | BatchSuccess;
    try {
      result = await sql.begin(async (txRaw): Promise<BatchFailure | BatchSuccess> => {
      const tx = txRaw as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;

      const [prior] = await tx`
        SELECT action, after_json
        FROM audit_logs
        WHERE request_id = ${idempotencyRequestId}
          AND action IN ('credential.batch_bind', 'credential.batch_migrate')
        ORDER BY id DESC
        LIMIT 1`;
      if (prior) {
        const priorAfter = prior.after_json && typeof prior.after_json === "object"
          ? prior.after_json as Record<string, unknown>
          : {};
        if (priorAfter.idempotency_payload_sha256 !== idempotencyPayloadSha256) {
          return {
            ok: false,
            statusCode: 409,
            body: {
              error_code: "IDEMPOTENCY_KEY_REUSED",
              error: "idempotency_key was already used with a different binding payload",
              field: "idempotency_key",
            },
          };
        }
        const replay = CredentialBatchBindingImpact.safeParse(priorAfter.impact);
        if (!replay.success) {
          return {
            ok: false,
            statusCode: 500,
            body: { error_code: "BATCH_TRANSACTION_FAILED", error: "stored idempotency result is invalid" },
          };
        }
        return {
          ok: true,
          impact: replay.data,
          audit: { projectIds: [], targetName: "", sourceId: replay.data.source_credential_id },
        };
      }

      const credentials = await tx`
        SELECT id, name, kind, provider, project_id, status, public_metadata_json,
               health_status, last_tested_at, model_catalog_json, model_catalog_fetched_at,
               agent_cli, settings_config_json
        FROM credentials
        WHERE id = ANY(${credentialIds}::uuid[])
        ORDER BY id
        FOR UPDATE`;
      const target = credentials.find((credential) => String(credential.id) === body.credential_id);
      if (!target) return gateFailure(404, "CREDENTIAL_NOT_FOUND", "target credential not found", body.credential_id, undefined, undefined, "credential_id");
      if (actorProjectId && target.project_id && String(target.project_id) !== actorProjectId) {
        return gateFailure(403, "PROJECT_SCOPE_FORBIDDEN", "target credential belongs to another project", body.credential_id, "choose_project_credential");
      }
      if (String(target.kind) !== "llm_provider") {
        return gateFailure(400, "CREDENTIAL_KIND_INVALID", "batch binding requires an LLM Provider credential", body.credential_id, undefined, undefined, "credential_id");
      }
      const targetProjection = projectCredentialProvider(target.kind, target.provider);
      if (!targetProjection.provider_valid || !isProviderKnown(String(target.provider))) {
        return gateFailure(400, "CREDENTIAL_PROVIDER_INVALID", UNKNOWN_PROVIDER_ERROR, body.credential_id, "repair_provider");
      }
      if (String(target.status) !== "active") {
        return gateFailure(409, "CREDENTIAL_NOT_ACTIVE", "Target credential must be active before binding. Activate it, then test the connection again.", body.credential_id, "activate_credential");
      }
      if (String(target.health_status) !== "ok" || !target.last_tested_at) {
        return gateFailure(409, "CREDENTIAL_HEALTH_REQUIRED", "A successful latest connection test is required before binding. Test the connection and retry.", body.credential_id, "test_connection");
      }
      // Model catalog is optional reference (CC Switch style). Binding keeps each
      // RoleConfig's own model; only health + CLI compatibility are hard gates.
      // Explicit allowlist (if set) still constrains models.
      const source = body.source_credential_id
        ? credentials.find((credential) => String(credential.id) === body.source_credential_id)
        : undefined;
      if (body.mode === "migrate" && !source) {
        return gateFailure(404, "CREDENTIAL_NOT_FOUND", "source credential not found", body.source_credential_id ?? body.credential_id, undefined, undefined, "source_credential_id");
      }
      if (source && actorProjectId && source.project_id && String(source.project_id) !== actorProjectId) {
        return gateFailure(403, "PROJECT_SCOPE_FORBIDDEN", "source credential belongs to another project", String(source.id), "choose_project_credential");
      }
      if (source?.project_id && target.project_id && String(source.project_id) !== String(target.project_id)) {
        return gateFailure(403, "PROJECT_SCOPE_FORBIDDEN", "source and target project credentials must belong to the same project", String(source.id), "choose_project_credential");
      }

      const configs = await tx`
        SELECT rc.id, rc.role_id, rc.project_id, rc.agent_cli, rc.model, rc.version,
               ar.name AS role_name
        FROM role_configs rc
        JOIN agent_roles ar ON ar.id = rc.role_id
        WHERE rc.id = ANY(${roleConfigIds}::uuid[])
        ORDER BY rc.id
        FOR UPDATE OF rc`;
      if (configs.length !== roleConfigIds.length) {
        return gateFailure(404, "ROLE_CONFIG_NOT_FOUND", "one or more RoleConfigs were not found", body.credential_id, "choose_project_role_config");
      }
      if (actorProjectId && configs.some((config) => String(config.project_id ?? "") !== actorProjectId)) {
        const offending = configs.find((config) => String(config.project_id ?? "") !== actorProjectId);
        return gateFailure(403, "PROJECT_SCOPE_FORBIDDEN", "project-scoped actors may bind only their own project RoleConfigs", body.credential_id, "choose_project_role_config", offending ? String(offending.id) : undefined);
      }
      if (String(target.project_id ?? "") && configs.some((config) => String(config.project_id ?? "") !== String(target.project_id))) {
        const offending = configs.find((config) => String(config.project_id ?? "") !== String(target.project_id));
        return gateFailure(403, "PROJECT_SCOPE_FORBIDDEN", "project credential can only bind RoleConfigs in the same project", body.credential_id, "choose_project_role_config", offending ? String(offending.id) : undefined);
      }

      const existingBindings = await tx`
        SELECT rc.role_config_id, rc.credential_id, rc.purpose
        FROM role_credentials rc
        WHERE rc.role_config_id = ANY(${roleConfigIds}::uuid[])
        ORDER BY rc.role_config_id, rc.purpose, rc.credential_id`;
      const llmByConfig = new Map<string, string>();
      for (const binding of existingBindings) {
        if (binding.purpose === "llm") llmByConfig.set(String(binding.role_config_id), String(binding.credential_id));
      }

      const normalizedModel = body.model === undefined ? undefined : body.model?.trim() || null;
      const effectiveModelByConfig = new Map<string, string | null>();
      for (const configRow of configs) {
        const configId = String(configRow.id);
        const currentCredentialId = llmByConfig.get(configId) ?? null;
        if (body.mode === "migrate" && currentCredentialId !== body.source_credential_id) {
          return gateFailure(409, "ROLE_CONFIG_SOURCE_MISMATCH", `RoleConfig ${configId} is not bound to the source credential`, body.credential_id, "choose_project_role_config", configId);
        }
        const model = normalizedModel === undefined
          ? (typeof configRow.model === "string" && configRow.model.trim() ? configRow.model.trim() : null)
          : normalizedModel;
        const compatibilityError = validateCredentialCompatibility(String(configRow.agent_cli), String(target.provider));
        if (compatibilityError) {
          return gateFailure(409, "CREDENTIAL_CLI_INCOMPATIBLE", `RoleConfig ${configId}: ${compatibilityError}`, body.credential_id, "choose_model", configId);
        }
        if (target.agent_cli && target.agent_cli !== configRow.agent_cli) {
          return gateFailure(409, "CREDENTIAL_CLI_INCOMPATIBLE", `RoleConfig ${configId}: Credential 配置文件属于 ${target.agent_cli}，不能绑定到 ${configRow.agent_cli}`, body.credential_id, "choose_model", configId);
        }
        const allowed = allowedModelIds(target.public_metadata_json);
        const modelForGate = resolveEffectiveModel({
          roleModel: model,
          agentCli: String(configRow.agent_cli),
          settingsConfig: target.settings_config_json,
        }) ?? PLATFORM_DEFAULT_AGENT_MODEL;
        effectiveModelByConfig.set(configId, modelForGate);
        // Only enforce explicit allowlist. Catalog is not a bind gate.
        if (allowed.length > 0 && !modelForGate) {
          return gateFailure(409, "CREDENTIAL_MODEL_NOT_CURRENT", `RoleConfig ${configId}: Credential 配置文件未声明模型且 RoleConfig 未提供覆盖`, body.credential_id, "choose_model", configId);
        }
        if (allowed.length > 0 && modelForGate && !allowed.includes(modelForGate)) {
          return gateFailure(409, "CREDENTIAL_MODEL_NOT_CURRENT", `RoleConfig ${configId} model ${modelForGate} is not in the credential allowlist`, body.credential_id, "choose_model", configId);
        }
      }

      const refreshedPending: string[] = [];
      for (const configRow of configs) {
        const configId = String(configRow.id);
        const model = normalizedModel === undefined
          ? (typeof configRow.model === "string" && configRow.model.trim() ? configRow.model.trim() : null)
          : normalizedModel;
        const nextVersion = Number(configRow.version ?? 0) + 1;
        await tx`DELETE FROM role_credentials WHERE role_config_id = ${configId} AND purpose = 'llm'`;
        await tx`
          INSERT INTO role_credentials ${tx({ role_config_id: configId, credential_id: body.credential_id, purpose: "llm" })}
          ON CONFLICT DO NOTHING`;
        await tx`
          UPDATE role_configs SET
            model = ${model}, version = ${nextVersion}, updated_at = now()
          WHERE id = ${configId}`;
        if (body.effect === "refresh_pending") {
          const pending = await tx`
            SELECT id FROM jobs
            WHERE status = 'pending'
              AND agent_snapshot_json->>'role_config_id' = ${configId}
              AND (${sourceCredentialId}::uuid IS NULL
                   OR agent_snapshot_json->>'credential_id' = ${sourceCredentialId})
            FOR UPDATE`;
          if (pending.length > 0) {
            await tx`
              UPDATE jobs SET agent_snapshot_json =
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        jsonb_set(agent_snapshot_json, '{credential_id}', to_jsonb(${body.credential_id}::text), true),
                        '{credential_name}', to_jsonb(${String(target.name)}::text), true),
                      '{credential_provider}', to_jsonb(${String(target.provider)}::text), true),
                    '{model}', COALESCE(to_jsonb(${effectiveModelByConfig.get(configId) ?? null}::text), 'null'::jsonb), true),
                  '{role_config_version}', to_jsonb(${nextVersion}::int), true)
              WHERE id = ANY(${pending.map((job) => job.id)}::uuid[])
                AND status = 'pending'`;
            refreshedPending.push(...pending.map((job) => String(job.id)));
          }
        }
      }

      const [stats] = await tx`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_job_count,
          COUNT(*) FILTER (WHERE status IN ('claimed','provisioning','running','waiting_human'))::int AS active_frozen_job_count,
          COUNT(*) FILTER (WHERE status NOT IN ('pending','claimed','provisioning','running','waiting_human'))::int AS terminal_historical_job_count
        FROM jobs
        WHERE agent_snapshot_json->>'role_config_id' = ANY(${roleConfigIds}::text[])`;
      const impact = {
        mode: body.mode,
        effect: body.effect,
        credential_id: body.credential_id,
        source_credential_id: body.source_credential_id ?? null,
        role_config_count: configs.length,
        pending_job_count: Number(stats?.pending_job_count ?? 0),
        refreshed_pending_job_count: refreshedPending.length,
        active_frozen_job_count: Number(stats?.active_frozen_job_count ?? 0),
        terminal_historical_job_count: Number(stats?.terminal_historical_job_count ?? 0),
        role_configs: configs.map((config) => ({
          role_config_id: config.id,
          role_name: config.role_name,
          scope: config.project_id ? "project" : "global",
          project_id: config.project_id ?? null,
          model: normalizedModel === undefined ? config.model ?? null : normalizedModel,
        })),
      };
      const impactParsed = CredentialBatchBindingImpact.parse(impact);
      const projectIds = [...new Set(configs.map((config) => String(config.project_id ?? "")).filter(Boolean))];
      await tx`
        INSERT INTO audit_logs ${tx({
          actor_type: req.actor?.type ?? "anonymous",
          actor_id: req.actor?.name ?? "anonymous",
          action: body.mode === "migrate" ? "credential.batch_migrate" : "credential.batch_bind",
          project_id: projectIds.length === 1 ? projectIds[0] : null,
          resource_type: "credential",
          resource_id: body.credential_id,
          request_id: idempotencyRequestId,
          ip: req.ip ?? null,
          user_agent: (req.headers["user-agent"] as string)?.slice(0, 300) ?? null,
          after_json: tx.json({ idempotency_payload_sha256: idempotencyPayloadSha256, impact: impactParsed } as never),
          result: "ok",
          error_code: null,
        })}`;
      return {
        ok: true,
        impact: impactParsed,
        audit: { projectIds, targetName: String(target.name), sourceId: body.source_credential_id ?? null },
      };
      });
    } catch (error) {
      req.log.error({ err: error }, "credential batch binding transaction failed");
      return reply.code(500).send({
        error_code: "BATCH_TRANSACTION_FAILED",
        error: "credential batch binding transaction failed",
      });
    }

    if (!result.ok) return reply.code(result.statusCode).send(result.body);
    return CredentialBatchBindingImpact.parse(result.impact);
  });

  /** Persist only the server-owned public metadata projection. */
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
    const settingsConfig = normalizeProviderSettings(body.agent_cli, body.settings_config ?? {});
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
        agent_cli: body.kind === "llm_provider" ? (body.agent_cli ?? null) : null,
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
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        provider: z.string().trim().min(1).max(50).optional(),
        project_id: z.string().uuid().nullable().optional(),
        /** 整体替换 public_metadata_json（非密钥：base_url 等）；传 {} 可清空 */
        metadata: z.record(z.string(), z.unknown()).optional(),
        agent_cli: AgentCliSchema.nullable().optional(),
        settings_config: z.record(z.string(), z.unknown()).optional(),
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
      const targetSettingsConfig = normalizeProviderSettings(
        body.agent_cli !== undefined ? body.agent_cli : existing.agent_cli,
        submittedSettingsConfig,
      );
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
        const active = await tx`
          SELECT id FROM jobs
          WHERE status IN ('claimed','provisioning','running','waiting_human')
            AND agent_snapshot_json->>'credential_id' = ${id}
          LIMIT 1`;
        if (providerChanged && active.length > 0) {
          return { conflict: true, error: "Credential 仍被活动 Job 引用，不能迁移 provider" };
        }
        const bindings = await tx`
          SELECT DISTINCT rc.id AS role_config_id, rc.agent_cli, rc.model, rc.project_id
          FROM role_credentials r
          JOIN role_configs rc ON rc.id = r.role_config_id
          WHERE r.credential_id = ${id} AND r.purpose = 'llm'`;
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
    if ("conflict" in result && result.conflict) return reply.code(409).send({ error: result.error });
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
      after: { ok: result.ok },
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
      return await listCredentialModelsPreview({
        provider: body.provider,
        kind: "llm_provider",
        public_metadata_json: normalizedMetadata,
        settings_config_json: body.settings_config ?? {},
      }, body.secret);
    } catch (error) {
      const validCategories = new Set<CredentialHealthErrorCategory>([
        "configuration", "authentication", "authorization", "rate_limited", "timeout",
        "network", "upstream", "invalid_response", "unknown",
      ]);
      const categoryCandidate = error instanceof CredentialProbeError ? error.category : "unknown";
      const category = validCategories.has(categoryCandidate) ? categoryCandidate : "unknown";
      const message = error instanceof CredentialProbeError ? error.message.slice(0, 300) : "模型目录获取失败";
      return reply.code(502).send({ error: message, error_category: category });
    }
  });

  // Persisted model catalog read (no Provider call, no secret material).
  app.get("/credentials/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const [cred] = await sql`
      SELECT id, project_id, kind, provider, public_metadata_json, model_catalog_json, model_catalog_fetched_at
      FROM credentials
      WHERE id = ${id}
        AND (${actorProjectId}::uuid IS NULL OR project_id IS NULL OR project_id = ${actorProjectId})`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (cred.kind !== "llm_provider") return reply.code(400).send({ error: "该 Credential 不是 LLM Provider" });
    const providerProjection = projectCredentialProvider(cred.kind, cred.provider);
    if (!providerProjection.provider_valid) {
      return reply.code(400).send({ error: UNKNOWN_PROVIDER_ERROR });
    }
    return {
      credential_id: id,
      ...providerProjection,
      models: normalizeModelCatalog(cred.model_catalog_json),
      allowed_model_ids: allowedModelIds(projectCredentialMetadata("llm_provider", String(cred.provider), cred.public_metadata_json)),
      fetched_at: cred.model_catalog_fetched_at ?? null,
    };
  });

  // Server-owned compatibility projection for model selectors.  The actual
  // RoleConfig write path still calls the same shared validator under lock.
  app.get("/credentials/:id/compatibility", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    const queryResult = z.object({
      agent_cli: z.enum(["claude-code", "open-code", "codex", "pi"]).default("claude-code"),
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
    const model = resolveEffectiveModel({
      roleModel: query.model ?? null,
      agentCli,
      settingsConfig: cred.settings_config_json,
    });
    const metadata = projectCredentialMetadata(String(cred.kind), String(cred.provider), cred.public_metadata_json);
    const compatibilityError = validateCredentialCompatibility(agentCli, String(cred.provider));
    const allowed = allowedModelIds(metadata);
    const modelError = model && allowed.length > 0 && !allowed.includes(model)
      ? `模型 ${model} 不在 Credential allowed_model_ids 白名单`
      : !model && allowed.length > 0
        ? "Credential 已启用模型白名单，但配置文件未声明模型且 RoleConfig 未提供覆盖"
        : null;
    const profileCliError = cred.agent_cli && cred.agent_cli !== agentCli
      ? `Credential 配置文件属于 ${cred.agent_cli}，不能绑定到 ${agentCli}`
      : null;
    return {
      credential_id: id,
      ...providerProjection,
      agent_cli: agentCli,
      model,
      allowed_model_ids: allowed,
      model_source: query.model ? "role_override" : model ? "credential_settings" : "none",
      compatible: !compatibilityError && !profileCliError && !modelError,
      error: compatibilityError ?? profileCliError ?? modelError,
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
      const result = await listCredentialModels(cred as never);
      const [updated] = await sql`
        UPDATE credentials SET
          last_tested_at = ${result.fetched_at}, health_status = 'ok',
          health_error_category = NULL,
          health_detail = ${`模型目录获取成功（${result.models.length} 个）`},
          model_catalog_json = ${sql.json(normalizeModelCatalog(result.models) as never)},
          model_catalog_fetched_at = ${result.fetched_at}
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
        result: "ok",
        after: { model_count: result.models.length },
      });
      return result;
    } catch (error) {
      const validCategories = new Set<CredentialHealthErrorCategory>([
        "configuration", "authentication", "authorization", "rate_limited", "timeout",
        "network", "upstream", "invalid_response", "unknown",
      ]);
      const categoryCandidate = error instanceof CredentialProbeError ? error.category : "unknown";
      const category = validCategories.has(categoryCandidate) ? categoryCandidate : "unknown";
      const message = error instanceof CredentialProbeError ? error.message.slice(0, 300) : "模型目录获取失败";
      const [updated] = await sql`
        UPDATE credentials SET
          last_tested_at = now(), health_status = 'error',
          health_error_category = ${category as CredentialHealthErrorCategory},
          health_detail = ${message}
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
      return reply.code(502).send({ error: message, error_category: category });
    }
  });
}
