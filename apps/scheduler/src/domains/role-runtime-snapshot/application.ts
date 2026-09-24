import {
  buildRepairFeedback,
  PlatformToolName,
  type FrozenAgentRuntimeProfile,
  type RepairFeedback,
  rejectNonCurrentAgentCli,
  resolvePlatformToolsTightened,
  type FrozenCliCapability,
  type FrozenCliCapabilityPack,
  type FrozenMaterializationPack,
  type FrozenProviderModelSnapshot,
  type FrozenLanguageServerCapability,
  type PlatformToolConfig,
  type ReasoningValue,
} from "@deepsonar/shared-types";
import {
  freezeAgentRuntimeProfile,
  profileSystemPromptRef,
  UnsupportedAgentRuntimeProfileError,
} from "../../agent-runtime-profile.js";
import {
  isProviderKnown,
  UNKNOWN_PROVIDER_ERROR,
  validateCredentialAgentCliExclusive,
  validateCredentialCompatibility,
} from "../../credentials.js";
import {
  assertResolvedModelInCredentialCatalog,
  extractModelsFromSettings,
  projectProviderRuntimeSnapshot,
  resolveModelSource,
  snapshotUpstreamModel,
} from "../../provider-settings.js";
import { isOfficialRuntimeImageKey, resolveRuntimeImageForJob } from "../../runtime-images.js";
import { freezeTaskCapabilityPack } from "../capability-pack/index.js";
import {
  findLanguageServerCapability,
  freezeLanguageServerCapability,
} from "../language-server-capability/index.js";
import {
  admitCliCapabilities,
} from "../cli-capability/index.js";
import {
  freezeMaterializationPackAtJobCreate,
} from "../extension-materialization/index.js";
import {
  admitModelAgainstCatalog,
  freezeProviderModelSnapshot,
  resolveModelDescriptorCatalog,
  resolveProviderCredentialForJob,
  ProviderCredentialResolveError,
  selectModelsForRequirements,
} from "../provider-adapter/index.js";
import { ModelCatalogMismatchError } from "../../provider-effective-model.js";
import { expandModules, resolveEffectiveModuleSelectors, type MissingModule } from "../../skill-sources.js";
import { normalizeRoleUiColor } from "../../role-colors.js";
import { sql } from "../../db.js";
import { config } from "../../config.js";
import { buildAgentRuntimeLaunchSpecification, freezeAgentCliRuntime, requireAgentCliRuntimeAdapter } from "@deepsonar/runtime-sandbox";
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
import { assertProjectModulesAllowlisted } from "../project-skill-allowlist/index.js";
import type {
  RoleRuntimeSnapshotApplication,
  RoleRuntimeSnapshotResult,
  RoleRuntimeSnapshotTransaction,
} from "./ports.js";

export type { RoleRuntimeSnapshotApplication, RoleRuntimeSnapshotResult, RoleRuntimeSnapshotTransaction } from "./ports.js";

