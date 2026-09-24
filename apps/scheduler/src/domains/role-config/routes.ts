import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentCliWriteSchema, PlatformToolName, allowedPlatformTools, parseModuleSelector, requiredPlatformTools } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { isUuid } from "../../project-scope.js";
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_FILE_MAX_COUNT,
  CONFIG_FILE_MAX_TOTAL,
  DISPATCH_CLAIM_ADVISORY_KEY,
  scanConfigContent,
  rolesForProject,
  validateConfigFilePath,
  validateEnvVars,
} from "../../core.js";
import { sql } from "../../db.js";
import { allocateRoleUiColor } from "../../role-colors.js";
import { parseContextWindowTokens } from "../../provider-settings.js";
import { parseProjectImagePolicy, persistableProjectRoleConfigModel } from "../role-runtime-snapshot/application.js";
import {
  parseSandboxLimitsOverride,
  sandboxLimitsExceedPlatform,
  SANDBOX_LIMITS_EXCEED_PLATFORM,
} from "../role-runtime-snapshot/sandbox-limits.js";
import { parseRuntimeKnobOverride, validateRuntimeKnobOverride } from "../../runtime-knobs.js";
const RoleBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "小写字母开头的标识符"),
  title: z.string().default(""),
  description: z.string().default(""),
});
const RolePatchBody = RoleBody.partial().omit({ name: true });

/** `:roleId` is `agent_roles.id`, never the role name (`explore`). */
export const INVALID_ROLE_ID = {
  error: "roleId must be an agent role UUID, not the role name",
  error_code: "INVALID_ROLE_ID",
} as const;

/** PATCH `/role-configs/:id/...` uses `role_configs.id` from bindable `id`. */
export const INVALID_ROLE_CONFIG_ID = {
  error: "invalid RoleConfig id",
  error_code: "INVALID_ROLE_CONFIG_ID",
} as const;

const INVALID_PROJECT_ID = {
  error: "invalid project id",
  error_code: "INVALID_ID",
} as const;

function rejectUnlessUuid(
  reply: FastifyReply,
  value: string | undefined,
  body: { error: string; error_code: string },
): boolean {
  if (isUuid(value)) return false;
  reply.code(400).send(body);
  return true;
}

