import {
  PlatformToolName,
  resolvePlatformTools,
  type PlatformToolConfig,
  type ReasoningValue,
} from "@deepsonar/shared-types";
import {
  allowedModelIds,
  isProviderKnown,
  UNKNOWN_PROVIDER_ERROR,
  validateCredentialCompatibility,
} from "../../credentials.js";
import {
  extractReasoningFromSettings,
  hasProviderSettingsConfig,
  isProviderAgentCli,
  materializeProviderSettings,
  providerSettingsForJobSnapshot,
  resolveContextWindowTokens,
  resolveEffectiveModel,
} from "../../provider-settings.js";
import { resolveRuntimeImageForJob } from "../../runtime-images.js";
import { expandModules, type MissingModule } from "../../skill-sources.js";
import { normalizeRoleUiColor } from "../../role-colors.js";
import { sql } from "../../db.js";
import { config } from "../../config.js";
import { freezeAgentCliRuntime, requireAgentCliRuntimeAdapter } from "@deepsonar/runtime-sandbox";
import { parseSandboxLimitsOverride, resolveEffectiveSandboxLimits } from "./sandbox-limits.js";
import type {
  RoleRuntimeSnapshotApplication,
  RoleRuntimeSnapshotResult,
  RoleRuntimeSnapshotTransaction,
} from "./ports.js";

export type { RoleRuntimeSnapshotApplication, RoleRuntimeSnapshotResult, RoleRuntimeSnapshotTransaction } from "./ports.js";
export type AgentRuntimeSnapshot = RoleRuntimeSnapshotResult;
export type ReasoningEffort = ReasoningValue;

export const PLATFORM_DEFAULT_AGENT_CLI = "claude-code";
export const PLATFORM_DEFAULT_AGENT_MODEL: string | null = null;

export const PROJECT_IMAGE_STRATEGIES = ["inherit_global", "project_managed"] as const;
export type ProjectImageStrategy = (typeof PROJECT_IMAGE_STRATEGIES)[number];
export interface ProjectImagePolicy {
  image_strategy: ProjectImageStrategy;
  role_runtime_images: Record<string, string | null>;
}

const RUNTIME_IMAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** 读取项目 JSON 中的镜像策略；缺省或脏值均安全回到全局继承。 */
export function parseProjectImagePolicy(value: unknown): ProjectImagePolicy {
  const configValue = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const strategy = PROJECT_IMAGE_STRATEGIES.includes(configValue.image_strategy as ProjectImageStrategy)
    ? configValue.image_strategy as ProjectImageStrategy
    : "inherit_global";
  const rawImages = configValue.role_runtime_images;
  const images: Array<[string, string | null]> = [];
  if (rawImages && typeof rawImages === "object" && !Array.isArray(rawImages)) {
    for (const [roleName, rawKey] of Object.entries(rawImages as Record<string, unknown>)) {
      if (rawKey === null) {
        images.push([roleName, null]);
        continue;
      }
      if (typeof rawKey === "string") {
        const key = rawKey.trim();
        if (RUNTIME_IMAGE_KEY_PATTERN.test(key)) images.push([roleName, key]);
      }
    }
  }
  return { image_strategy: strategy, role_runtime_images: Object.fromEntries(images) };
}

/** 选择 Job 实际使用的镜像 key；项目托管缺省固定为系统 Base。 */
export function runtimeImageKeyForProjectPolicy(
  policy: ProjectImagePolicy,
  roleName: string,
  globalRuntimeImageKey: string | null,
): string | null {
  if (policy.image_strategy === "project_managed") {
    return Object.prototype.hasOwnProperty.call(policy.role_runtime_images, roleName)
      ? policy.role_runtime_images[roleName] ?? "deepsonar-base"
      : "deepsonar-base";
  }
  return globalRuntimeImageKey;
}

let legacyAgentDefaultsWarningEmitted = false;
function warnIgnoredLegacyAgentDefaults(): void {
  if (legacyAgentDefaultsWarningEmitted) return;
  const hasLegacyValues = ["AGENT_PROVIDER", "AGENT_MODEL"].some((name) => process.env[name] !== undefined);
  if (!hasLegacyValues) return;
  legacyAgentDefaultsWarningEmitted = true;
  console.warn("[role-config] legacy AGENT_PROVIDER/AGENT_MODEL are ignored; configure agent_cli/model/env_vars in RoleConfig");
}