/** Structured fail-closed when model is outside eligible catalog SSOT (#632). */
function throwModelCapabilityMismatch(selectedModel: string, eligibleModelIds: string[]): never {
  const admitted = admitModelAgainstCatalog({
    resolvedModel: selectedModel,
    catalogJson: eligibleModelIds.length > 0 ? eligibleModelIds : ["__empty_eligible__"],
    allowPassthrough: false,
    operation: "resolve_role_runtime_model_requirements",
    modelSourceHint: "hub",
    emphasizePassthrough: true,
  });
  if (!admitted.ok) {
    throw new ModelCatalogMismatchError(
      `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
      admitted.resolved,
      eligibleModelIds,
      {
        ...admitted.repair,
        message: `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
      },
      admitted.code,
    );
  }
  const repair = buildRepairFeedback({
    category: "model_correctable",
    code: "model_passthrough_disabled",
    operation: "resolve_role_runtime_model_requirements",
    path: "model_ref",
    message: `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
    expected: { kind: "catalog_model_id", sample: eligibleModelIds.slice(0, 12) },
    observed_shape: { resolved_model: selectedModel, eligible: false },
    next_action: "select_catalog_model_id_or_enable_emergency_passthrough",
  });
  throw new ModelCatalogMismatchError(repair.message, selectedModel, eligibleModelIds, repair, "model_passthrough_disabled");
}

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

/** #674: 项目镜像策略已移除；解析层恒返回平台权威占位（忽略遗留字段）。 */
export function parseProjectImagePolicy(_value: unknown): ProjectImagePolicy {
  return { image_strategy: "inherit_global", role_runtime_images: {} };
}

/** #674: 项目不再持有镜像策略；物理删除遗留 image_strategy / role_runtime_images。 */
export function scrubStoredProjectImagePolicy(cfg: Record<string, unknown>): boolean {
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(cfg, "image_strategy")) {
    delete cfg.image_strategy;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(cfg, "role_runtime_images")) {
    delete cfg.role_runtime_images;
    changed = true;
  }
  return changed;
}

/** #674: Job 缺省镜像只认平台/全局 RoleConfig；忽略项目策略（保留参数以兼容旧调用方）。 */
export function runtimeImageKeyForProjectPolicy(
  _policy: ProjectImagePolicy,
  _roleName: string,
  globalRuntimeImageKey: string | null,
): string | null {
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
  _policy: ProjectImagePolicy,
  _projectCfg: { model?: unknown; agent_cli?: unknown } | undefined,
  globalCfg: { model?: unknown; agent_cli?: unknown } | undefined,
): { model: string | null; agent_cli: string } {
  // #674: 项目不再托管镜像/角色身份；model 与默认 CLI 只认全局 RoleConfig。
  return {
    model: trimmedRoleField(globalCfg?.model),
    agent_cli: trimmedRoleField(globalCfg?.agent_cli) ?? PLATFORM_DEFAULT_AGENT_CLI,
  };
}

/** inherit_global 项目 RoleConfig 不落库 model；只有 project_managed 才持久化。 */
export function persistableProjectRoleConfigModel(
  _policy: ProjectImagePolicy,
  _requestedModel: unknown,
): string | null {
  // #674: 项目 RoleConfig 不再持久化 model（与平台镜像权威一致）。
  return null;
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
  // #674: 所有项目 RoleConfig 的 model 都不再生效，统一清空。
  const models = await Promise.resolve(projectId
    ? db`
        UPDATE role_configs
        SET model = NULL
        WHERE project_id = ${projectId}
          AND model IS NOT NULL
        RETURNING id`
    : db`
        UPDATE role_configs
        SET model = NULL
        WHERE project_id IS NOT NULL
          AND model IS NOT NULL
        RETURNING id`) as unknown[];
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
- If a required preinstalled command is missing, stop the dynamic attempt and submit emit_fact.verification with outcome=inconclusive, recording the missing commands. Never claim a confirmed Finding from a static description alone. Human authorization/credential blockers use request_human; needs_human is mark_job_done.verdict only, not emit_fact.verification.outcome.
- Record the runtime image key/digest, tool versions, target revision, exact steps, expected result, actual result, and limitations in emit_fact.verification for runtime-test evidence.`;

/** #588: every official runtime image ships offline tool manuals. */
export const RUNTIME_TOOL_MANUALS_POLICY = `### Runtime tool manuals (Scheduler policy)

This Job's runtime image includes offline tool manuals at \`/opt/deepsonar/manuals/\`.

- Start with \`/opt/deepsonar/manuals/index.json\` (or its readable \`INDEX.md\` projection), then open only the relevant \`tools/*.md\` pages for the task.
- Manuals cover when to use / when not, prerequisites, invocation, output meaning, failure classes, composition, evidence retention, and version limits.
- Do not rely on host-repo docs or guessed \`--help\` alone. Prefer manuals before first invocation of an unfamiliar tool.
- The manual does not grant tools, network access, credentials, devices, Job operations, budget, or side-effect permissions; the frozen Job snapshot and Scheduler remain authoritative.
- Empty results are not automatic \`needs_human\`; missing devices/services must use verification outcome=inconclusive without fabricating runtime output. Human authorization blockers use request_human; needs_human is mark_job_done.verdict only.`;

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

/** Walk Error.cause for structured RepairFeedback (#681 HTTP boundary). */
function repairAndCodeFromCause(cause: unknown): { repair?: RepairFeedback; code?: string } {
  for (let current: unknown = cause; current; current = current instanceof Error ? current.cause : undefined) {
    if (!current || typeof current !== "object") continue;
    const repair = (current as { repair?: unknown }).repair;
    const code = (current as { code?: unknown }).code;
    if (
      repair
      && typeof repair === "object"
      && typeof (repair as { category?: unknown }).category === "string"
      && typeof (repair as { code?: unknown }).code === "string"
      && typeof (repair as { message?: unknown }).message === "string"
    ) {
      return {
        repair: repair as RepairFeedback,
        code: typeof code === "string" ? code : (repair as RepairFeedback).code,
      };
    }
  }
  return {};
}

/** Current RoleConfig/Credential/runtime identity cannot be frozen into a Job snapshot. */
export class SnapshotUnresolvableError extends Error {
  readonly stale_fields = ["current_snapshot_unresolvable"] as const;
  readonly error_code: "SNAPSHOT_STALE" | "unsupported_config";
  /** Structured repair from ModelCatalogMismatchError (and peers) on the cause chain. */
  readonly repair?: RepairFeedback;
  /** Domain code from the cause (e.g. model_not_in_catalog); independent of error_code. */
  readonly code?: string;
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 500) || "current snapshot resolution failed", { cause });
    this.name = "SnapshotUnresolvableError";
    this.error_code = cause instanceof UnsupportedAgentRuntimeProfileError ? "unsupported_config" : "SNAPSHOT_STALE";
    const extracted = repairAndCodeFromCause(cause);
    this.repair = extracted.repair;
    this.code = extracted.code;
  }
}

