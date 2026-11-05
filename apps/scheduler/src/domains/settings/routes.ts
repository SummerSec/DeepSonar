import { SettingsPatchBody, GlobalSettingsPatchBody } from "../../settings-validation.js";
export { parseConcurrencyRulesPatch } from "../../settings-validation.js";
import type { FastifyInstance } from "fastify";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { projectCredentialProvider } from "../../credentials.js";
import {
  globalRules,
  mergeGlobalRulesPatch,
  rulesForProject,
  scrubLeftoverRulesJson,
  stripFindingProtocolFromRules,
} from "../../core.js";
import { PLATFORM_DEFAULT_AGENT_CLI } from "../role-runtime-snapshot/index.js";
import { sql } from "../../db.js";
import { lockCredentialProjectReferences } from "../../credential-project-references.js";
import { loadReadiness, type ReadinessMaterialSource } from "../../readiness.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import {
  scrubIgnoredProjectRoleConfigIdentity,
  scrubStoredProjectImagePolicy,
} from "../role-runtime-snapshot/application.js";
import {
  applyProjectAgentAllowlistPatch,
  parseProjectAgentAllowlist,
} from "../project-agent-allowlist/index.js";
import { resolveModelDescriptorCatalog } from "../provider-adapter/index.js";
import { extractModelsFromSettings } from "../../provider-settings.js";


export function projectJobQuotaPatchExceedsGlobal(
  currentQuota: unknown,
  nextQuota: unknown,
  globalMaxJobsPerProject: number,
): boolean {
  return typeof nextQuota === "number"
    && nextQuota !== currentQuota
    && nextQuota > globalMaxJobsPerProject;
}



function projectAllowlistResponse(cfg: Record<string, unknown>) {
  const allowlist = parseProjectAgentAllowlist(cfg);
  return {
    enabled_agent_clis: allowlist.enabled_agent_clis,
    enabled_credential_ids: allowlist.enabled_credential_ids,
    default_agent_cli: allowlist.default_agent_cli,
    default_credential_id: allowlist.default_credential_id,
    default_model_ref: allowlist.default_model_ref,
    fallback_model_refs: allowlist.fallback_model_refs,
    allow_model_catalog_passthrough: allowlist.allow_model_catalog_passthrough,
    agent_allowlist_configured: allowlist.configured,
    credential_ids_configured: allowlist.credential_ids_configured,
  };
}


async function validateProjectCredentialAllowlist(
  query: typeof sql,
  projectId: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const allowlist = parseProjectAgentAllowlist(cfg);
  if (cfg.default_credential_id != null && !allowlist.default_credential_id) {
    throw Object.assign(new Error("缺省 Provider 引用必须是有效 UUID 且属于项目账号白名单"), {
      error_code: "provider_credential_allowlist_stale",
    });
  }
  if (!allowlist.default_credential_id && (cfg.default_model_ref != null
    || (Array.isArray(cfg.fallback_model_refs) && cfg.fallback_model_refs.length > 0))) {
    throw new Error("缺省/回退模型必须绑定缺省 Provider");
  }
  const ids = [...new Set([
    ...allowlist.enabled_credential_ids,
    ...(allowlist.default_credential_id ? [allowlist.default_credential_id] : []),
  ])];
  await lockCredentialProjectReferences(query, ids);
  const credentials = ids.length === 0 ? [] : await query`
    SELECT id, provider, model_catalog_fetched_at, settings_config_json, agent_cli
    FROM credentials
    WHERE id = ANY(${ids}::uuid[]) AND kind = 'llm_provider' AND status = 'active'
      AND (project_id IS NULL OR project_id = ${projectId})`;
  if (credentials.length !== ids.length) {
    throw Object.assign(new Error("项目账号引用必须已存在、active 且对当前项目可见；请移除或替换失效引用，不能删除白名单键扩大授权"), {
      error_code: "provider_credential_allowlist_stale",
    });
  }
  const refs = [
    ...(allowlist.default_model_ref ? [allowlist.default_model_ref] : []),
    ...allowlist.fallback_model_refs,
  ];
  if (refs.length === 0 || !allowlist.default_credential_id) return;
  const credential = credentials.find((row) => row.id === allowlist.default_credential_id)!;
  // Allowlist SSOT: account-configured model ids by credential CLI dialect (#656/#679).
  const dialectCli = typeof credential.agent_cli === "string" && credential.agent_cli.trim()
    ? credential.agent_cli.trim()
    : allowlist.default_agent_cli;
  const configuredModelIds = extractModelsFromSettings(credential.settings_config_json, dialectCli);
  const catalog = resolveModelDescriptorCatalog({
    provider: String(credential.provider),
    catalogJson: configuredModelIds,
    catalogRevision: typeof credential.model_catalog_fetched_at === "string"
      ? credential.model_catalog_fetched_at
      : `credential:${String(credential.id)}`,
  });
  if (!allowlist.allow_model_catalog_passthrough && configuredModelIds.length === 0 && refs.length > 0) {
    const err = new Error(
      `项目已指定缺省/回退模型，但 Provider 账号尚未配置 models[].id（或该 Agent CLI 方言对应的模型字段）；请先在凭据 settings 填写模型名单，或仅在 alias 网关应急时开启 allow_model_catalog_passthrough`,
    ) as Error & { error_code?: string; repair_code?: string };
    err.error_code = "model_allowlist_unconfigured";
    err.repair_code = "model_allowlist_unconfigured";
    throw err;
  }
  if (!allowlist.allow_model_catalog_passthrough && configuredModelIds.length > 0) {
    const known = new Set(configuredModelIds);
    const unknown = refs.find((ref) => !known.has(ref));
    if (unknown) {
      const err = new Error(
        `模型 ${unknown} 不在账号已配置的 provider 模型名单（选模 SSOT）；请在 Provider 账号填写该模型 id，或仅在 alias 网关应急时开启 allow_model_catalog_passthrough`,
      ) as Error & { error_code?: string; repair_code?: string };
      err.error_code = "model_not_in_catalog";
      err.repair_code = "model_passthrough_disabled";
      throw err;
    }
    const selectedCli = allowlist.default_agent_cli;
    if (selectedCli) {
      const incompatible = refs.find((ref) => {
        const descriptor = catalog.find((row) => row.model_id === ref);
        return descriptor && !descriptor.compatible_agent_clis.includes(selectedCli);
      });
      if (incompatible) throw new Error(`模型 ${incompatible} 与缺省 Agent CLI ${selectedCli} 不兼容`);
    }
  }
}