export function roleNameForJobType(jobType: string): string {
  if (jobType === "audit_module") return "audit";
  if (jobType === "verify_finding") return "verify";
  if (jobType === "report") return "report";
  return jobType;
}

export const RUNTIME_TEST_TOOLCHAIN_POLICY = `### Runtime test toolchain (Scheduler policy)

This Job uses a Scheduler-selected, trusted runtime image. Before testing, read the frozen runtime manifest and verify only the preinstalled tools required by the target language: Java uses "command -v java" and "java -version"; Maven projects additionally use "command -v mvn" and "mvn -v" (and the versioned "java8"/"java11"/"java17" commands when required); Python uses the required "python3.x"/"uv" commands; Go uses "command -v go" and "go version"; Rust uses "command -v rustc"/"rustc --version" and "command -v cargo"/"cargo --version".

- Do **not** install or download JDK, Maven, Gradle, SDKMAN, or compiler toolchains in the sandbox. Do not use apt-get, curl/wget archives, ./mvnw, or equivalent bootstrap fallbacks for those tools.
- Project dependencies may be fetched only when the frozen DEEPSONAR_ALLOW_EGRESS policy permits it; dependency downloads are not a substitute for the prebuilt toolchain.
- If a required preinstalled command is missing, stop the dynamic attempt and submit structured inconclusive/needs-human evidence. Never claim a confirmed Finding from a static description alone.
- Record the runtime image key/digest, tool versions, target revision, exact steps, expected result, actual result, and limitations in emit_fact.verification for runtime-test evidence.`;

export function withRuntimeTestToolchainPolicy(
  roleName: string,
  instructions: string | null,
  resolvedRuntimeImageKey: string | null,
): string | null {
  const dynamicVerify = roleName === "verify" && resolvedRuntimeImageKey !== null && resolvedRuntimeImageKey !== "deepsonar-base";
  if (roleName !== "test" && !dynamicVerify) return instructions;
  const base = instructions?.trim() ?? "";
  if (base.includes("### Runtime test toolchain (Scheduler policy)")) return base;
  return `${base}${base ? "\n\n" : ""}${RUNTIME_TEST_TOOLCHAIN_POLICY}`;
}

