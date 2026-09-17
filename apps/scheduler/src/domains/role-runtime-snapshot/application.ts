import {
  PlatformToolName,
  rejectNonCurrentAgentCli,
  resolvePlatformTools,
  type PlatformToolConfig,
  type ReasoningValue,
} from "@deepsonar/shared-types";
import {
  isProviderKnown,
  UNKNOWN_PROVIDER_ERROR,
  validateCredentialCompatibility,
} from "../../credentials.js";
import {
  assertResolvedModelInCredentialCatalog,
  hasProviderSettingsConfig,
  projectProviderRuntimeSnapshot,
  resolveModelSource,
  snapshotUpstreamModel,
} from "../../provider-settings.js";
import { isOfficialRuntimeImageKey, resolveRuntimeImageForJob } from "../../runtime-images.js";
import { freezeTaskCapabilityPack } from "../capability-pack/index.js";
import { expandModules, type MissingModule } from "../../skill-sources.js";
import { normalizeRoleUiColor } from "../../role-colors.js";
import { sql } from "../../db.js";
import { config } from "../../config.js";
import { freezeAgentCliRuntime, requireAgentCliRuntimeAdapter } from "@deepsonar/runtime-sandbox";
import { parseSandboxLimitsOverride, resolveEffectiveSandboxLimits } from "./sandbox-limits.js";
import {
  appendPolicyBlock,
  specialtyPolicyForImageKey as lookupSpecialtyPolicy,
} from "./runtime-image-boundary-policy.js";
export {
  OPENHARMONY_HDC_POLICY,
  MOBILE_RUNTIME_POLICY,
  CHROME_TEST_RUNTIME_POLICY,
  CHROME_AUDIT_RUNTIME_POLICY,
  CHROME_FUZZ_RUNTIME_POLICY,
  CLICKHOUSE_TEST_RUNTIME_POLICY,
  CLICKHOUSE_AUDIT_RUNTIME_POLICY,
  CLICKHOUSE_FUZZ_RUNTIME_POLICY,
  OPENHARMONY_AUDIT_RUNTIME_POLICY,
  OPENHARMONY_FUZZ_RUNTIME_POLICY,
  SPECIALTY_RUNTIME_IMAGE_POLICIES,
  specialtyPolicyForImageKey,
} from "./runtime-image-boundary-policy.js";
import { freezePiExtensions } from "../../pi-extensions.js";
import { parseRuntimeKnobOverride } from "../../runtime-knobs.js";
import {
  assertAgentCliAllowlisted,
  assertCredentialAllowlisted,
  parseProjectAgentAllowlist,
} from "../project-agent-allowlist/index.js";
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
export const SNAPSHOT_STALE = "SNAPSHOT_STALE" as const;

export const PROJECT_IMAGE_STRATEGIES = ["inherit_global", "project_managed"] as const;
export type ProjectImageStrategy = (typeof PROJECT_IMAGE_STRATEGIES)[number];
export interface ProjectImagePolicy {
  image_strategy: ProjectImageStrategy;
  role_runtime_images: Record<string, string | null>;
}

const RUNTIME_IMAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** 读取项目 JSON 中的镜像策略；缺省 inherit_global。脏值由启动清扫删除，解析层暂按 inherit_global 以免中断已排队 Job。 */
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