export function registerRoleConfigRoutes(app: FastifyInstance): void {
  // ---------- RoleConfig（§4.2：角色即配置；全局缺省 + 项目级覆盖） ----------

  const RoleConfigPutBody = z.object({
    agent_cli: AgentCliWriteSchema.default("claude-code"),
    dsh_task_mode: z.enum(["standard", "ptc"]).default("standard"),
    model: z.string().nullish(),
    /**
     * @deprecated #697 — RoleConfig 不再授权 model catalog passthrough。
     * 写入恒落 false；请用平台 env `DEEPSONAR_ALLOW_MODEL_CATALOG_PASSTHROUGH`
     * 或管理员级项目 Agent allowlist。
     */
    allow_model_catalog_passthrough: z.boolean().optional().default(false),
    context_window_tokens: z.unknown().optional(),
    env_keys: z.array(z.string()).default([]),
    env_vars: z.record(z.string(), z.string()).default({}),
    modules: z.array(z.string()).default([]),
    skills: z.array(z.record(z.string(), z.unknown())).default([]),
    commands: z.array(z.record(z.string(), z.unknown())).default([]),
    mcps: z.array(z.record(z.string(), z.unknown())).default([]),
    subagents: z.array(z.record(z.string(), z.unknown())).default([]),
    platform_tools: z.partialRecord(PlatformToolName, z.boolean()).default({}),
    instructions_markdown: z.string().max(100_000).nullish(),
    runtime_image_key: z.string().nullish(),
    /** Project-only numeric sandbox resource overrides; capability flags stay server-owned. */
    sandbox_limits: z.unknown().optional(),
    runtime_knobs: z.unknown().optional(),
    config_files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  });

  async function validateRoleConfigBody(
    body: z.infer<typeof RoleConfigPutBody>,
    projectId: string | null,
    role: { name: string; kind: "role" | "hub" | "system" },
    db: typeof sql = sql,
  ): Promise<{ error: string | null; error_code?: string }> {
    if (projectId && body.runtime_image_key != null) {
      return { error: "项目 RoleConfig 不接受 runtime_image_key；运行镜像由平台目录与 Job 快照决定" };
    }
    let sandboxLimits: ReturnType<typeof parseSandboxLimitsOverride>;
    try {
      sandboxLimits = parseSandboxLimitsOverride(body.sandbox_limits);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!projectId && Object.keys(sandboxLimits).length > 0) {
      return { error: "sandbox_limits numeric overrides are only allowed on project RoleConfigs" };
    }
    // #697 P0: project cannot raise any dimension above platform env defaults.
    if (projectId && sandboxLimitsExceedPlatform(sandboxLimits, config.runtime.sandboxLimits)) {
      return {
        error: "sandbox_limits 任一维度不得超过平台默认（DEEPSONAR_SANDBOX_*）；更高配额请调平台 env / 镜像地板",
        error_code: SANDBOX_LIMITS_EXCEED_PLATFORM,
      };
    }
    const knobsErr = validateRuntimeKnobOverride(body.runtime_knobs);
    if (knobsErr) return { error: knobsErr };
    const envErr = validateEnvVars(body.env_vars);
    try {
      parseContextWindowTokens(body.context_window_tokens);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (envErr) return { error: envErr };
    for (const key of body.env_keys) {
      if (!config.runtime.isEnvKeyAllowed(key)) return { error: `env_key 不在白名单: ${key}` };
    }
    for (const selector of body.modules) {
      try {
        parseModuleSelector(selector);
      } catch (error) {
        return { error: `模块 selector 非法（${selector}）: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (!projectId && body.runtime_image_key) {
      const [image] = await db`
        SELECT ri.id, ri.official, ri.project_opt_in,
               EXISTS (SELECT 1 FROM runtime_image_versions v WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted') AS has_trusted,
               pri.enabled AS project_enabled
        FROM runtime_images ri
        LEFT JOIN project_runtime_images pri ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
        WHERE ri.image_key = ${body.runtime_image_key} AND ri.enabled = true`;
      if (!image) return { error: `runtime_image_key 不存在或已禁用: ${body.runtime_image_key}` };
      // 这里只校验全局 RoleConfig 的镜像绑定；项目 RoleConfig 已在上方拒绝该字段。
      const fakeOfficialCatalogImage = config.runtime.agentMode === "fake" && image.official;
      if (!image.has_trusted && !fakeOfficialCatalogImage) return { error: `runtime_image_key 没有可信版本: ${body.runtime_image_key}` };
      if (!image.official && (!projectId || image.project_enabled !== true)) {
        return { error: `第三方镜像必须先在目标项目显式启用: ${body.runtime_image_key}` };
      }
    }
    const allowedTools = new Set<string>(allowedPlatformTools(role.name, role.kind));
    for (const tool of Object.keys(body.platform_tools)) {
      if (!allowedTools.has(tool)) return { error: `角色 ${role.name} 不支持平台工具: ${tool}` };
    }
    for (const tool of requiredPlatformTools(role.kind)) {
      if (body.platform_tools[tool] === false) return { error: `终态必需平台工具不可关闭: ${tool}` };
    }
    // #690: RoleConfig no longer accepts credentials / pi_extensions bindings.
    if (body.config_files.length > CONFIG_FILE_MAX_COUNT) {
      return { error: `配置文件数量超限（>${CONFIG_FILE_MAX_COUNT}）` };
    }
    let totalBytes = 0;
    for (const f of body.config_files) {
      const pathErr = validateConfigFilePath(body.agent_cli, f.path);
      if (pathErr) return { error: `配置文件 ${f.path}: ${pathErr}` };
      const bytes = Buffer.byteLength(f.content, "utf8");
      if (bytes > CONFIG_FILE_MAX_BYTES) {
        return { error: `配置文件 ${f.path} 超过单文件大小限制` };
      }
      totalBytes += bytes;
      const secretHit = scanConfigContent(f.content);
      if (secretHit) {
        return { error: `配置文件 ${f.path} 命中密钥特征（${secretHit}），请改用 Credential` };
      }
    }
    if (totalBytes > CONFIG_FILE_MAX_TOTAL) return { error: `配置文件总大小超限` };
    return { error: null };
  }

  async function upsertRoleConfigInTx(
    tx: typeof sql,
    roleId: string,
    projectId: string | null,
    body: z.infer<typeof RoleConfigPutBody>,
  ): Promise<{
    configId: string;
    dropped_fields: Array<{ field: string; reason: string }>;
    before_allow_model_catalog_passthrough: boolean;
  }> {
    const [existing] = projectId
      ? await tx`SELECT id, version, allow_model_catalog_passthrough FROM role_configs WHERE role_id = ${roleId} AND project_id = ${projectId}`
      : await tx`SELECT id, version, allow_model_catalog_passthrough FROM role_configs WHERE role_id = ${roleId} AND project_id IS NULL`;
    const dropped_fields: Array<{ field: string; reason: string }> = [];
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const persistModel = projectId
      ? persistableProjectRoleConfigModel(
        parseProjectImagePolicy(
          (await tx`SELECT config_json FROM projects WHERE id = ${projectId}`)[0]?.config_json,
        ),
        body.model,
      )
      : body.model ?? null;
    if (projectId && persistModel === null && requestedModel !== "") {
      dropped_fields.push({ field: "model", reason: "inherit_global_ignores_project_model" });
    }
    // #697: RoleConfig 不再写入/授权 allow_model_catalog_passthrough（仅平台 env + 管理员项目设置）
    if (body.allow_model_catalog_passthrough === true) {
      dropped_fields.push({
        field: "allow_model_catalog_passthrough",
        reason: "role_config_passthrough_retired_use_project_allowlist_or_env",
      });
    }
    const row = {
      role_id: roleId,
      project_id: projectId,
      agent_cli: body.agent_cli,
      dsh_task_mode: body.dsh_task_mode,
      model: persistModel,
      allow_model_catalog_passthrough: false,
      context_window_tokens: parseContextWindowTokens(body.context_window_tokens),
      env_vars_json: body.env_vars as never,
      env_keys: body.env_keys as never,
      modules_json: body.modules as never,
      skills_json: body.skills as never,
      commands_json: body.commands as never,
      mcps_json: body.mcps as never,
      subagents_json: body.subagents as never,
      platform_tools_json: body.platform_tools as never,
      sandbox_limits_json: parseSandboxLimitsOverride(body.sandbox_limits) as never,
      runtime_knobs_json: parseRuntimeKnobOverride(body.runtime_knobs) as never,
      instructions_markdown: body.instructions_markdown ?? null,
      runtime_image_key: projectId ? null : body.runtime_image_key ?? null,
    };
    let configId: string;
    if (existing) {
      configId = existing.id as string;
      await tx`
        UPDATE role_configs SET ${tx(row as never)}, version = version + 1, updated_at = now()
        WHERE id = ${configId}`;
    } else {
      const [ins] = await tx`INSERT INTO role_configs ${tx(row as never)} RETURNING id`;
      configId = ins.id as string;
    }
    await tx`DELETE FROM role_config_files WHERE role_config_id = ${configId}`;
    for (const f of body.config_files) {
      await tx`
        INSERT INTO role_config_files ${tx({
          role_config_id: configId,
          path: f.path,
          content: f.content,
          content_sha256: createHash("sha256").update(f.content, "utf8").digest("hex"),
        })}
        ON CONFLICT (role_config_id, path) DO UPDATE SET
          content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256, updated_at = now()`;
    }
    return {
      configId,
      dropped_fields,
      before_allow_model_catalog_passthrough: existing?.allow_model_catalog_passthrough === true,
    };
  }

  /**
   * Validate and upsert atomically.  Credential PATCH takes this same
   * advisory lock before locking its credential row, so validation cannot be
   * invalidated by a concurrent provider/project/metadata mutation.
   */
  async function mutateRoleConfig(
    roleId: string,
    projectId: string | null,
    body: z.infer<typeof RoleConfigPutBody>,
    role: { name: string; kind: "role" | "hub" | "system" },
  ): Promise<
    | {
      configId: string;
      dropped_fields: Array<{ field: string; reason: string }>;
      before_allow_model_catalog_passthrough: boolean;
    }
    | { statusCode: number; error: string; error_code?: string }
  > {
    return sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      if (projectId && role.kind === "role") {
        const enabled = await rolesForProject(tx, projectId);
        if (!enabled.some((r) => r.name === role.name)) {
          return { statusCode: 409, error: `角色 ${role.name} 未在本项目启用` };
        }
      }
      const validation = await validateRoleConfigBody(body, projectId, role, tx);
      if (validation.error) {
        return {
          statusCode: 400,
          error: validation.error,
          ...(validation.error_code ? { error_code: validation.error_code } : {}),
        };
      }
      return await upsertRoleConfigInTx(tx, roleId, projectId, body);
    });
  }

  /** Return a RoleConfig view. #690: no credential bindings / pi_extensions on RoleConfig. */
  async function roleConfigView(
    configId: string,
    _actorProjectId: string | null = null,
  ): Promise<Record<string, unknown> | null> {
    const [cfg] = await sql`SELECT * FROM role_configs WHERE id = ${configId}`;
    if (!cfg) return null;
    const files = await sql`
      SELECT path, content, content_sha256 FROM role_config_files
      WHERE role_config_id = ${configId} ORDER BY path`;
    return {
      ...(cfg as Record<string, unknown>),
      // #697: RoleConfig 列保留但 API 恒回报 false（解析侧已忽略）
      allow_model_catalog_passthrough: false,
      context_window_tokens: cfg.context_window_tokens == null ? null : Number(cfg.context_window_tokens),
      runtime_image_key: cfg.project_id ? null : cfg.runtime_image_key ?? null,
      credentials: [],
      config_files: files,
    };
  }


  function buildRoleConfigUpsertWarnings(input: {
    dropped_fields: Array<{ field: string; reason: string }>;
  }) {
    if (input.dropped_fields.length === 0) return [];
    return [{
      category: "model_correctable" as const,
      code: "ROLE_CONFIG_MODEL_DROPPED_INHERIT_GLOBAL",
      field: "model",
      message: "项目镜像策略 inherit_global（或非 project_managed）时 RoleConfig.model 不会落库",
    }];
  }

  async function auditRoleConfigPassthroughEnable(
    req: FastifyRequest,
    input: {
      configId: string;
      projectId?: string | null;
      roleName: unknown;
      scope: "global" | "project";
      before: boolean;
      after: boolean;
    },
  ): Promise<void> {
    if (!input.after || input.before) return;
    await audit(req, {
      action: "role_config.model_catalog_passthrough_enabled",
      resourceType: "role_config",
      resourceId: input.configId,
      projectId: input.projectId ?? undefined,
      before: { allow_model_catalog_passthrough: false },
      after: {
        allow_model_catalog_passthrough: true,
        role: input.roleName,
        scope: input.scope,
      },
    });
  }

  app.get("/role-configs/global", async (req) => {
    const actorProjectId = req.actor?.projectId ?? null;
    const rows = await sql`
      SELECT rc.id, r.name AS role_name, r.title AS role_title, r.kind AS role_kind
      FROM role_configs rc JOIN agent_roles r ON r.id = rc.role_id
      WHERE rc.project_id IS NULL ORDER BY r.name`;
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const view = await roleConfigView(row.id as string, actorProjectId);
      if (!view) continue;
      out.push({
        ...view,
        role_name: row.role_name,
        role_title: row.role_title,
        role_kind: row.role_kind,
      });
    }
    return out;
  });

  /** Unified binding picker for the Provider account flow. It intentionally
   * returns only RoleConfig identity/health metadata, never secret material. */
  /** Lightweight CLI update for Provider bind UI (does not rewrite credentials/files). */
  app.patch("/role-configs/:id/agent-cli", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_ROLE_CONFIG_ID)) return;
    const body = z.object({
      agent_cli: AgentCliWriteSchema,
    }).parse(req.body);
    const actorProjectId = req.actor?.projectId ?? null;
    const [row] = await sql`
      SELECT rc.id, rc.project_id, rc.agent_cli, rc.role_id,
             r.name AS role_name, r.kind AS role_kind
      FROM role_configs rc
      JOIN agent_roles r ON r.id = rc.role_id
      WHERE rc.id = ${id}`;
    if (!row) return reply.code(404).send({ error: "RoleConfig not found" });
    if (actorProjectId) {
      if (!row.project_id || String(row.project_id) !== actorProjectId) {
        return reply.code(403).send({
          error: "project-scoped actors may only change RoleConfigs in their own project",
          error_code: "PROJECT_SCOPE_FORBIDDEN",
        });
      }
    }
    const patch = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      const [next] = await tx`
        UPDATE role_configs
        SET agent_cli = ${body.agent_cli}, version = version + 1, updated_at = now()
        WHERE id = ${id}
        RETURNING id, agent_cli, version, project_id, role_id`;
      return { row: next };
    });
    await audit(req, {
      action: "role_config.agent_cli",
      resourceType: "role_config",
      resourceId: id,
      after: {
        agent_cli: body.agent_cli,
        role: row.role_name,
        project_id: row.project_id,
      },
    });
    return {
      id: patch.row.id,
      agent_cli: patch.row.agent_cli,
      version: patch.row.version,
      role_id: patch.row.role_id,
      project_id: patch.row.project_id,
    };
  });

  /** Lightweight runtime image update for Provider bind UI (null = system base). */
  app.patch("/role-configs/:id/runtime-image", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_ROLE_CONFIG_ID)) return;
    const body = z.object({
      runtime_image_key: z.string().min(1).max(200).nullable(),
    }).parse(req.body);
    const actorProjectId = req.actor?.projectId ?? null;
    const [row] = await sql`
      SELECT rc.id, rc.project_id, rc.runtime_image_key, rc.role_id,
             r.name AS role_name, r.kind AS role_kind
      FROM role_configs rc
      JOIN agent_roles r ON r.id = rc.role_id
      WHERE rc.id = ${id}`;
    if (!row) return reply.code(404).send({ error: "RoleConfig not found" });
    if (actorProjectId) {
      if (!row.project_id || String(row.project_id) !== actorProjectId) {
        return reply.code(403).send({
          error: "project-scoped actors may only change RoleConfigs in their own project",
          error_code: "PROJECT_SCOPE_FORBIDDEN",
        });
      }
    }
    const projectId = row.project_id ? String(row.project_id) : null;
    if (projectId) {
      return reply.code(400).send({ error: "项目 RoleConfig 不接受 runtime_image_key；运行镜像由平台目录与 Job 快照决定" });
    }
    if (!projectId && body.runtime_image_key) {
      const [image] = await sql`
        SELECT ri.id, ri.official, ri.project_opt_in,
               EXISTS (SELECT 1 FROM runtime_image_versions v WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted') AS has_trusted,
               pri.enabled AS project_enabled
        FROM runtime_images ri
        LEFT JOIN project_runtime_images pri ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
        WHERE ri.image_key = ${body.runtime_image_key} AND ri.enabled = true`;
      if (!image) {
        return reply.code(400).send({ error: `runtime_image_key 不存在或已禁用: ${body.runtime_image_key}` });
      }
      // 该 PATCH 只允许修改全局 RoleConfig；项目 RoleConfig 已在上方拒绝镜像字段。
      const fakeOfficialCatalogImage = config.runtime.agentMode === "fake" && image.official;
      if (!image.has_trusted && !fakeOfficialCatalogImage) {
        return reply.code(400).send({ error: `runtime_image_key 没有可信版本: ${body.runtime_image_key}` });
      }
      if (!image.official && (!projectId || image.project_enabled !== true)) {
        return reply.code(400).send({
          error: `第三方镜像必须先在目标项目显式启用: ${body.runtime_image_key}`,
        });
      }
    }
    const [updated] = await sql`
      UPDATE role_configs
      SET runtime_image_key = ${body.runtime_image_key}, version = version + 1, updated_at = now()
      WHERE id = ${id}
      RETURNING id, runtime_image_key, version, project_id, role_id`;
    await audit(req, {
      action: "role_config.runtime_image",
      resourceType: "role_config",
      resourceId: id,
      after: {
        runtime_image_key: body.runtime_image_key,
        role: row.role_name,
        project_id: row.project_id,
      },
    });
    return {
      id: updated.id,
      runtime_image_key: updated.runtime_image_key ?? null,
      version: updated.version,
      role_id: updated.role_id,
      project_id: updated.project_id,
    };
  });

  app.get("/role-configs/bindable", async (req) => {
    const projectScope = req.actor?.projectId ?? null;
    const rows = await sql`
      SELECT rc.id, rc.role_id, r.name AS role_name, r.title AS role_title,
             r.kind AS role_kind, r.builtin AS role_builtin, r.ui_color AS role_ui_color,
             rc.project_id, p.name AS project_name, p.config_json AS project_config_json,
             rc.agent_cli, rc.dsh_task_mode, rc.model,
             rc.context_window_tokens, rc.version,
             CASE WHEN rc.project_id IS NULL THEN rc.runtime_image_key ELSE NULL END AS runtime_image_key
      FROM role_configs rc
      JOIN agent_roles r ON r.id = rc.role_id
      LEFT JOIN projects p ON p.id = rc.project_id
      WHERE (${projectScope}::uuid IS NULL OR rc.project_id IS NULL OR rc.project_id = ${projectScope})
      ORDER BY
        CASE r.kind WHEN 'system' THEN 0 WHEN 'hub' THEN 1 ELSE 2 END,
        rc.project_id NULLS FIRST,
        p.name NULLS FIRST,
        r.name`;
    return rows.map((row) => {
      const { project_config_json: _projectConfigJson, ...bindable } = row;
      return {
      ...bindable,
      context_window_tokens: row.context_window_tokens == null ? null : Number(row.context_window_tokens),
      runtime_image_key: row.runtime_image_key ?? null,
      role_kind: row.role_kind ?? "role",
      role_builtin: Boolean(row.role_builtin),
      role_ui_color: typeof row.role_ui_color === "string" ? row.role_ui_color : null,
      scope: row.project_id ? "project" : "global",
      image_strategy: null,
      can_bind: false,
      credential_id: null,
      credential_name: null,
      credential_provider: null,
      credential_provider_valid: null,
      credential_status: null,
    };
    });
  });

  app.put("/role-configs/global/:roleId", async (req, reply) => {
    const { roleId } = req.params as { roleId: string };
    if (rejectUnlessUuid(reply, roleId, INVALID_ROLE_ID)) return;
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleConfigPutBody.parse(req.body);
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    const mutation = await mutateRoleConfig(roleId, null, body, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if ("error" in mutation) {
      return reply.code(mutation.statusCode).send({
        error: mutation.error,
        ...(mutation.error_code ? { error_code: mutation.error_code } : {}),
      });
    }
    const configId = mutation.configId;
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      after: {
        role: role.name,
        scope: "global",
                files: body.config_files.length,
          dropped_fields: mutation.dropped_fields,
      },
    });
    // #697: RoleConfig 不再能开启 passthrough；保留审计 helper 字符串供测试/检索，after 恒为 false。
    await auditRoleConfigPassthroughEnable(req, {
      configId,
      roleName: role.name,
      scope: "global",
      before: mutation.before_allow_model_catalog_passthrough,
      after: false,
    });
    const view = await roleConfigView(configId, req.actor?.projectId ?? null);
    const upsert_warnings = buildRoleConfigUpsertWarnings({
      dropped_fields: mutation.dropped_fields,
    });
    return {
      ...view,
      dropped_fields: mutation.dropped_fields,
      ...(upsert_warnings.length > 0 ? { upsert_warnings } : {}),
    };
  });

  app.get("/projects/:id/role-configs", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_PROJECT_ID)) return;
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may read only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rows = await sql`
      SELECT r.id AS role_id, r.name, r.title, r.kind, r.builtin,
             pc.id AS project_config_id, pc.version AS project_config_version,
             gc.id AS global_config_id, gc.version AS global_config_version,
             CASE WHEN pc.id IS NOT NULL THEN 'project'
                  WHEN gc.id IS NOT NULL THEN 'global'
                  ELSE 'none' END AS config_source
      FROM agent_roles r
      LEFT JOIN role_configs pc ON pc.role_id = r.id AND pc.project_id = ${id}
      LEFT JOIN role_configs gc ON gc.role_id = r.id AND gc.project_id IS NULL
      ORDER BY r.kind, r.builtin DESC, r.name`;
    return Promise.all(rows.map(async (row) => ({
      ...row,
      project_config: row.project_config_id
        ? await roleConfigView(row.project_config_id as string, actorProjectId)
        : null,
    })));
  });

  app.put("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    if (rejectUnlessUuid(reply, id, INVALID_PROJECT_ID)) return;
    if (rejectUnlessUuid(reply, roleId, INVALID_ROLE_ID)) return;
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleConfigPutBody.parse(req.body);
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    const mutation = await mutateRoleConfig(roleId, id, body, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if ("error" in mutation) {
      return reply.code(mutation.statusCode).send({
        error: mutation.error,
        ...(mutation.error_code ? { error_code: mutation.error_code } : {}),
      });
    }
    const configId = mutation.configId;
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      projectId: id,
      after: {
        role: role.name,
        scope: "project",
                files: body.config_files.length,
          dropped_fields: mutation.dropped_fields,
      },
    });
    await auditRoleConfigPassthroughEnable(req, {
      configId,
      projectId: id,
      roleName: role.name,
      scope: "project",
      before: mutation.before_allow_model_catalog_passthrough,
      after: false,
    });
    const view = await roleConfigView(configId, actorProjectId);
    const upsert_warnings = buildRoleConfigUpsertWarnings({
      dropped_fields: mutation.dropped_fields,
    });
    return {
      ...view,
      dropped_fields: mutation.dropped_fields,
      ...(upsert_warnings.length > 0 ? { upsert_warnings } : {}),
    };
  });

  app.delete("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    if (rejectUnlessUuid(reply, id, INVALID_PROJECT_ID)) return;
    if (rejectUnlessUuid(reply, roleId, INVALID_ROLE_ID)) return;
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [row] = await sql`
      DELETE FROM role_configs WHERE role_id = ${roleId} AND project_id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "该项目没有此角色的覆盖配置" });
    await audit(req, {
      action: "role_config.delete",
      resourceType: "role_config",
      resourceId: row.id as string,
      projectId: id,
    });
    return { ok: true };
  });

  // ---------- 角色注册表：hub 可下发的 agent 类型，全局注册 + 项目级启用 ----------
  app.get("/agent-roles", async () =>
    sql`SELECT id, name, title, description, builtin, kind, ui_color, created_at, updated_at
        FROM agent_roles ORDER BY kind DESC, builtin DESC, name`,
  );

  app.post("/agent-roles", async (req, reply) => {
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleBody.parse(req.body);
    try {
      const row = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        // Serialize the used-color read with the INSERT.  Deleting a role
        // naturally releases its color because no tombstone is retained.
        const uiColor = await allocateRoleUiColor(tx);
        const [created] = await tx`
          INSERT INTO agent_roles ${tx({ ...body, builtin: false, kind: "role", ui_color: uiColor })}
          RETURNING id, name, title, description, builtin, kind, ui_color`;
        return created;
      });
      if (!row) throw new Error("角色创建失败：未返回新角色");
      await audit(req, {
        action: "role.create",
        resourceType: "agent_role",
        resourceId: row.id as string,
        after: { name: row.name, title: row.title, ui_color: row.ui_color },
      });
      return row;
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: `角色 ${body.name} 已存在` });
      }
      throw e;
    }
  });

  app.patch("/agent-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_ROLE_ID)) return;
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RolePatchBody.parse(req.body);
    const [row] = await sql`
      UPDATE agent_roles SET ${sql(body)}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, title, description, builtin, kind, ui_color`;
    if (!row) return reply.code(404).send({ error: "role not found" });
    await audit(req, {
      action: "role.update",
      resourceType: "agent_role",
      resourceId: id,
      after: {
        name: row.name,
        changed: Object.keys(body),
      },
    });
    return row;
  });

  app.delete("/agent-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_ROLE_ID)) return;
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${id}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (role.kind !== "role") {
      return reply.code(409).send({ error: "系统角色与 Hub 中枢不可删除，只能修改职责和运行配置" });
    }
    const [row] = await sql`
      DELETE FROM agent_roles WHERE id = ${id} AND kind = 'role' RETURNING id, name`;
    if (!row) return reply.code(409).send({ error: "角色状态已变化，请刷新后重试" });
    await audit(req, {
      action: "role.delete",
      resourceType: "agent_role",
      resourceId: id,
      before: { name: row.name, kind: role.kind },
    });
    return { ok: true };
  });

  // Project view exposes every platform role plus roles owned by this project.
  // Role enablement is a Hub dispatch decision, so legacy config_json.roles.enabled
  // is intentionally not an authorization filter.
  app.get("/projects/:id/roles", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnlessUuid(reply, id, INVALID_PROJECT_ID)) return;
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const all = await sql`
      SELECT id, name, title, description, builtin, kind, ui_color, project_id FROM agent_roles
      WHERE kind = 'role' AND (project_id IS NULL OR project_id = ${id})
      ORDER BY project_id NULLS FIRST, builtin DESC, name`;
    return (all as unknown as { name: string; builtin: boolean; ui_color: string | null; project_id: string | null }[]).map((r) => ({
      ...r,
      enabled: true,
      default_enabled: true,
    }));
  });
}