/** The complete frozen runtime input consumed by Dispatcher/Executor. */
export async function resolveAgentSnapshotForJob(
  db: RoleRuntimeSnapshotTransaction = sql as unknown as RoleRuntimeSnapshotTransaction,
  projectId: string,
  jobType: string,
): Promise<RoleRuntimeSnapshotResult> {
  warnIgnoredLegacyAgentDefaults();
  const roleName = roleNameForJobType(jobType);
  const [role] = (await db`SELECT id, name, description, kind, ui_color FROM agent_roles WHERE name = ${roleName}`) as Array<Record<string, unknown>>;
  if (!role) throw new Error(`未注册的 Agent 角色: ${roleName}`);

  const [project] = (await db`SELECT config_json FROM projects WHERE id = ${projectId}`) as Array<Record<string, unknown>>;
  const projectImagePolicy = parseProjectImagePolicy(project?.config_json);
  const [projectCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id = ${projectId}`) as Array<Record<string, unknown>>;
  const [globalCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id IS NULL`) as Array<Record<string, unknown>>;
  const cfg = (projectCfg ?? globalCfg) as Record<string, unknown> | undefined;
  const agentCli = typeof cfg?.agent_cli === "string" && cfg.agent_cli.trim() ? cfg.agent_cli.trim() : PLATFORM_DEFAULT_AGENT_CLI;
  const dshTaskMode = cfg?.dsh_task_mode === "ptc" ? "ptc" : "standard";

  const rawModules = cfg?.modules_json;
  if (rawModules != null && !Array.isArray(rawModules)) throw new Error("RoleConfig.modules_json 必须是字符串数组");
  const modules = (rawModules as string[] | undefined) ?? [];
  const manualSkills = (cfg?.skills_json as { name?: string }[]) ?? [];
  const manualCommands = (cfg?.commands_json as { name?: string }[]) ?? [];
  const expanded = await expandModules(modules, db as never, {
    skill_names: manualSkills.map((skill) => skill.name ?? ""),
    command_names: manualCommands.map((command) => command.name ?? ""),
  });
  if (expanded.missing.length > 0) console.warn(`[role-config] 模块未下发: ${expanded.missing.join(", ")}`);
  const skills = [...manualSkills, ...expanded.skills.filter((s) => !manualSkills.some((m) => m.name === (s as { name?: string }).name))];
  const commands = [...manualCommands, ...expanded.commands.filter((c) => !manualCommands.some((m) => m.name === (c as { name?: string }).name))];

  const [llm] = (cfg
    ? await db`
        SELECT c.id, c.name, c.provider, c.status, c.project_id AS cred_project_id,
               c.public_metadata_json, c.agent_cli, c.settings_config_json, c.meta_json
        FROM role_credentials rc
        JOIN credentials c ON c.id = rc.credential_id
        WHERE rc.role_config_id = ${cfg.id as string} AND rc.purpose = 'llm'
        LIMIT 1
        FOR SHARE OF c`
    : [undefined]) as Array<Record<string, unknown> | undefined>;
  const settingsConfig = llm?.settings_config_json ?? {};
  const hasSettings = hasProviderSettingsConfig(settingsConfig);
  const snapshotSettingsConfig = providerSettingsForJobSnapshot(settingsConfig, agentCli);
  const contextWindowTokens = resolveContextWindowTokens({ roleContextWindowTokens: cfg?.context_window_tokens, settingsConfig: snapshotSettingsConfig });
  if (llm) {
    const provider = String(llm.provider ?? "");
    if (!isProviderKnown(provider)) throw new Error(UNKNOWN_PROVIDER_ERROR);
    // When a full settingsConfig profile is present, agent_cli on the credential
    // (if set) must match the RoleConfig CLI; brand compatibility still applies
    // as a soft gate for legacy rows without settingsConfig.
    const profileCli = llm.agent_cli;
    if (hasSettings && isProviderAgentCli(profileCli) && profileCli !== agentCli) {
      throw new Error(`Credential ${llm.id} 绑定 agent_cli=${profileCli}，与角色 ${agentCli} 不匹配`);
    }
    const compatibilityError = validateCredentialCompatibility(agentCli, provider);
    if (compatibilityError) throw new Error(compatibilityError);
    const credProject = (llm.cred_project_id as string | null) ?? null;
    if (cfg?.project_id != null && credProject && credProject !== projectId) throw new Error(`RoleConfig 引用了其他项目的 Credential ${llm.id}`);
    if (cfg?.project_id == null && credProject) throw new Error("全局 RoleConfig 只能绑定全局 Credential");
    if ((llm.status as string) !== "active") throw new Error(`Credential ${llm.id} 不可用（status=${String(llm.status)}）`);
    const configuredModel = resolveEffectiveModel({
      roleModel: typeof cfg?.model === "string" ? cfg.model : null,
      agentCli,
      settingsConfig: snapshotSettingsConfig,
    }) ?? PLATFORM_DEFAULT_AGENT_MODEL;
    const allowed = allowedModelIds(llm.public_metadata_json);
    if (allowed.length > 0 && !configuredModel) throw new Error(`Credential ${llm.id} 已启用模型白名单，但配置文件未声明模型且 RoleConfig 未提供覆盖`);
    if (configuredModel && allowed.length > 0 && !allowed.includes(configuredModel)) throw new Error(`模型 ${configuredModel} 不在 Credential ${llm.id} 的 allowed_model_ids 白名单`);
  }
  const manualConfigFiles = cfg
    ? await db`SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${cfg.id as string} ORDER BY path`
    : [];
  const roleModel = typeof cfg?.model === "string" && cfg.model.trim() ? cfg.model.trim() : null;
  const providerReasoning: ReasoningEffort | null = hasSettings
    ? extractReasoningFromSettings(agentCli, snapshotSettingsConfig)
    : null;
  // CC Switch path: materialize saved settingsConfig into CLI config files.
  // Manual role_config_files remain as fallback when settingsConfig is empty.
  let configFiles: Array<{ path: string; content: string; content_sha256: string }> =
    manualConfigFiles as unknown as Array<{ path: string; content: string; content_sha256: string }>;
  let model: string | null = roleModel ?? PLATFORM_DEFAULT_AGENT_MODEL;
  const reasoning: ReasoningEffort | null = providerReasoning;
  if (hasSettings) {
    const materialized = materializeProviderSettings({
      agentCli,
      settingsConfig: snapshotSettingsConfig,
      overrides: { model: roleModel, reasoning: providerReasoning, context_window_tokens: contextWindowTokens },
    });
    if (materialized.length > 0) {
      const materializedPaths = new Set(materialized.map((item) => item.path));
      configFiles = agentCli === "pi"
        ? [...materialized, ...((manualConfigFiles as unknown as Array<{ path: string; content: string; content_sha256: string }>).filter((item) => !materializedPaths.has(item.path)))]
        : materialized;
    }
    if (!roleModel) model = resolveEffectiveModel({ roleModel: null, agentCli, settingsConfig: snapshotSettingsConfig }) ?? PLATFORM_DEFAULT_AGENT_MODEL;
  }
  const roleKind = role.kind as "role" | "hub" | "system";
  const platformTools = resolvePlatformTools(roleName, roleKind, (cfg?.platform_tools_json as PlatformToolConfig | undefined) ?? {});
  const globalRuntimeImageKey = typeof globalCfg?.runtime_image_key === "string" && globalCfg.runtime_image_key.trim()
    ? globalCfg.runtime_image_key.trim()
    : null;
  const runtimeImageKey = runtimeImageKeyForProjectPolicy(projectImagePolicy, roleName, globalRuntimeImageKey);
  const runtimeImage = await resolveRuntimeImageForJob(db as never, projectId, roleName, runtimeImageKey);
  const runtimeAdapter = requireAgentCliRuntimeAdapter(agentCli, runtimeImage.image_key);
  const sandboxOverride = parseSandboxLimitsOverride(cfg?.sandbox_limits_json);
  if (!cfg?.project_id && Object.keys(sandboxOverride).length > 0) {
    throw new Error("global RoleConfig cannot set sandbox resource overrides");
  }
  const sandboxLimits = resolveEffectiveSandboxLimits(sandboxOverride, config.runtime.sandboxLimits);

  return {
    name: roleName,
    role_kind: roleKind,
    ui_color: roleKind === "role" ? normalizeRoleUiColor(role.ui_color) : null,
    agent_cli: agentCli,
    dsh_task_mode: dshTaskMode,
    agent_runtime: freezeAgentCliRuntime(runtimeAdapter),
    model,
    reasoning,
    env_vars: cfg?.env_vars_json && typeof cfg.env_vars_json === "object" ? cfg.env_vars_json as Record<string, string> : {},
    env_keys: (cfg?.env_keys as string[]) ?? [],
    credential_id: (llm?.id as string) ?? null,
    credential_name: (llm?.name as string) ?? null,
    credential_provider: (llm?.provider as string) ?? null,
    modules,
    module_selectors: [...modules],
    expanded_modules: expanded.resolved_modules,
    missing_modules: expanded.missing_modules as MissingModule[],
    module_content_hash: expanded.content_hash,
    skill_revisions: expanded.revisions,
    skills,
    commands,
    mcps: (cfg?.mcps_json as unknown[]) ?? [],
    subagents: (cfg?.subagents_json as unknown[]) ?? [],
    role_description: (role.description as string) ?? roleName,
    instructions_markdown: withRuntimeTestToolchainPolicy(roleName, (cfg?.instructions_markdown as string) ?? null, runtimeImage.image_key),
    platform_tools: platformTools as PlatformToolName[],
    context_window_tokens: contextWindowTokens,
    settings_config_json: snapshotSettingsConfig,
    config_files: configFiles,
    role_config_id: (cfg?.id as string) ?? null,
    role_config_version: (cfg?.version as number) ?? null,
    runtime_image_key: runtimeImageKey,
    runtime_image: runtimeImage,
    sandbox_limits: sandboxLimits,
  };
}

export function createRoleRuntimeSnapshotApplication(): RoleRuntimeSnapshotApplication {
  return { resolveAgentSnapshotForJob };
}