/** inherit_global 不保留 role_runtime_images；未知 image_strategy 物理删除。 */
export function scrubStoredProjectImagePolicy(cfg: Record<string, unknown>): boolean {
  let changed = false;
  if (
    Object.prototype.hasOwnProperty.call(cfg, "image_strategy")
    && !PROJECT_IMAGE_STRATEGIES.includes(cfg.image_strategy as ProjectImageStrategy)
  ) {
    delete cfg.image_strategy;
    changed = true;
  }
  const strategy = cfg.image_strategy === "project_managed" ? "project_managed" : "inherit_global";
  if (strategy === "inherit_global" && Object.prototype.hasOwnProperty.call(cfg, "role_runtime_images")) {
    delete cfg.role_runtime_images;
    changed = true;
  }
  return changed;
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

function trimmedRoleField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * inherit_global（缺省 / 脏值）忽略遗留项目 RoleConfig 的 model 与默认 CLI；
 * 只有 project_managed 才采用项目身份字段。解析层仍作纵深，历史行由
 * `scrubIgnoredProjectRoleConfigIdentity` 物理清空。
 */
export function roleIdentityForProjectPolicy(
  policy: ProjectImagePolicy,
  projectCfg: { model?: unknown; agent_cli?: unknown } | undefined,
  globalCfg: { model?: unknown; agent_cli?: unknown } | undefined,
): { model: string | null; agent_cli: string } {
  const identityCfg = policy.image_strategy === "project_managed"
    ? (projectCfg ?? globalCfg)
    : globalCfg;
  return {
    model: trimmedRoleField(identityCfg?.model),
    agent_cli: trimmedRoleField(identityCfg?.agent_cli) ?? PLATFORM_DEFAULT_AGENT_CLI,
  };
}

/** inherit_global 项目 RoleConfig 不落库 model；只有 project_managed 才持久化。 */
export function persistableProjectRoleConfigModel(
  policy: ProjectImagePolicy,
  requestedModel: unknown,
): string | null {
  if (policy.image_strategy !== "project_managed") return null;
  return trimmedRoleField(requestedModel);
}

/**
 * 物理清空解析层已忽略的项目 RoleConfig 身份字段。
 * 不 bump version：这些列本来就不进 inherit_global 快照。
 */
type RoleConfigScrubDb = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export async function scrubIgnoredProjectRoleConfigIdentity(
  db: RoleConfigScrubDb,
  projectId?: string,
): Promise<{ runtime_image_keys: number; inherit_global_models: number }> {
  const images = await Promise.resolve(projectId
    ? db`
        UPDATE role_configs
        SET runtime_image_key = NULL
        WHERE project_id = ${projectId}
          AND runtime_image_key IS NOT NULL
        RETURNING id`
    : db`
        UPDATE role_configs
        SET runtime_image_key = NULL
        WHERE project_id IS NOT NULL
          AND runtime_image_key IS NOT NULL
        RETURNING id`) as unknown[];
  const models = await Promise.resolve(projectId
    ? db`
        UPDATE role_configs rc
        SET model = NULL
        FROM projects p
        WHERE rc.project_id = p.id
          AND p.id = ${projectId}
          AND rc.model IS NOT NULL
          AND COALESCE(p.config_json->>'image_strategy', 'inherit_global') IS DISTINCT FROM 'project_managed'
        RETURNING rc.id`
    : db`
        UPDATE role_configs rc
        SET model = NULL
        FROM projects p
        WHERE rc.project_id = p.id
          AND rc.model IS NOT NULL
          AND COALESCE(p.config_json->>'image_strategy', 'inherit_global') IS DISTINCT FROM 'project_managed'
        RETURNING rc.id`) as unknown[];
  return { runtime_image_keys: images.length, inherit_global_models: models.length };
}

export function roleNameForJobType(jobType: string): string {
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

/** #588: every official runtime image ships offline tool manuals. */
export const RUNTIME_TOOL_MANUALS_POLICY = `### Runtime tool manuals (Scheduler policy)

This Job's runtime image includes offline tool manuals at \`/opt/deepsonar/manuals/\`.

- Start with \`/opt/deepsonar/manuals/index.json\` (or its readable \`INDEX.md\` projection), then open only the relevant \`tools/*.md\` pages for the task.
- Manuals cover when to use / when not, prerequisites, invocation, output meaning, failure classes, composition, evidence retention, and version limits.
- Do not rely on host-repo docs or guessed \`--help\` alone. Prefer manuals before first invocation of an unfamiliar tool.
- The manual does not grant tools, network access, credentials, devices, Job operations, budget, or side-effect permissions; the frozen Job snapshot and Scheduler remain authoritative.
- Empty results are not automatic \`needs_human\`; missing devices/services must be labeled inconclusive/needs_human without fabricating runtime output.`;

export function withRuntimeTestToolchainPolicy(
  roleName: string,
  instructions: string | null,
  resolvedRuntimeImageKey: string | null,
): string | null {
  const dynamicVerify = roleName === "verify" && resolvedRuntimeImageKey !== null && resolvedRuntimeImageKey !== "deepsonar-base";
  const injectRuntimeTest = roleName === "test" || dynamicVerify;
  const specialty = lookupSpecialtyPolicy(resolvedRuntimeImageKey);
  const injectManuals = isOfficialRuntimeImageKey(resolvedRuntimeImageKey);
  if (!injectRuntimeTest && !specialty && !injectManuals) return instructions;

  let text = instructions?.trim() ?? "";
  // Manuals stay first so agents read INDEX.md before toolchain/specialty blocks.
  if (injectManuals && !text.includes("### Runtime tool manuals (Scheduler policy)")) {
    text = text ? `${RUNTIME_TOOL_MANUALS_POLICY}

${text}` : RUNTIME_TOOL_MANUALS_POLICY;
  }
  if (injectRuntimeTest) {
    text = appendPolicyBlock(text, "### Runtime test toolchain (Scheduler policy)", RUNTIME_TEST_TOOLCHAIN_POLICY);
  }
  if (specialty) {
    text = appendPolicyBlock(text, specialty.marker, specialty.body);
  }
  return text;
}

/** Current RoleConfig/Credential/runtime identity cannot be frozen into a Job snapshot. */
export class SnapshotUnresolvableError extends Error {
  readonly stale_fields = ["current_snapshot_unresolvable"] as const;
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 500) || "current snapshot resolution failed");
    this.name = "SnapshotUnresolvableError";
  }
}

