import type { FastifyInstance } from "fastify";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { isProviderKnown, projectCredentialProvider, UNKNOWN_PROVIDER_ERROR } from "../../credentials.js";
import { globalRules, mergeGlobalRulesPatch, PLATFORM_DEFAULT_AGENT_CLI, rulesForProject } from "../../core.js";
import { sql } from "../../db.js";
import { loadReadiness, type ReadinessMaterialSource } from "../../readiness.js";
import { resolveRuntimeImageForJob } from "../../runtime-images.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import {
  parseProjectImagePolicy,
  PROJECT_IMAGE_STRATEGIES,
} from "../role-runtime-snapshot/application.js";

const RULE_CONCURRENCY_KEYS = new Set(["maxGlobalJobs", "maxJobsPerProject"]);
const CLI_CONCURRENCY_KEYS = new Set(["claude-code", "codex", "open-code", "pi", "dsh"]);
const RulesPatch = z.record(z.string(), z.unknown()).superRefine((rules, ctx) => {
  for (const key of RULE_CONCURRENCY_KEYS) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 必须是 1-1000 的整数` });
    }
  }
  if (Object.prototype.hasOwnProperty.call(rules, "maxConcurrentByAgentCli")) {
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
  if (!Object.prototype.hasOwnProperty.call(rules, "maxConcurrentByProvider")) return;
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

const SettingsPatchBody = z.object({
  rules: RulesPatch.optional(),
  roles: z.object({ enabled: z.array(z.string()).nullable() }).optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
  image_strategy: z.enum(PROJECT_IMAGE_STRATEGIES).optional(),
  role_runtime_images: z.record(
    z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
    z.string().trim().regex(/^[a-z][a-z0-9-]{1,62}$/).nullable(),
  ).optional(),
});
const GlobalSettingsPatchBody = z.object({
  rules: RulesPatch.optional(),
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

async function validateProjectRuntimeImages(
  projectId: string,
  selections: Record<string, string | null>,
): Promise<void> {
  const roleNames = Object.keys(selections);
  if (roleNames.length === 0) return;
  const roles = await sql`SELECT name FROM agent_roles WHERE name = ANY(${roleNames})`;
  const knownRoles = new Set(roles.map((role) => String(role.name)));
  const unknownRole = roleNames.find((name) => !knownRoles.has(name));
  if (unknownRole) throw new Error(`role_runtime_images 包含未注册角色: ${unknownRole}`);

  for (const [roleName, imageKey] of Object.entries(selections)) {
    if (imageKey === null) continue;
    const [image] = await sql`
      SELECT ri.id, ri.official, ri.project_opt_in, ri.enabled,
             EXISTS (
               SELECT 1 FROM runtime_image_versions v
               WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted'
             ) AS has_trusted,
             pri.enabled AS project_enabled
      FROM runtime_images ri
      LEFT JOIN project_runtime_images pri
        ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
      WHERE ri.image_key = ${imageKey}`;
    if (!image || image.enabled !== true) throw new Error(`runtime_image_key 不存在或已禁用: ${imageKey}`);
    const fakeOfficialCatalogImage = config.runtime.agentMode === "fake" && image.official === true;
    if (image.has_trusted !== true && !fakeOfficialCatalogImage) {
      throw new Error(`runtime_image_key 没有可信版本: ${imageKey}`);
    }
    if (image.official !== true && image.project_enabled !== true) {
      throw new Error(`第三方镜像必须先在目标项目显式启用: ${imageKey}`);
    }
    await resolveRuntimeImageForJob(sql, projectId, roleName, imageKey);
  }
}

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
    const storedRules = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
    const findingProtocol = parseStoredFindingProtocolConfig(storedRules.finding_protocol);
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: storedRules,
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
          ...(body.finding_protocol !== undefined ? ["finding_protocol"] : []),
        ],
      },
    });
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: merged,
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
    const imagePolicy = parseProjectImagePolicy(cfg);
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    return {
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: resolveFindingProtocol(globalProtocol, projectProtocol),
      image_strategy: imagePolicy.image_strategy,
      role_runtime_images: imagePolicy.role_runtime_images,
    };
  });

  app.patch("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    let body: z.infer<typeof SettingsPatchBody>;
    try {
      body = SettingsPatchBody.parse(req.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid project settings rules", details: error instanceof z.ZodError ? error.issues : undefined });
    }
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    const currentImagePolicy = parseProjectImagePolicy(cfg);
    const nextImageStrategy = body.image_strategy ?? currentImagePolicy.image_strategy;
    if (body.role_runtime_images !== undefined && nextImageStrategy !== "project_managed") {
      return reply.code(400).send({ error: "仅 project_managed 策略可设置 role_runtime_images" });
    }
    if (body.role_runtime_images !== undefined) {
      try {
        await validateProjectRuntimeImages(id, body.role_runtime_images);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid project runtime images" });
      }
    }
    if (body.rules) {
      cfg.rules = { ...((cfg.rules as Record<string, unknown>) ?? {}), ...body.rules };
    }
    if (body.roles) {
      const roles = { ...((cfg.roles as Record<string, unknown>) ?? {}) };
      if (body.roles.enabled === null) delete roles.enabled; // null = 恢复默认（全部内置）
      else if (body.roles.enabled !== undefined) roles.enabled = body.roles.enabled;
      cfg.roles = roles;
    }
    if (body.finding_protocol !== undefined) {
      if (body.finding_protocol === null) delete cfg.finding_protocol;
      else cfg.finding_protocol = body.finding_protocol;
    }
    if (body.image_strategy !== undefined) {
      cfg.image_strategy = body.image_strategy;
      if (body.image_strategy === "inherit_global") delete cfg.role_runtime_images;
    }
    if (body.role_runtime_images !== undefined) cfg.role_runtime_images = body.role_runtime_images;
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    const imagePolicy = parseProjectImagePolicy(cfg);
    let effectiveFindingProtocol;
    try {
      effectiveFindingProtocol = resolveFindingProtocol(globalProtocol, projectProtocol);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid finding protocol" });
    }
    await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
    // Project rule changes can alter effective task behavior; wake dispatch so
    // pending jobs do not wait for the next unrelated enqueue event.
    await sql`SELECT pg_notify('deepsonar_jobs', 'project-settings-updated')`;
    // 项目级 rules 覆盖 / roles 启停都属配置修改
    await audit(req, {
      action: "settings.project_update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      after: { changed: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) },
    });
    return {
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: effectiveFindingProtocol,
      image_strategy: imagePolicy.image_strategy,
      role_runtime_images: imagePolicy.role_runtime_images,
    };
  });
}