class ProjectSettingsRejected extends Error {
  constructor(readonly statusCode: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

function parseStoredFindingProtocolConfig(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return FindingProtocolConfig.parse(value);
}
const ReadinessQuery = z.object({
  allow_egress: z.enum(["true", "false"]).optional(),
  material_source: z.enum(["workspace_or_offline", "external_or_workspace", "declared", "unspecified"]).optional(),
});

export function registerSettingsRoutes(app: FastifyInstance): void {
  // ---------- 全局设置（§8.1 所有配置落库：规则默认值 → global_settings 单例行） ----------
  const aggregateActive = (rows: Record<string, unknown>[], key: "agent_cli" | "provider") => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const name = key === "provider"
        ? row[key] == null || row[key] === ""
          ? ""
          : projectCredentialProvider("llm_provider", row[key]).provider
        : String(row[key] ?? "");
      if (name) out[name] = (out[name] ?? 0) + Number(row.count);
    }
    return out;
  };

  app.get("/global-settings", async () => {
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const storedRules = scrubLeftoverRulesJson(((g?.rules_json ?? {}) ?? {})).rules;
    const findingProtocol = parseStoredFindingProtocolConfig(storedRules.finding_protocol);
    const rules = stripFindingProtocolFromRules(storedRules);
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules,
      effective_rules: await globalRules(sql),
      finding_protocol: findingProtocol ?? null,
      effective_finding_protocol: resolveFindingProtocol(findingProtocol),
      active_by_agent_cli: aggregateActive(activeRows, "agent_cli"),
      active_by_provider: aggregateActive(activeRows, "provider"),
    };
  });

  app.patch("/global-settings", async (req, reply) => {
    let body: z.infer<typeof GlobalSettingsPatchBody>;
    try {
      body = GlobalSettingsPatchBody.parse(req.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid global settings rules", details: error instanceof z.ZodError ? error.issues : undefined });
    }
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const current = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
    const merged = body.rules ? mergeGlobalRulesPatch(current, body.rules) : { ...current };
    if (body.finding_protocol !== undefined) {
      if (body.finding_protocol === null) delete merged.finding_protocol;
      else merged.finding_protocol = body.finding_protocol;
    }
    let effectiveFindingProtocol;
    try {
      effectiveFindingProtocol = resolveFindingProtocol(
        parseStoredFindingProtocolConfig(merged.finding_protocol),
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid finding protocol" });
    }
    await sql`UPDATE global_settings SET rules_json = ${sql.json(merged as never)}, updated_at = now() WHERE id = 'global'`;
    // Wake a LISTEN-driven dispatcher so a newly available slot/CLI cap is
    // observed without waiting for an optional polling interval or restart.
    await sql`SELECT pg_notify('deepsonar_jobs', 'global-settings-updated')`;
    // 全局规则修改是「全局规则修改」必记项
    await audit(req, {
      action: "settings.global_update",
      resourceType: "global_settings",
      resourceId: "global",
      after: {
        changed_keys: [
          ...Object.keys(body.rules ?? {}),
          ...(body.finding_protocol === undefined ? [] : ["finding_protocol"]),
        ],
      },
    });
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: stripFindingProtocolFromRules(merged),
      effective_rules: await globalRules(sql),
      finding_protocol: parseStoredFindingProtocolConfig(merged.finding_protocol) ?? null,
      effective_finding_protocol: effectiveFindingProtocol,
      active_by_agent_cli: aggregateActive(activeRows, "agent_cli"),
      active_by_provider: aggregateActive(activeRows, "provider"),
    };
  });

  // ---------- 项目设置：运行规则 + 角色启停 ----------
  // ---------- Readiness / preflight projection (#35/#36, read-only) ----------
  // The projection reads only Scheduler-owned rows. Query values are a small
  // enum/boolean overlay for the task form; secrets, env names and OCI refs
  // are never accepted or returned here.
  function parseReadinessQuery(req: { query?: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): z.infer<typeof ReadinessQuery> | null {
    const parsed = ReadinessQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid readiness query", details: parsed.error.issues });
      return null;
    }
    return parsed.data;
  }

  async function readinessResponse(
    req: { query?: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    projectId?: string,
  ) {
    const query = parseReadinessQuery(req, reply);
    if (!query) return;
    if (projectId && !z.string().uuid().safeParse(projectId).success) {
      return reply.code(400).send({ error: "invalid project id" });
    }
    try {
      return await loadReadiness(sql, {
        projectId,
        allowEgress: query.allow_egress === undefined ? undefined : query.allow_egress === "true",
        materialSource: query.material_source as ReadinessMaterialSource | undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "project not found") {
        return reply.code(404).send({ error: "project not found" });
      }
      throw error;
    }
  }

  app.get("/readiness", async (req, reply) => readinessResponse(req, reply));
  app.get("/projects/:id/readiness", async (req, reply) => {
    const { id } = req.params as { id: string };
    return readinessResponse(req, reply, id);
  });

  app.get("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    if (scrubStoredProjectImagePolicy(cfg)) {
      await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
    }
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    const [activeRow] = await sql`
      SELECT COUNT(*)::int AS count FROM jobs
      WHERE project_id = ${id} AND status IN ('claimed','provisioning','running')`;
    return {
      rules: stripFindingProtocolFromRules(scrubLeftoverRulesJson(cfg.rules ?? {}).rules),
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: resolveFindingProtocol(globalProtocol, projectProtocol),
      device_access_enabled: cfg.device_access_enabled === true,
      ...projectAllowlistResponse(cfg),
      active_jobs: Number(activeRow?.count ?? 0),
    };
  });

  app.patch("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    let body: z.infer<typeof SettingsPatchBody>;
    // #674: 拒绝遗留镜像策略字段（若客户端仍发送）——在 DB/校验之前返回，便于无库冒烟。
    if (
      req.body
      && typeof req.body === "object"
      && !Array.isArray(req.body)
      && ("image_strategy" in (req.body as Record<string, unknown>) || "role_runtime_images" in (req.body as Record<string, unknown>))
    ) {
      return reply.code(400).send({
        error: "项目级镜像策略已移除：Job 镜像只认平台目录与 Hub 提案（list_available_runtime_images）",
        code: "project_image_policy_removed",
      });
    }
    try {
      body = SettingsPatchBody.parse(req.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid project settings rules", details: error instanceof z.ZodError ? error.issues : undefined });
    }
    let result;
    try {
      result = await sql.begin(async (txRaw) => {
        // SAFETY: postgres.js transactions expose the same query interface used by the domain helpers.
        const tx = txRaw as unknown as typeof sql;
        const [p] = await tx`SELECT config_json FROM projects WHERE id = ${id} FOR UPDATE`;
        if (!p) throw new ProjectSettingsRejected(404, { error: "project not found" });
        const cfg = { ...((p.config_json ?? {}) as Record<string, unknown>) };
        const beforePassthrough = parseProjectAgentAllowlist(cfg).allow_model_catalog_passthrough;
        const beforeQuota = ((cfg.rules as Record<string, unknown> | undefined)?.maxConcurrentJobs) ?? null;
        if (body.rules) {
          const currentRules = { ...((cfg.rules as Record<string, unknown>) ?? {}) };
          const nextRules = { ...currentRules, ...body.rules };
          if (Object.hasOwn(body.rules, "maxConcurrentJobs")) {
            if (body.rules.maxConcurrentJobs === null) {
              delete nextRules.maxConcurrentJobs;
            } else {
              const global = await globalRules(tx);
              if (projectJobQuotaPatchExceedsGlobal(
                currentRules.maxConcurrentJobs,
                body.rules.maxConcurrentJobs,
                global.maxJobsPerProject,
              )) {
                throw new ProjectSettingsRejected(400, {
                  error: `maxConcurrentJobs 不能超过全局每项目上限 ${global.maxJobsPerProject}`,
                });
              }
            }
          }
          cfg.rules = stripFindingProtocolFromRules(scrubLeftoverRulesJson(nextRules).rules);
        }
        if (body.finding_protocol !== undefined) {
          if (body.finding_protocol === null) delete cfg.finding_protocol;
          else cfg.finding_protocol = body.finding_protocol;
        }
        if (body.device_access_enabled !== undefined) {
          // 默认关：null 清除。设备租约的发放前置就是这里的 opt-in。
          if (body.device_access_enabled === null) delete cfg.device_access_enabled;
          else cfg.device_access_enabled = body.device_access_enabled;
        }
        if (
          body.enabled_agent_clis !== undefined
          || body.enabled_credential_ids !== undefined
          || body.default_agent_cli !== undefined
          || body.default_credential_id !== undefined
          || body.default_model_ref !== undefined
          || body.fallback_model_refs !== undefined
          || body.allow_model_catalog_passthrough !== undefined
        ) {
          try {
            applyProjectAgentAllowlistPatch(cfg, {
              enabled_agent_clis: body.enabled_agent_clis,
              enabled_credential_ids: body.enabled_credential_ids,
              default_agent_cli: body.default_agent_cli,
              default_credential_id: body.default_credential_id,
              default_model_ref: body.default_model_ref,
              fallback_model_refs: body.fallback_model_refs,
              allow_model_catalog_passthrough: body.allow_model_catalog_passthrough,
            });
          } catch (error) {
            throw new ProjectSettingsRejected(400, { error: error instanceof Error ? error.message : "invalid agent allowlist" });
          }
        }
        try {
          // Validate retained references too: omitting model/credential fields cannot preserve stale IDs.
          await validateProjectCredentialAllowlist(tx, id, cfg);
        } catch (error) {
          throw new ProjectSettingsRejected(400, {
            error: error instanceof Error ? error.message : "invalid agent allowlist",
            error_code: (error as { error_code?: string }).error_code,
          });
        }
        scrubStoredProjectImagePolicy(cfg);
        const [g] = await tx`SELECT rules_json FROM global_settings WHERE id = 'global'`;
        const globalProtocol = parseStoredFindingProtocolConfig(
          ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
        );
        const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
        let effectiveFindingProtocol;
        try {
          effectiveFindingProtocol = resolveFindingProtocol(globalProtocol, projectProtocol);
        } catch (error) {
          throw new ProjectSettingsRejected(400, { error: error instanceof Error ? error.message : "invalid finding protocol" });
        }
        await tx`UPDATE projects SET config_json = ${tx.json(cfg as never)} WHERE id = ${id}`;
        await scrubIgnoredProjectRoleConfigIdentity(tx, id);
        await tx`SELECT pg_notify('deepsonar_jobs', 'project-settings-updated')`;
        return { cfg, beforePassthrough, beforeQuota, projectProtocol, effectiveFindingProtocol };
      });
    } catch (error) {
      if (error instanceof ProjectSettingsRejected) return reply.code(error.statusCode).send(error.body);
      throw error;
    }
    const { cfg, beforePassthrough, beforeQuota, projectProtocol, effectiveFindingProtocol } = result;
    // 项目级 rules 覆盖 / roles 启停都属配置修改
    const afterQuota = Object.hasOwn(body.rules ?? {}, "maxConcurrentJobs")
      ? ((cfg.rules as Record<string, unknown> | undefined)?.maxConcurrentJobs ?? null)
      : undefined;
    const afterPassthrough = parseProjectAgentAllowlist(cfg).allow_model_catalog_passthrough;
    await audit(req, {
      action: "settings.project_update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      before: afterQuota === undefined ? undefined : { maxConcurrentJobs: beforeQuota ?? null },
      after: {
        changed: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined),
        ...(afterQuota === undefined ? {} : { maxConcurrentJobs: afterQuota }),
      },
    });
    if (afterPassthrough && !beforePassthrough) {
      await audit(req, {
        action: "project.model_catalog_passthrough_enabled",
        resourceType: "project",
        resourceId: id,
        projectId: id,
        before: { allow_model_catalog_passthrough: false },
        after: { allow_model_catalog_passthrough: true },
      });
    }
    const [activeRow] = await sql`
      SELECT COUNT(*)::int AS count FROM jobs
      WHERE project_id = ${id} AND status IN ('claimed','provisioning','running')`;
    return {
      rules: stripFindingProtocolFromRules(scrubLeftoverRulesJson(cfg.rules ?? {}).rules),
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: effectiveFindingProtocol,
      device_access_enabled: cfg.device_access_enabled === true,
      ...projectAllowlistResponse(cfg),
      active_jobs: Number(activeRow?.count ?? 0),
    };
  });
}
