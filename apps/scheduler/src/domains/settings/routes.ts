import type { FastifyInstance } from "fastify";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { isProviderKnown, projectCredentialProvider, UNKNOWN_PROVIDER_ERROR } from "../../credentials.js";
import {
  globalRules,
  LEFTOVER_RULE_ALIAS_KEYS,
  mergeGlobalRulesPatch,
  rulesForProject,
  scrubLeftoverRulesJson,
  stripFindingProtocolFromRules,
} from "../../core.js";
import { PLATFORM_DEFAULT_AGENT_CLI } from "../role-runtime-snapshot/index.js";
import { sql } from "../../db.js";
import { loadReadiness, type ReadinessMaterialSource } from "../../readiness.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import {
  scrubIgnoredProjectRoleConfigIdentity,
  scrubStoredProjectImagePolicy,
} from "../role-runtime-snapshot/application.js";
import {
  applyProjectAgentAllowlistPatch,
  collectProjectIdentityBindings,
  parseProjectAgentAllowlist,
  seedProjectAgentAllowlist,
} from "../project-agent-allowlist/index.js";
import { RUNTIME_KNOB_BOUNDS } from "../../runtime-knobs.js";
import { resolveModelDescriptorCatalog } from "../provider-adapter/index.js";
import { extractModelsFromSettings } from "../../provider-settings.js";

const RULE_CONCURRENCY_KEYS = new Set(["maxGlobalJobs", "maxJobsPerProject", "maxConcurrentProvisioning"]);
const RUNTIME_KNOB_RULE_KEYS = {
  stallSec: RUNTIME_KNOB_BOUNDS.stallSec,
  jobTokenMaxRequests: RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests,
  auditTimeoutSec: RUNTIME_KNOB_BOUNDS.timeoutSec,
  verifyTimeoutSec: RUNTIME_KNOB_BOUNDS.timeoutSec,
  provisionTimeoutSec: RUNTIME_KNOB_BOUNDS.provisionTimeoutSec,
} as const;
const GLOBAL_ONLY_RULE_KEYS = new Set([
  "maxGlobalJobs",
  "maxJobsPerProject",
  "maxConcurrentProvisioning",
  "maxConcurrentByProvider",
  "maxConcurrentByAgentCli",
  "provisionTimeoutSec",
]);
const CLI_CONCURRENCY_KEYS = new Set(["claude-code", "pi", "dsh"]);
const RulesPatch = z.record(z.string(), z.unknown()).superRefine((rules, ctx) => {
  for (const key of LEFTOVER_RULE_ALIAS_KEYS) {
    if (Object.hasOwn(rules, key)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 已删除，验证范围只认 minVerifySeverity`,
      });
    }
  }
  if (Object.hasOwn(rules, "finding_protocol")) {
    ctx.addIssue({
      code: "custom",
      path: ["finding_protocol"],
      message: "finding_protocol 不是规则字段，请使用顶层 finding_protocol",
    });
  }
  for (const key of RULE_CONCURRENCY_KEYS) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 必须是 1-1000 的整数` });
    }
  }
  for (const [key, bound] of Object.entries(RUNTIME_KNOB_RULE_KEYS)) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < bound.min || value > bound.max) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 必须是 ${bound.min}-${bound.max} 的整数${key === "jobTokenMaxRequests" || key === "stallSec" ? "（0 表示不限制）" : ""}`,
      });
    }
  }
  if (Object.hasOwn(rules, "maxNoProgressRounds")) {
    const value = rules.maxNoProgressRounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
      ctx.addIssue({
        code: "custom",
        path: ["maxNoProgressRounds"],
        message: "maxNoProgressRounds 必须是 0-5 的整数（0 表示关闭无进展刹车）",
      });
    }
  }
  if (Object.hasOwn(rules, "maxHubRounds")) {
    const value = rules.maxHubRounds;
    const unlimited = typeof value === "string" && /^unlimited$/i.test(value.trim());
    const finite =
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
    if (!unlimited && !finite) {
      ctx.addIssue({
        code: "custom",
        path: ["maxHubRounds"],
        message: "maxHubRounds 必须是 0-10000 的整数或 unlimited（0 / unlimited 表示不限制轮次）",
      });
    }
  }
  if (Object.hasOwn(rules, "maxConcurrentJobs")) {
    const value = rules.maxConcurrentJobs;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentJobs"], message: "maxConcurrentJobs 必须是 0-1000 的整数或 null" });
    }
  }
  if (Object.hasOwn(rules, "maxConcurrentByAgentCli")) {
    const cliRules = rules.maxConcurrentByAgentCli;
    if (!cliRules || typeof cliRules !== "object" || Array.isArray(cliRules)) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli"], message: "Agent CLI 并发必须是对象" });
    } else {
      for (const [cli, value] of Object.entries(cliRules as Record<string, unknown>)) {
        if (!CLI_CONCURRENCY_KEYS.has(cli) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
          ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli", cli], message: `${cli} 必须是 0-1000 的整数` });
        }
      }
    }
  }
  if (!Object.hasOwn(rules, "maxConcurrentByProvider")) return;
  const providerRules = rules.maxConcurrentByProvider;
  if (!providerRules || typeof providerRules !== "object" || Array.isArray(providerRules)) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentByProvider"], message: "Provider 并发必须是对象" });
    return;
  }
  for (const [provider, value] of Object.entries(providerRules as Record<string, unknown>)) {
    if (!isProviderKnown(provider) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
      const knownProvider = isProviderKnown(provider);
      ctx.addIssue({
        code: "custom",
        path: knownProvider ? ["maxConcurrentByProvider", provider] : ["maxConcurrentByProvider"],
        message: knownProvider ? `${provider} 必须是 0-1000 的整数` : UNKNOWN_PROVIDER_ERROR,
      });
    }
  }
});

export function parseConcurrencyRulesPatch(input: unknown): Record<string, unknown> {
  return RulesPatch.parse(input);
}

export function projectJobQuotaPatchExceedsGlobal(
  currentQuota: unknown,
  nextQuota: unknown,
  globalMaxJobsPerProject: number,
): boolean {
  return typeof nextQuota === "number"
    && nextQuota !== currentQuota
    && nextQuota > globalMaxJobsPerProject;
}

const GlobalRulesPatch = RulesPatch.superRefine((rules, ctx) => {
  if (Object.hasOwn(rules, "maxConcurrentJobs")) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentJobs"], message: "maxConcurrentJobs 只能在项目设置中配置" });
  }
});
const ProjectRulesPatch = RulesPatch.superRefine((rules, ctx) => {
  for (const key of GLOBAL_ONLY_RULE_KEYS) {
    if (Object.hasOwn(rules, key)) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 属于全局调度上限，不能在项目设置中修改` });
    }
  }
});


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
  };
}

