import {
  PlatformToolName,
  resolvePlatformTools,
  type PlatformToolConfig,
} from "@deepsonar/shared-types";
import {
  allowedModelIds,
  isProviderKnown,
  UNKNOWN_PROVIDER_ERROR,
  validateCredentialCompatibility,
} from "../../credentials.js";
import {
  extractModelFromSettings,
  extractReasoningFromSettings,
  hasProviderSettingsConfig,
  isProviderAgentCli,
  materializeProviderSettings,
} from "../../provider-settings.js";
import { resolveRuntimeImageForJob } from "../../runtime-images.js";
import { expandModules, type MissingModule } from "../../skill-sources.js";
import { normalizeRoleUiColor } from "../../role-colors.js";
import { sql } from "../../db.js";
import type {
  RoleRuntimeSnapshotApplication,
  RoleRuntimeSnapshotResult,
  RoleRuntimeSnapshotTransaction,
} from "./ports.js";

export type { RoleRuntimeSnapshotApplication, RoleRuntimeSnapshotResult, RoleRuntimeSnapshotTransaction } from "./ports.js";
export type AgentRuntimeSnapshot = RoleRuntimeSnapshotResult;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export const PLATFORM_DEFAULT_AGENT_CLI = "claude-code";
export const PLATFORM_DEFAULT_AGENT_MODEL: string | null = null;

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

  const [projectCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id = ${projectId}`) as Array<Record<string, unknown>>;
  const [globalCfg] = projectCfg
    ? [undefined]
    : (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id IS NULL`) as Array<Record<string, unknown>>;
  const cfg = (projectCfg ?? globalCfg) as Record<string, unknown> | undefined;
  const agentCli = typeof cfg?.agent_cli === "string" && cfg.agent_cli.trim() ? cfg.agent_cli.trim() : PLATFORM_DEFAULT_AGENT_CLI;

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
  const settingsConfig = llm?.settings_config_json;
  const hasSettings = hasProviderSettingsConfig(settingsConfig);
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
    if (!hasSettings) {
      const compatibilityError = validateCredentialCompatibility(agentCli, provider);
      if (compatibilityError) throw new Error(compatibilityError);
    }
    const credProject = (llm.cred_project_id as string | null) ?? null;
    if (cfg?.project_id != null && credProject && credProject !== projectId) throw new Error(`RoleConfig 引用了其他项目的 Credential ${llm.id}`);
    if (cfg?.project_id == null && credProject) throw new Error("全局 RoleConfig 只能绑定全局 Credential");
    if ((llm.status as string) !== "active") throw new Error(`Credential ${llm.id} 不可用（status=${String(llm.status)}）`);
    const configuredModel = typeof cfg?.model === "string" && cfg.model.trim()
      ? cfg.model.trim()
      : (hasSettings ? extractModelFromSettings(agentCli, settingsConfig) : null) ?? PLATFORM_DEFAULT_AGENT_MODEL;
    const allowed = allowedModelIds(llm.public_metadata_json);
    if (allowed.length > 0 && !configuredModel) throw new Error(`Credential ${llm.id} 已启用模型白名单，RoleConfig 必须显式选择模型`);
    if (configuredModel && allowed.length > 0 && !allowed.includes(configuredModel)) throw new Error(`模型 ${configuredModel} 不在 Credential ${llm.id} 的 allowed_model_ids 白名单`);
  }
  const manualConfigFiles = cfg
    ? await db`SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${cfg.id as string} ORDER BY path`
    : [];
  const roleModel = typeof cfg?.model === "string" && cfg.model.trim() ? cfg.model.trim() : null;
  const reasoningRaw = (cfg?.reasoning as string | null) ?? null;
  const roleReasoning: ReasoningEffort | null = reasoningRaw === "low" || reasoningRaw === "medium" || reasoningRaw === "high" || reasoningRaw === "xhigh" ? reasoningRaw : null;
  // CC Switch path: materialize saved settingsConfig into CLI config files.
  // Manual role_config_files remain as fallback when settingsConfig is empty.
  let configFiles: Array<{ path: string; content: string; content_sha256: string }> =
    manualConfigFiles as unknown as Array<{ path: string; content: string; content_sha256: string }>;
  let model: string | null = roleModel ?? PLATFORM_DEFAULT_AGENT_MODEL;
  let reasoning: ReasoningEffort | null = roleReasoning;
  if (hasSettings) {
    const materialized = materializeProviderSettings({
      agentCli,
      settingsConfig,
      overrides: {
        model: roleModel,
        reasoning: roleReasoning,
      },
    });
    if (materialized.length > 0) configFiles = materialized;
    if (!roleModel) model = extractModelFromSettings(agentCli, settingsConfig) ?? PLATFORM_DEFAULT_AGENT_MODEL;
    if (!roleReasoning) {
      const fromSettings = extractReasoningFromSettings(agentCli, settingsConfig);
      if (fromSettings === "low" || fromSettings === "medium" || fromSettings === "high" || fromSettings === "xhigh") {
        reasoning = fromSettings;
      }
    }
  }
  const roleKind = role.kind as "role" | "hub" | "system";
  const platformTools = resolvePlatformTools(roleName, roleKind, (cfg?.platform_tools_json as PlatformToolConfig | undefined) ?? {});
  const runtimeImageKey = (cfg?.runtime_image_key as string) ?? null;
  const runtimeImage = await resolveRuntimeImageForJob(db as never, projectId, roleName, runtimeImageKey);

  return {
    name: roleName,
    role_kind: roleKind,
    ui_color: roleKind === "role" ? normalizeRoleUiColor(role.ui_color) : null,
    agent_cli: agentCli,
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
    config_files: configFiles,
    role_config_id: (cfg?.id as string) ?? null,
    role_config_version: (cfg?.version as number) ?? null,
    runtime_image_key: runtimeImageKey,
    runtime_image: runtimeImage,
  };
}

export function createRoleRuntimeSnapshotApplication(): RoleRuntimeSnapshotApplication {
  return { resolveAgentSnapshotForJob };
}