async function resolveAgentSnapshotForJobUnchecked(
  db: RoleRuntimeSnapshotTransaction,
  projectId: string,
  jobType: string,
  options?: { runtimeImageKey?: string | null; agentCli?: string | null; credentialId?: string | null },
): Promise<RoleRuntimeSnapshotResult> {
  const roleName = roleNameForJobType(jobType);
  const [role] = (await db`SELECT id, name, description, kind, ui_color FROM agent_roles WHERE name = ${roleName}`) as Array<Record<string, unknown>>;
  if (!role) throw new Error(`未注册的 Agent 角色: ${roleName}`);

  const [project] = (await db`SELECT config_json FROM projects WHERE id = ${projectId}`) as Array<Record<string, unknown>>;
  const projectImagePolicy = parseProjectImagePolicy(project?.config_json);
  const agentAllowlist = parseProjectAgentAllowlist(project?.config_json);
  const [projectCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id = ${projectId}`) as Array<Record<string, unknown>>;
  const [globalCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id IS NULL`) as Array<Record<string, unknown>>;
  // Modules / bindings can still come from a leftover project row; model and
  // default CLI follow image policy so inherit_global cannot steal identity.
  // Hub 提案 > 项目软缺省 > RoleConfig：角色不是唯一绑定面。
  const cfg = (projectCfg ?? globalCfg) as Record<string, unknown> | undefined;
  const identity = roleIdentityForProjectPolicy(projectImagePolicy, projectCfg, globalCfg);
  const hubCli = typeof options?.agentCli === "string" && options.agentCli.trim() ? options.agentCli.trim() : null;
  const agentCli = hubCli
    ?? agentAllowlist.default_agent_cli
    ?? identity.agent_cli;
  assertAgentCliAllowlisted(agentAllowlist, agentCli);
  const leftoverCli = rejectNonCurrentAgentCli(agentCli);
  if (leftoverCli) throw new Error(leftoverCli);
  const dshTaskMode = cfg?.dsh_task_mode === "ptc" ? "ptc" : "standard";

  const rawModules = cfg?.modules_json;
  if (rawModules != null && !Array.isArray(rawModules)) {
    throw new Error("RoleConfig.modules_json 必须是字符串数组");
  }
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

  const hubCredentialId = typeof options?.credentialId === "string" && options.credentialId.trim()
    ? options.credentialId.trim()
    : null;
  const preferredCredentialId = hubCredentialId ?? agentAllowlist.default_credential_id;
  let llm: Record<string, unknown> | undefined;
  if (preferredCredentialId) {
    const [row] = await db`
      SELECT c.id, c.name, c.provider, c.status, c.project_id AS cred_project_id,
             c.public_metadata_json, c.agent_cli, c.settings_config_json, c.meta_json
      FROM credentials c
      WHERE c.id = ${preferredCredentialId} AND c.kind = 'llm_provider'
      LIMIT 1
      FOR SHARE OF c` as Array<Record<string, unknown>>;
    llm = row;
    if (!llm) throw new Error(`Credential ${preferredCredentialId} 不存在`);
  } else if (cfg) {
    const [row] = await db`
        SELECT c.id, c.name, c.provider, c.status, c.project_id AS cred_project_id,
               c.public_metadata_json, c.agent_cli, c.settings_config_json, c.meta_json,
               c.model_catalog_json
        FROM role_credentials rc
        JOIN credentials c ON c.id = rc.credential_id
        WHERE rc.role_config_id = ${cfg.id as string} AND rc.purpose = 'llm'
        LIMIT 1
        FOR SHARE OF c` as Array<Record<string, unknown>>;
    llm = row;
  }
  assertCredentialAllowlisted(agentAllowlist, (llm?.id as string | undefined) ?? preferredCredentialId);
  const settingsConfig = llm?.settings_config_json ?? {};
  const hasSettings = hasProviderSettingsConfig(settingsConfig);
  const manualConfigFiles = cfg
    ? await db`SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${cfg.id as string} ORDER BY path`
    : [];
  const providerSnapshot = projectProviderRuntimeSnapshot({
    agentCli,
    roleModel: identity.model,
    roleContextWindowTokens: cfg?.context_window_tokens,
    settingsConfig,
    manualConfigFiles: manualConfigFiles as unknown as Array<{ path: string; content: string; content_sha256: string }>,
    defaultModel: PLATFORM_DEFAULT_AGENT_MODEL,
  });
  const snapshotSettingsConfig = providerSnapshot.settings_config_json;
  const contextWindowTokens = providerSnapshot.context_window_tokens;
  if (llm) {
    const rolePassthrough = cfg?.allow_model_catalog_passthrough === true;
    const allowPassthrough = config.allowModelCatalogPassthrough || rolePassthrough;
    const modelSource = resolveModelSource({
      roleModel: identity.model,
      agentCli,
      settingsConfig,
    });
    assertResolvedModelInCredentialCatalog({
      resolvedModel: snapshotUpstreamModel(providerSnapshot) ?? providerSnapshot.model,
      catalogJson: llm.model_catalog_json,
      allowPassthrough,
      modelSource,
    });
    const provider = String(llm.provider ?? "");
    if (!isProviderKnown(provider)) throw new Error(UNKNOWN_PROVIDER_ERROR);
    // Credential.agent_cli is a hint. A full settingsConfig profile may serve
    // every CLI the provider matrix allows; Job identity follows RoleConfig.
    const profileCli = typeof llm.agent_cli === "string" ? llm.agent_cli : null;
    if (hasSettings && profileCli && profileCli !== agentCli) {
      console.warn(`[role-config] Credential ${llm.id} agent_cli=${profileCli} 与角色 ${agentCli} 不一致，已按角色配置解析`);
    }
    const compatibilityError = validateCredentialCompatibility(agentCli, provider);
    if (compatibilityError) throw new Error(compatibilityError);
    const credProject = (llm.cred_project_id as string | null) ?? null;
    // Hub / 项目软缺省可选项目或全局凭据；仅 RoleConfig 绑定路径仍限制全局配置只能绑全局凭据。
    if (preferredCredentialId) {
      if (credProject && credProject !== projectId) {
        throw new Error(`Credential ${llm.id} 属于其他项目，不能用于本项目 Job`);
      }
    } else {
      if (cfg?.project_id != null && credProject && credProject !== projectId) {
        throw new Error(`RoleConfig 引用了其他项目的 Credential ${llm.id}`);
      }
      if (cfg?.project_id == null && credProject) throw new Error("全局 RoleConfig 只能绑定全局 Credential");
    }
    if ((llm.status as string) !== "active") {
      throw new Error(`Credential ${llm.id} 不可用（status=${String(llm.status)}）`);
    }
  }
  const roleKind = role.kind as "role" | "hub" | "system";
  const platformTools = resolvePlatformTools(roleName, roleKind, (cfg?.platform_tools_json as PlatformToolConfig | undefined) ?? {});
  const globalRuntimeImageKey = typeof globalCfg?.runtime_image_key === "string" && globalCfg.runtime_image_key.trim()
    ? globalCfg.runtime_image_key.trim()
    : null;
  // Hub 本轮提案的 image_key（已按项目可用目录校验）压过策略缺省；
  // 项目启用 / trusted / CLI 兼容仍由下方 resolveRuntimeImageForJob 与
  // requireAgentCliRuntimeAdapter 重验，快照只消费解析结果。
  const runtimeImageKey = options?.runtimeImageKey
    ?? runtimeImageKeyForProjectPolicy(projectImagePolicy, roleName, globalRuntimeImageKey);
  const runtimeImage = await resolveRuntimeImageForJob(db as never, projectId, roleName, runtimeImageKey);
  let runtimeAdapter;
  try {
    runtimeAdapter = requireAgentCliRuntimeAdapter(agentCli, runtimeImage.image_key);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
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
    model: providerSnapshot.model,
    upstream_model: providerSnapshot.upstream_model,
    pi_provider: providerSnapshot.pi_provider,
    reasoning: providerSnapshot.reasoning,
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
    capability_pack: freezeTaskCapabilityPack({
      roleName,
      summary: (role.description as string) ?? roleName,
      platformTools,
      selectors: modules,
      resolvedModules: expanded.resolved_modules,
      moduleContentHash: expanded.content_hash,
    }),
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
    config_files: providerSnapshot.config_files,
    pi_extensions: freezePiExtensions(cfg?.pi_extensions_json, agentCli, runtimeImage.image_key),
    role_config_id: (cfg?.id as string) ?? null,
    role_config_version: (cfg?.version as number) ?? null,
    runtime_image_key: runtimeImageKey,
    runtime_image: runtimeImage,
    sandbox_limits: sandboxLimits,
    role_runtime_knobs: {
      global: parseRuntimeKnobOverride(globalCfg?.runtime_knobs_json),
      project: parseRuntimeKnobOverride(projectCfg?.runtime_knobs_json),
    },
  };
}

/** The complete frozen runtime input consumed by Dispatcher/Executor. */
export async function resolveAgentSnapshotForJob(
  db: RoleRuntimeSnapshotTransaction = sql as unknown as RoleRuntimeSnapshotTransaction,
  projectId: string,
  jobType: string,
  options?: { runtimeImageKey?: string | null; agentCli?: string | null; credentialId?: string | null },
): Promise<RoleRuntimeSnapshotResult> {
  try {
    return await resolveAgentSnapshotForJobUnchecked(db, projectId, jobType, options);
  } catch (error) {
    if (error instanceof SnapshotUnresolvableError) throw error;
    throw new SnapshotUnresolvableError(error);
  }
}

export function createRoleRuntimeSnapshotApplication(): RoleRuntimeSnapshotApplication {
  return { resolveAgentSnapshotForJob };
}