const SettingsPatchBody = z.object({
  rules: ProjectRulesPatch.optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
  /** 真实设备接入（#495）项目级 opt-in；null = 清除（默认关）。 */
  device_access_enabled: z.boolean().nullable().optional(),
  /** 项目启用的 Agent CLI 白名单（组合积木）；Hub 只能从中提案。 */
  enabled_agent_clis: z.array(z.enum(["claude-code", "pi", "dsh"])).min(1).optional(),
  /** 项目启用的 Provider Credential 白名单。 */
  enabled_credential_ids: z.array(z.string().uuid()).optional(),
  /** Hub 省略时的软缺省 CLI（必须 ∈ 白名单）。 */
  default_agent_cli: z.enum(["claude-code", "pi", "dsh"]).nullable().optional(),
  /** Hub 省略时的软缺省 Provider（必须 ∈ 白名单）。 */
  default_credential_id: z.string().uuid().nullable().optional(),
  /** Hub/Scheduler soft default model paired with default_credential_id. */
  default_model_ref: z.string().trim().min(1).max(200).regex(/^\S+$/u).nullable().optional(),
  /** Ordered model fallback list paired with default_credential_id. */
  fallback_model_refs: z.array(z.string().trim().min(1).max(200).regex(/^\S+$/u)).max(16).optional(),
  /** Project opt-in for aliases outside the observed Provider catalog. */
  allow_model_catalog_passthrough: z.boolean().optional(),
});

async function validateProjectModelAllowlist(
  projectId: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const allowlist = parseProjectAgentAllowlist(cfg);
  const refs = [
    ...(allowlist.default_model_ref ? [allowlist.default_model_ref] : []),
    ...allowlist.fallback_model_refs,
  ];
  if (refs.length === 0 || !allowlist.default_credential_id) return;
  const [credential] = await sql`
    SELECT id, provider, model_catalog_json, model_catalog_fetched_at, settings_config_json, status, project_id, agent_cli
    FROM credentials
    WHERE id = ${allowlist.default_credential_id} AND kind = 'llm_provider'
    LIMIT 1`;
  if (!credential) throw new Error("缺省模型必须绑定已存在的 LLM Provider");
  if (credential.status !== "active") throw new Error("缺省模型 Provider 当前不可用");
  if (credential.project_id && credential.project_id !== projectId) {
    throw new Error("缺省模型 Provider 不属于当前项目");
  }
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
const GlobalSettingsPatchBody = z.object({
  rules: GlobalRulesPatch.optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
}).refine((body) => body.rules !== undefined || body.finding_protocol !== undefined, {
  message: "at least one global setting is required",
});
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
    // 迁移：首次读取时把当前 RoleConfig 绑定种子进白名单，避免旧项目静默不可派发。
    {
      const seed = await collectProjectIdentityBindings(sql as never, id);
      const seeded = seedProjectAgentAllowlist(cfg, seed);
      if (seeded.changed) {
        await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
      }
    }
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
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
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
          const global = await globalRules(sql);
          if (projectJobQuotaPatchExceedsGlobal(
            currentRules.maxConcurrentJobs,
            body.rules.maxConcurrentJobs,
            global.maxJobsPerProject,
          )) {
            return reply.code(400).send({
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
        if (!parseProjectAgentAllowlist(cfg).configured) {
          const seed = await collectProjectIdentityBindings(sql as never, id);
          seedProjectAgentAllowlist(cfg, seed);
        }
        applyProjectAgentAllowlistPatch(cfg, {
          enabled_agent_clis: body.enabled_agent_clis,
          enabled_credential_ids: body.enabled_credential_ids,
          default_agent_cli: body.default_agent_cli,
          default_credential_id: body.default_credential_id,
          default_model_ref: body.default_model_ref,
          fallback_model_refs: body.fallback_model_refs,
          allow_model_catalog_passthrough: body.allow_model_catalog_passthrough,
        });
        await validateProjectModelAllowlist(id, cfg);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid agent allowlist" });
      }
    }
    scrubStoredProjectImagePolicy(cfg);
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    let effectiveFindingProtocol;
    try {
      effectiveFindingProtocol = resolveFindingProtocol(globalProtocol, projectProtocol);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid finding protocol" });
    }
    await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
    await scrubIgnoredProjectRoleConfigIdentity(sql, id);
    // Project rule changes can alter effective task behavior; wake dispatch so
    // pending jobs do not wait for the next unrelated enqueue event.
    await sql`SELECT pg_notify('deepsonar_jobs', 'project-settings-updated')`;
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