async function resolveAgentSnapshotForJobUnchecked(
  db: RoleRuntimeSnapshotTransaction,
  projectId: string,
  jobType: string,
  options?: { runtimeImageKey?: string | null; agentCli?: string | null; provider?: string | null; modelRef?: string | null; modelRequirements?: Record<string, unknown> | null; runtimeProfile?: import("@deepsonar/shared-types").RuntimeProfileOverridePayload | null; taskPromptOverride?: string | null; roleDefinition?: import("@deepsonar/shared-types").HubRoleDefinitionPayload | null; baseRoleName?: string | null; languageServerCapabilityId?: string | null; cliCapabilityIds?: readonly string[] | null; piExtensionIds?: readonly string[] | null },
): Promise<RoleRuntimeSnapshotResult> {
  const roleName = roleNameForJobType(jobType);
  const [role] = (await db`SELECT id, name, description, kind, ui_color, project_id
    FROM agent_roles
    WHERE name = ${roleName}
      AND (project_id IS NULL OR project_id = ${projectId})
    ORDER BY project_id NULLS LAST
    LIMIT 1`) as Array<Record<string, unknown>>;
  if (!role) throw new Error(`未注册的 Agent 角色: ${roleName}`);

  const [project] = (await db`SELECT config_json FROM projects WHERE id = ${projectId}`) as Array<Record<string, unknown>>;
  const agentAllowlist = parseProjectAgentAllowlist(project?.config_json);
  const [projectCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id = ${projectId}`) as Array<Record<string, unknown>>;
  const [globalCfg] = (await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id IS NULL`) as Array<Record<string, unknown>>;
  // Modules / bindings can still come from a leftover project row; model and
  // default CLI follow image policy so inherit_global cannot steal identity.
  // Hub 提案 > 项目软缺省 > RoleConfig：角色不是唯一绑定面。
  const cfg = (projectCfg ?? globalCfg) as Record<string, unknown> | undefined;
  const roleDefinition = options?.roleDefinition ?? null;
  const taskPromptOverride = typeof options?.taskPromptOverride === "string"
    ? options.taskPromptOverride.trim()
    : "";
  if (taskPromptOverride.length > 100_000) {
    throw new Error("taskPromptOverride exceeds 100000 characters");
  }
  if (roleDefinition && taskPromptOverride) {
    throw new Error("role_definition and role_prompt are mutually exclusive");
  }
  const effectiveInstructions = roleDefinition?.instructions_markdown
    || taskPromptOverride
    || (cfg?.instructions_markdown as string | null | undefined);
  const identity = roleIdentityForProjectPolicy(parseProjectImagePolicy(undefined), projectCfg, globalCfg);
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
  // Empty modules_json deliberately means no business Skill is materialized.
  // Agents discover capabilities through the Job-scoped catalog; only an
  // explicit selector is an authorization request and is checked against the
  // project Skill-source allowlist before it is frozen into the Job snapshot.
  const modules = await resolveEffectiveModuleSelectors(rawModules as string[] | null | undefined);
  if (modules.length > 0) {
    await assertProjectModulesAllowlisted(db, projectId, modules);
  }
  const manualSkills = (cfg?.skills_json as { name?: string }[]) ?? [];
  const manualCommands = (cfg?.commands_json as { name?: string }[]) ?? [];
  const expanded = await expandModules(modules, db as never, {
    skill_names: manualSkills.map((skill) => skill.name ?? ""),
    command_names: manualCommands.map((command) => command.name ?? ""),
  });
  if (expanded.missing.length > 0) console.warn(`[role-config] 模块未下发: ${expanded.missing.join(", ")}`);
  const skills = [...manualSkills, ...expanded.skills.filter((s) => !manualSkills.some((m) => m.name === (s as { name?: string }).name))];
  const commands = [...manualCommands, ...expanded.commands.filter((c) => !manualCommands.some((m) => m.name === (c as { name?: string }).name))];

  // #690: Hub proposes provider plugin + model needs; Scheduler resolves kernel credentials.
  // No RoleConfig.role_credentials dual-read / fallback.
  const hubProvider = typeof options?.provider === "string" && options.provider.trim()
    ? options.provider.trim()
    : null;
  const earlyModelRef = typeof options?.runtimeProfile?.model_ref === "string" && options.runtimeProfile.model_ref.trim()
    ? options.runtimeProfile.model_ref.trim()
    : typeof options?.modelRef === "string" && options.modelRef.trim()
      ? options.modelRef.trim()
      : null;
  const allowPassthroughForResolve = config.allowModelCatalogPassthrough
    || agentAllowlist.allow_model_catalog_passthrough;
  let llm: Record<string, unknown> | undefined;
  try {
    const resolved = await resolveProviderCredentialForJob({
      db,
      projectId,
      agentCli,
      allowlist: agentAllowlist,
      provider: hubProvider,
      modelRef: earlyModelRef ?? agentAllowlist.default_model_ref,
      allowPassthrough: allowPassthroughForResolve,
    });
    if (resolved) {
      llm = {
        id: resolved.id,
        name: resolved.name,
        provider: resolved.provider,
        status: resolved.status,
        cred_project_id: resolved.project_id,
        public_metadata_json: resolved.public_metadata_json,
        agent_cli: resolved.agent_cli,
        settings_config_json: resolved.settings_config_json,
        meta_json: resolved.meta_json,
        model_catalog_json: resolved.model_catalog_json,
        model_catalog_fetched_at: resolved.model_catalog_fetched_at,
        health_status: resolved.health_status,
      };
    }
  } catch (error) {
    if (error instanceof ProviderCredentialResolveError) {
      throw error;
    }
    throw error;
  }
  assertCredentialAllowlisted(agentAllowlist, llm?.id as string | undefined);
  const settingsConfig = llm?.settings_config_json ?? {};
  const manualConfigFiles = cfg
    ? await db`SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${cfg.id as string} ORDER BY path`
    : [];
  const requestedModelRef = typeof options?.runtimeProfile?.model_ref === "string" && options.runtimeProfile.model_ref.trim()
    ? options.runtimeProfile.model_ref.trim()
    : typeof options?.modelRef === "string" && options.modelRef.trim()
      ? options.modelRef.trim()
    : null;
  const configuredDefaultModel = agentAllowlist.default_model_ref;
  if (requestedModelRef && !llm) throw new Error(`模型 ${requestedModelRef} 需要可用的 LLM Provider`);
  let selectedModel = requestedModelRef ?? configuredDefaultModel ?? identity.model;
  if (llm) {
    // Selection/admit SSOT: account-configured model ids from settings_config_json (#656/#679).
    // Parse by credential agent_cli dialect so RoleConfig.model is checked against that shape.
    const credentialAgentCli = typeof llm.agent_cli === "string" && llm.agent_cli.trim()
      ? llm.agent_cli.trim()
      : agentCli;
    const configuredModelIds = extractModelsFromSettings(settingsConfig, credentialAgentCli);
    const catalog = resolveModelDescriptorCatalog({
      provider: String(llm.provider ?? ""),
      catalogJson: configuredModelIds,
      catalogRevision: typeof llm.model_catalog_fetched_at === "string"
        ? llm.model_catalog_fetched_at
        : `credential:${String(llm.id)}`,
      compatibleAgentClis: agentCli === "claude-code" || agentCli === "pi" || agentCli === "dsh" ? [agentCli] : undefined,
    });
    // #697: RoleConfig.allow_model_catalog_passthrough no longer authorizes; only
    // platform env + admin project Agent allowlist (#679 deviation 1 item 3).
    const allowPassthrough = config.allowModelCatalogPassthrough
      || agentAllowlist.allow_model_catalog_passthrough;
    const requirements = options?.modelRequirements && typeof options.modelRequirements === "object"
      ? options.modelRequirements
      : null;
    const requirementsRecord = requirements ?? {};
    const normalizedRequirements = {
      agent_cli: agentCli === "claude-code" || agentCli === "pi" || agentCli === "dsh" ? agentCli : undefined,
      min_context_window: typeof requirementsRecord.min_context_window === "number"
        ? requirementsRecord.min_context_window
        : typeof requirementsRecord.context_window_tokens === "number" ? requirementsRecord.context_window_tokens : undefined,
      require_tools: requirementsRecord.require_tools === true || requirementsRecord.supports_tools === true ? true : undefined,
      require_streaming: requirementsRecord.require_streaming === true || requirementsRecord.supports_streaming === true ? true : undefined,
      require_structured_output: requirementsRecord.require_structured_output === true || requirementsRecord.supports_structured_output === true ? true : undefined,
      reasoning_effort: typeof requirementsRecord.reasoning_effort === "string" ? requirementsRecord.reasoning_effort : undefined,
      max_input_cost_per_1m_usd: typeof requirementsRecord.max_input_cost_per_1m_usd === "number"
        ? requirementsRecord.max_input_cost_per_1m_usd
        : typeof requirementsRecord.max_input_cost_per_million === "number" ? requirementsRecord.max_input_cost_per_million : undefined,
      max_output_cost_per_1m_usd: typeof requirementsRecord.max_output_cost_per_1m_usd === "number"
        ? requirementsRecord.max_output_cost_per_1m_usd
        : typeof requirementsRecord.max_output_cost_per_million === "number" ? requirementsRecord.max_output_cost_per_million : undefined,
      allow_unverified: requirementsRecord.allow_unverified === true,
      allow_passthrough: allowPassthrough || requirementsRecord.allow_passthrough === true,
    } as never;
    const eligible = selectModelsForRequirements(catalog, normalizedRequirements);
    const eligibleIds = new Set(eligible.map((row) => row.model_id));
    const fallback = agentAllowlist.fallback_model_refs.find((ref) => eligibleIds.has(ref));
    if (!selectedModel && fallback) selectedModel = fallback;
    if (!selectedModel && requirements && eligible.length > 0) selectedModel = eligible[0]!.model_id;
    // Prefer first account-configured model when RoleConfig/project default is empty (#679).
    if (!selectedModel && configuredModelIds.length > 0) selectedModel = configuredModelIds[0]!;
    if (selectedModel && catalog.length > 0 && !allowPassthrough && !eligibleIds.has(selectedModel)) {
      if (requestedModelRef) {
        throwModelCapabilityMismatch(selectedModel, [...eligibleIds]);
      }
      if (fallback) selectedModel = fallback;
      else if (configuredModelIds.includes(selectedModel)) {
        // selectedModel is an account-configured id; capability filter may have excluded it —
        // keep it when no fallback exists (admit gate below still validates catalog membership).
      } else if (configuredModelIds.length > 0 && !requestedModelRef) {
        selectedModel = configuredModelIds[0]!;
      }
    }
    if (requirements && selectedModel && !allowPassthrough && !eligibleIds.has(selectedModel)) {
      throwModelCapabilityMismatch(selectedModel, [...eligibleIds]);
    }
  }
  const providerSnapshot = projectProviderRuntimeSnapshot({
    agentCli,
    roleModel: selectedModel,
    roleContextWindowTokens: options?.runtimeProfile?.context_window_tokens ?? cfg?.context_window_tokens,
    settingsConfig,
    // SAFETY: manualConfigFiles 由上方 `SELECT path, content, content_sha256` 直接投影（未取 cfg 时为 []），
    // 形状即查询列；下游只读这三个字段。
    manualConfigFiles: manualConfigFiles as unknown as Array<{ path: string; content: string; content_sha256: string }>,
    defaultModel: PLATFORM_DEFAULT_AGENT_MODEL,
  });
  const snapshotSettingsConfig = providerSnapshot.settings_config_json;
  const contextWindowTokens = providerSnapshot.context_window_tokens;
  if (llm) {
    // #697: RoleConfig column ignored; env OR admin project allowlist only.
    const allowPassthrough = config.allowModelCatalogPassthrough
      || agentAllowlist.allow_model_catalog_passthrough;
    // Treat Hub/project default model refs as explicit requests for empty-catalog fail-fast (#679).
    const modelSource = resolveModelSource({
      roleModel: identity.model ?? requestedModelRef ?? configuredDefaultModel,
      agentCli,
      settingsConfig,
    });
    const admitCatalogCli = typeof llm.agent_cli === "string" && llm.agent_cli.trim()
      ? llm.agent_cli.trim()
      : agentCli;
    assertResolvedModelInCredentialCatalog({
      resolvedModel: snapshotUpstreamModel(providerSnapshot) ?? providerSnapshot.model,
      catalogJson: extractModelsFromSettings(settingsConfig, admitCatalogCli),
      allowPassthrough,
      modelSource,
    });
    const provider = String(llm.provider ?? "");
    if (!isProviderKnown(provider)) throw new Error(UNKNOWN_PROVIDER_ERROR);
    // #658: credential.agent_cli is exclusive — mismatch / missing fail-closed.
    const compatibilityError = validateCredentialCompatibility(agentCli, provider);
    if (compatibilityError) throw new Error(compatibilityError);
    const exclusiveError = validateCredentialAgentCliExclusive(
      agentCli,
      typeof llm.agent_cli === "string" ? llm.agent_cli : null,
    );
    if (exclusiveError) throw new Error(exclusiveError);
    const credProject = (llm.cred_project_id as string | null) ?? null;
    // #690: resolved credentials are already scoped to project|global; reject cross-project.
    if (credProject && credProject !== projectId) {
      throw new Error(`Credential ${llm.id} 属于其他项目，不能用于本项目 Job`);
    }
    if ((llm.status as string) !== "active") {
      throw new Error(`Credential ${llm.id} 不可用（status=${String(llm.status)}）`);
    }
  }
  const roleKind = role.kind as "role" | "hub" | "system";
  const governedRoleName = typeof options?.baseRoleName === "string" && options.baseRoleName.trim()
    ? roleNameForJobType(options.baseRoleName.trim())
    : roleName;
  // #697: project platform_tools AND with global — empty project row must not reopen tools.
  const platformTools = resolvePlatformToolsTightened(
    governedRoleName,
    roleKind,
    (globalCfg?.platform_tools_json as PlatformToolConfig | undefined) ?? {},
    projectCfg
      ? ((projectCfg.platform_tools_json as PlatformToolConfig | undefined) ?? {})
      : null,
  );
  const globalRuntimeImageKey = typeof globalCfg?.runtime_image_key === "string" && globalCfg.runtime_image_key.trim()
    ? globalCfg.runtime_image_key.trim()
    : null;
  // Hub 本轮提案的 image_key（已按项目可用目录校验）压过策略缺省；
  // 项目启用 / trusted / CLI 兼容仍由下方 resolveRuntimeImageForJob 与
  // requireAgentCliRuntimeAdapter 重验，快照只消费解析结果。
  const runtimeImageKey = options?.runtimeImageKey ?? globalRuntimeImageKey;
  const runtimeImage = await resolveRuntimeImageForJob(db as never, projectId, governedRoleName, runtimeImageKey);
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

  const hubPiExtensionIds = Array.isArray(options?.piExtensionIds)
    ? options.piExtensionIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const frozenPiExtensions = freezePiExtensions(hubPiExtensionIds, agentCli, runtimeImage.image_key);
  const providerEnvRefs = Object.keys(
    providerSnapshot.settings_config_json && typeof providerSnapshot.settings_config_json === "object"
      ? ((providerSnapshot.settings_config_json as Record<string, unknown>).env as Record<string, unknown> | undefined) ?? {}
      : {},
  ).filter((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name));
  const profileEnvRefs = [
    ...((cfg?.env_keys as string[] | undefined) ?? [])
      .filter((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name))
      .map((name) => ({ name, source: "role_config" as const })),
    ...providerEnvRefs.map((name) => ({ name, source: "provider_profile" as const })),
    { name: "DEEPSONAR_GATEWAY_TOKEN", source: "gateway" as const },
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name && candidate.source === item.source) === index);
  const nativeOptions = {
    claude_code: agentCli === "claude-code"
      ? {
          model_env: "ANTHROPIC_MODEL",
          effort_level: providerSnapshot.reasoning,
        }
      : null,
    pi: agentCli === "pi"
      ? {
          model: providerSnapshot.model,
          provider: providerSnapshot.pi_provider,
          extensions: frozenPiExtensions.map((extension) => extension.id),
        }
      : null,
    dsh: agentCli === "dsh"
      ? {
          task_mode: dshTaskMode as "standard" | "ptc",
          provider: providerSnapshot.pi_provider,
        }
      : null,
  } as const;
  const runtime_profile: FrozenAgentRuntimeProfile = freezeAgentRuntimeProfile({
    schema: "deepsonar.agent-runtime-profile/v1",
    profile_version: 1,
    agent_cli: agentCli as "claude-code" | "pi" | "dsh",
    provider_ref: llm
      ? { credential_id: String(llm.id), provider: String(llm.provider) }
      : null,
    model_ref: providerSnapshot.model,
    reasoning_effort: options?.runtimeProfile?.reasoning_effort ?? providerSnapshot.reasoning,
    context_window_tokens: options?.runtimeProfile?.context_window_tokens ?? providerSnapshot.context_window_tokens,
    extensions: frozenPiExtensions.map((extension) => ({
      id: extension.id,
      version: extension.version,
      integrity: extension.integrity,
    })),
    system_prompt_ref: profileSystemPromptRef({
      instructions: effectiveInstructions,
      roleConfigId: (cfg?.id as string | undefined) ?? null,
      roleConfigVersion: typeof cfg?.version === "number" ? cfg.version : null,
    }),
    env_refs: profileEnvRefs,
    native_options: nativeOptions,
    resolution_order: ["global", "project", "role", "task", "job"],
  });

  const agent_runtime_launch = buildAgentRuntimeLaunchSpecification(runtime_profile, runtimeImage.image_key);

  let language_server: FrozenLanguageServerCapability | undefined;
  const requestedLs = typeof options?.languageServerCapabilityId === "string"
    ? options.languageServerCapabilityId.trim()
    : "";
  if (requestedLs) {
    const module = findLanguageServerCapability(requestedLs);
    if (!module) {
      throw new Error(`language-server capability is not registered: ${requestedLs}`);
    }
    if (!module.compatible_images.includes(runtimeImage.image_key)) {
      throw new Error(
        `language-server capability ${requestedLs} is incompatible with image ${runtimeImage.image_key}`,
      );
    }
    language_server = freezeLanguageServerCapability({ module, imageKey: runtimeImage.image_key });
  }

  let cli_capabilities: FrozenCliCapability[] | undefined;
  let cli_capability_pack: FrozenCliCapabilityPack | undefined;
  const requestedCliIds = Array.isArray(options?.cliCapabilityIds)
    ? options.cliCapabilityIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (requestedCliIds.length > 0) {
    const admitted = admitCliCapabilities({
      ids: requestedCliIds,
      imageKey: runtimeImage.image_key,
    });
    if (!admitted.ok) {
      throw new Error(
        `cli capability unavailable (${admitted.reason}${admitted.failed_id ? `: ${admitted.failed_id}` : ""}): ${admitted.repair.message}`,
      );
    }
    cli_capabilities = admitted.frozen;
    cli_capability_pack = admitted.pack;
  }

  let component_materialization_pack: FrozenMaterializationPack | undefined;
  const repoSkills = (skills as { name?: string; repo?: string }[]).filter(
    (skill) => typeof skill?.repo === "string" && skill.repo.length > 0,
  ).map((skill) => ({ name: String(skill.name ?? "unnamed"), repo: skill.repo }));
  const materialization = freezeMaterializationPackAtJobCreate({
    piExtensionIds: frozenPiExtensions.map((extension) => extension.id),
    imageKey: runtimeImage.image_key,
    agentCli: agentCli as "claude-code" | "pi" | "dsh",
    repoSkills,
  });
  if (!materialization.ok) {
    throw new Error(
      `component_materialization_failed (${materialization.reason}${materialization.failed_id ? `: ${materialization.failed_id}` : ""}): ${materialization.repair.message}`,
    );
  }
  component_materialization_pack = materialization.pack;

  let provider_model: FrozenProviderModelSnapshot | undefined;
  if (llm) {
    const allowPassthroughForFreeze = config.allowModelCatalogPassthrough
      || agentAllowlist.allow_model_catalog_passthrough;
    const frozenPm = freezeProviderModelSnapshot({
      provider: String(llm.provider ?? ""),
      cliModelId: providerSnapshot.model,
      upstreamModelId: snapshotUpstreamModel(providerSnapshot) ?? providerSnapshot.upstream_model,
      catalogJson: llm.model_catalog_json,
      catalogRevision: `credential:${String(llm.id)}`,
      contextWindow: providerSnapshot.context_window_tokens,
      compatibleAgentClis: agentCli === "claude-code" || agentCli === "pi" || agentCli === "dsh"
        ? [agentCli]
        : undefined,
      passthrough: allowPassthroughForFreeze,
    });
    if (frozenPm) provider_model = frozenPm;
  }

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
    reasoning: options?.runtimeProfile?.reasoning_effort ?? providerSnapshot.reasoning,
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
      roleName: governedRoleName,
      summary: roleDefinition?.description ?? (role.description as string) ?? roleName,
      platformTools,
      selectors: modules,
      resolvedModules: expanded.resolved_modules,
      moduleContentHash: expanded.content_hash,
    }),
    runtime_profile,
    agent_runtime_launch,
    ...(language_server ? { language_server } : {}),
    ...(cli_capabilities ? { cli_capabilities, cli_capability_pack } : {}),
    component_materialization_pack,
    ...(provider_model ? { provider_model } : {}),
    skill_revisions: expanded.revisions,
    skills,
    commands,
    mcps: (cfg?.mcps_json as unknown[]) ?? [],
    subagents: (cfg?.subagents_json as unknown[]) ?? [],
    role_description: roleDefinition?.description ?? (role.description as string) ?? roleName,
    instructions_markdown: withRuntimeTestToolchainPolicy(governedRoleName, effectiveInstructions ?? null, runtimeImage.image_key),
    ...(roleDefinition ? { role_profile: roleDefinition } : {}),
    platform_tools: platformTools as PlatformToolName[],
    context_window_tokens: options?.runtimeProfile?.context_window_tokens ?? contextWindowTokens,
    settings_config_json: snapshotSettingsConfig,
    config_files: providerSnapshot.config_files,
    pi_extensions: frozenPiExtensions,
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
// SAFETY: postgres.js 的 sql 与事务句柄暴露同一套 tagged-template 查询面，
// 端口只做窄化，以便测试注入假实现。
const DEFAULT_SNAPSHOT_DB = sql as unknown as RoleRuntimeSnapshotTransaction;

export async function resolveAgentSnapshotForJob(
  db: RoleRuntimeSnapshotTransaction = DEFAULT_SNAPSHOT_DB,
  projectId: string,
  jobType: string,
  options?: { runtimeImageKey?: string | null; agentCli?: string | null; provider?: string | null; modelRef?: string | null; modelRequirements?: Record<string, unknown> | null; runtimeProfile?: import("@deepsonar/shared-types").RuntimeProfileOverridePayload | null; taskPromptOverride?: string | null; roleDefinition?: import("@deepsonar/shared-types").HubRoleDefinitionPayload | null; baseRoleName?: string | null; languageServerCapabilityId?: string | null; cliCapabilityIds?: readonly string[] | null; piExtensionIds?: readonly string[] | null },
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
