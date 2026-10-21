import { validatePreflightEnvironment, validateNativeProviderStructure } from "./platform-upgrade-preflight-environment.js";
import { z } from "zod";
import { AgentCliWriteSchema, FindingProtocolConfig, CURRENT_AGENT_CLIS } from "@deepsonar/shared-types";
import { config, configInputErrors } from "./config.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import { GlobalRulesPatch, SettingsPatchBody } from "./settings-validation.js";
import { RoleConfigPutBody } from "./role-config-schema.js";
import { validateRoleConfigValues } from "./role-config-values.js";
import { providerCatalogEntry, sanitizeCredentialMetadata, validateCredentialCompatibility, validateCredentialAgentCliExclusive } from "./credentials.js";
import { normalizeProviderSettings, materializeProviderSettings, extractModelsFromSettings } from "./provider-settings.js";
import { PREFLIGHT_SCHEMA, PREFLIGHT_RESULT_SCHEMA, PREFLIGHT_TABLES, type PreflightSnapshot, type PreflightResult, type PreflightRow } from "./platform-upgrade-preflight-contract.js";

const Row = z.record(z.string(), z.unknown());
const Snapshot = z.object({
  schema: z.literal(PREFLIGHT_SCHEMA), database_schema_version: z.number().int(), target_schema_version: z.number().int(),
  environment: z.record(z.string(), z.string()),
  host_files: z.array(z.object({ key: z.string(), path: z.string(), exists: z.boolean(), regular_file: z.boolean(), readable: z.boolean(), read_only: z.boolean(), mode: z.number().int().min(0).max(4095) }).strict()).max(100).optional(),
  ...Object.fromEntries(PREFLIGHT_TABLES.map((table) => [table, z.array(Row)])),
}).strict();
const ProjectConfig = SettingsPatchBody.extend({ skill_source_allowlist_configured: z.boolean().optional() }).strict();
const Role = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), kind: z.enum(["role", "hub", "system"]) });
const RULE_KEYS = new Set([
  "minVerifySeverity", "maxFollowupsPerJob", "maxFollowupDepth", "maxAutoRetries", "maxVerificationRounds",
  "maxNoProgressRounds", "auditTimeoutSec", "verifyTimeoutSec", "stallSec", "jobTokenMaxRequests", "provisionTimeoutSec",
  "hubEnabled", "maxHubRounds", "maxIntentsPerDecision", "allowEgress", "maxGlobalJobs", "maxJobsPerProject",
  "maxConcurrentJobs", "maxConcurrentProvisioning", "maxConcurrentByProvider", "maxConcurrentByAgentCli",
]);
const ROW_KEYS: Record<string, string> = {
  global_settings: "id rules_json updated_at runtime_registry_channel claims_paused claims_pause_reason claims_pause_note claims_paused_by claims_paused_at",
  projects: "id name description status config_json created_at updated_at archived_at",
  agent_roles: "id name title description builtin kind project_id created_at updated_at ui_color",
  role_configs: "id role_id project_id agent_cli dsh_task_mode model allow_model_catalog_passthrough context_window_tokens env_keys env_vars_json modules_json skills_json commands_json mcps_json subagents_json platform_tools_json sandbox_limits_json runtime_knobs_json instructions_markdown runtime_image_key version created_at updated_at",
  role_config_files: "id role_config_id path content content_sha256 created_at updated_at",
  runtime_images: "id image_key enabled official",
  runtime_image_versions: "runtime_image_id trust_status",
  credentials: "id kind provider project_id status agent_cli public_metadata_json settings_config_json meta_json",
};
const ROLE_JSON_FIELDS = ["env_vars", "modules", "skills", "commands", "mcps", "subagents", "platform_tools", "sandbox_limits", "runtime_knobs"];
const ROLE_METADATA = new Set("id role_id project_id version created_at updated_at".split(" "));
function record(value: unknown): value is PreflightRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** No database access: every lookup is against the supplied transaction snapshot.
 * Error messages and locations never interpolate input values or arbitrary keys.
 */
export function validatePlatformUpgradeSnapshot(input: unknown): PreflightResult {
  const result: PreflightResult = {
    schema: PREFLIGHT_RESULT_SCHEMA, ok: false, blocking_errors: [],
    coverage: ["schema_versions", "environment_bootstrap", "environment_semantics", "required_host_file_metadata", "platform_rules", "project_settings", "role_configuration", "role_config_files", "credential_configuration", "configuration_references"],
    not_checked: ["credential_authentication", "registry_availability", "historical_job_snapshots", "environment_unknown_extensions", "credential_decryption_and_file_key_format", "external_service_authentication", "native_provider_extension_fields", "skill_source_contents"],
  };
  const block = (code: string, location: string) => result.blocking_errors.push({ code, location, message: "Configuration is incompatible with the target scheduler contract" });
  const check = (code: string, location: string, fn: () => unknown) => {
    try { const value = fn(); if (value === false) block(code, location); } catch { block(code, location); }
  };
  if (!Snapshot.safeParse(input).success) { block("INVALID_SNAPSHOT", "snapshot"); return result; }
  const snapshot = input as PreflightSnapshot;
  if (snapshot.database_schema_version !== SCHEMA_VERSION) block("DATABASE_SCHEMA_MISMATCH", "database_schema_version");
  if (snapshot.target_schema_version !== SCHEMA_VERSION) block("TARGET_SCHEMA_MISMATCH", "target_schema_version");
  validatePreflightEnvironment(snapshot, block);
  for (const key of configInputErrors) block("INVALID_BOOTSTRAP_VALUE", `environment.${key}`);
  if (!["real", "fake"].includes(config.runtime.agentMode)) block("INVALID_AGENT_MODE", "environment.AGENT_MODE");
  if (config.device.invalidRigEntries.length) block("INVALID_DEVICE_RIGS", "environment.DEEPSONAR_DEVICE_RIGS");
  if (snapshot.environment.DEEPSONAR_IMAGE_TAG !== undefined) block("REMOVED_ENVIRONMENT_FIELD", "environment.DEEPSONAR_IMAGE_TAG");
  if (snapshot.environment.OPEN_SANDBOX_PROTOCOL && !["http", "https"].includes(snapshot.environment.OPEN_SANDBOX_PROTOCOL)) block("INVALID_PROTOCOL", "environment.OPEN_SANDBOX_PROTOCOL");
  for (const table of PREFLIGHT_TABLES) {
    const keys = new Set(ROW_KEYS[table].split(" "));
    snapshot[table].forEach((row, i) => {
      if (Object.keys(row).some((key) => !keys.has(key))) block("UNKNOWN_OR_REMOVED_FIELD", `${table}[${i}]`);
    });
  }
  if (snapshot.global_settings.length !== 1 || snapshot.global_settings[0].id !== "global") block("GLOBAL_SETTINGS_MISSING", "global_settings");
  const checkRules = (value: unknown, location: string) => {
    if (!record(value)) { block("INVALID_RULES", location); return; }
    if (Object.keys(value).some((key) => !RULE_KEYS.has(key))) block("UNKNOWN_OR_REMOVED_RULE", location);
    for (const key of ["maxFollowupsPerJob", "maxFollowupDepth", "maxAutoRetries", "maxVerificationRounds", "maxIntentsPerDecision"]) {
      if (key in value && (typeof value[key] !== "number" || !Number.isInteger(value[key]) || (value[key] as number) < 0)) block("INVALID_RULE_VALUE", location + "." + key);
    }
    for (const key of ["hubEnabled", "allowEgress"]) if (key in value && typeof value[key] !== "boolean") block("INVALID_RULE_VALUE", location + "." + key);
    if ("minVerifySeverity" in value && !["critical", "high", "medium", "low", "info"].includes(String(value.minVerifySeverity))) block("INVALID_RULE_VALUE", location + ".minVerifySeverity");
  };
  snapshot.global_settings.forEach((row, i) => {
    const location = `global_settings[${i}]`;
    if (!record(row.rules_json)) { block("INVALID_RULES", location + ".rules_json"); return; }
    const { finding_protocol, ...rules } = row.rules_json;
    checkRules(rules, location + ".rules_json");
    check("INVALID_GLOBAL_RULES", location + ".rules_json", () => GlobalRulesPatch.parse(rules));
    if (finding_protocol != null) check("INVALID_FINDING_PROTOCOL", location + ".rules_json.finding_protocol", () => FindingProtocolConfig.parse(finding_protocol));
    if (!["github", "dockerhub", "aliyun-acr"].includes(String(row.runtime_registry_channel))) block("INVALID_REGISTRY_CHANNEL", location + ".runtime_registry_channel");
  });
  const projects = new Map(snapshot.projects.map((row) => [row.id, row]));
  const roles = new Map(snapshot.agent_roles.map((row) => [row.id, row]));
  const credentials = new Map(snapshot.credentials.map((row) => [row.id, row]));
  snapshot.agent_roles.forEach((row, i) => {
    check("INVALID_AGENT_ROLE", `agent_roles[${i}]`, () => Role.parse(row));
    if (row.project_id != null && !projects.has(row.project_id)) block("PROJECT_NOT_FOUND", `agent_roles[${i}].project_id`);
  });
  snapshot.credentials.forEach((row, i) => {
    const location = `credentials[${i}]`;
    if (!providerCatalogEntry(String(row.kind), String(row.provider))) block("INVALID_CREDENTIAL_PROVIDER", location + ".provider");
    if (!record(row.public_metadata_json) || !record(row.meta_json)) block("INVALID_CREDENTIAL_METADATA", location);
    check("INVALID_CREDENTIAL_METADATA", location + ".public_metadata_json", () => sanitizeCredentialMetadata(row.public_metadata_json, { kind: String(row.kind), provider: String(row.provider) }));
    if (row.kind === "llm_provider") {
      check("INVALID_AGENT_CLI", location + ".agent_cli", () => AgentCliWriteSchema.parse(row.agent_cli));
      check("CREDENTIAL_CLI_INCOMPATIBLE", location + ".agent_cli", () => validateCredentialCompatibility(String(row.agent_cli), String(row.provider)) === null);
      check("INVALID_PROVIDER_SETTINGS", location + ".settings_config_json", () => {
        if (!record(row.settings_config_json) || !validateNativeProviderStructure(row.settings_config_json)) return false;
        normalizeProviderSettings(String(row.agent_cli), row.settings_config_json, String(row.provider));
        materializeProviderSettings({ agentCli: String(row.agent_cli), settingsConfig: row.settings_config_json });
        return true;
      });
    }
    if (row.project_id != null && !projects.has(row.project_id)) block("PROJECT_NOT_FOUND", location + ".project_id");
  });
  snapshot.projects.forEach((row, i) => {
    const location = `projects[${i}].config_json`;
    const parsed = ProjectConfig.safeParse(row.config_json);
    if (!parsed.success) { block("INVALID_PROJECT_CONFIG", location); return; }
    const cfg = parsed.data;
    if (cfg.rules != null) checkRules(cfg.rules, location + ".rules");
    const ids = cfg.enabled_credential_ids ?? [];
    for (const id of ids) {
      const credential = credentials.get(id);
      if (!credential || credential.kind !== "llm_provider" || (credential.project_id != null && credential.project_id !== row.id)) block("PROJECT_CREDENTIAL_UNAVAILABLE", location + ".enabled_credential_ids");
    }
    if (cfg.default_agent_cli && !(cfg.enabled_agent_clis ?? [...CURRENT_AGENT_CLIS]).includes(cfg.default_agent_cli)) block("DEFAULT_CLI_OUTSIDE_ALLOWLIST", location + ".default_agent_cli");
    if (cfg.default_credential_id && !ids.includes(cfg.default_credential_id)) block("DEFAULT_CREDENTIAL_OUTSIDE_ALLOWLIST", location + ".default_credential_id");
    if ((cfg.default_model_ref || cfg.fallback_model_refs?.length) && !cfg.default_credential_id) block("MODEL_REQUIRES_DEFAULT_CREDENTIAL", location + ".default_model_ref");
    const credential = credentials.get(cfg.default_credential_id);
    if (credential) {
      if (cfg.default_agent_cli) check("DEFAULT_CREDENTIAL_CLI_MISMATCH", location + ".default_agent_cli", () => validateCredentialAgentCliExclusive(cfg.default_agent_cli!, String(credential.agent_cli)) === null);
      const models = [cfg.default_model_ref, ...cfg.fallback_model_refs ?? []].filter((v): v is string => typeof v === "string");
      check("MODEL_NOT_CONFIGURED", location + ".default_model_ref", () => cfg.allow_model_catalog_passthrough || models.every((model) => extractModelsFromSettings(credential.settings_config_json, String(credential.agent_cli)).includes(model)));
    }
  });
  snapshot.role_configs.forEach((row, i) => {
    const location = `role_configs[${i}]`;
    const role = roles.get(row.role_id);
    if (!role) { block("ROLE_NOT_FOUND", location + ".role_id"); return; }
    if (row.project_id != null && !projects.has(row.project_id)) block("PROJECT_NOT_FOUND", location + ".project_id");
    if (role.project_id != null && role.project_id !== row.project_id) block("ROLE_PROJECT_MISMATCH", location + ".project_id");
    const body: PreflightRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (ROLE_METADATA.has(key)) continue;
      const field = ROLE_JSON_FIELDS.find((name) => key === name + "_json");
      body[field ?? key] = value;
    }
    body.config_files = snapshot.role_config_files.filter((file) => file.role_config_id === row.id).map((file) => ({ path: file.path, content: file.content }));
    const parsed = RoleConfigPutBody.safeParse(body);
    if (!parsed.success) { block("INVALID_ROLE_CONFIG", location); return; }
    check("INVALID_ROLE_CONFIG_VALUES", location, () => validateRoleConfigValues(parsed.data, row.project_id as string | null, role as { name: string; kind: "role" | "hub" | "system" }, config.runtime).error === null);
    if (row.allow_model_catalog_passthrough === true) block("REMOVED_ROLE_AUTHORIZATION", location + ".allow_model_catalog_passthrough");
    if (parsed.data.runtime_image_key) {
      const image = snapshot.runtime_images.find((entry) => entry.image_key === parsed.data.runtime_image_key);
      if (!image || !image.enabled || !image.official || (config.runtime.agentMode !== "fake" && !snapshot.runtime_image_versions.some((v) => v.runtime_image_id === image.id && v.trust_status === "trusted"))) block("RUNTIME_IMAGE_UNAVAILABLE", location + ".runtime_image_key");
    }
  });
  const roleConfigs = new Set(snapshot.role_configs.map((row) => row.id));
  snapshot.role_config_files.forEach((row, i) => {
    if (!roleConfigs.has(row.role_config_id)) block("ROLE_CONFIG_NOT_FOUND", `role_config_files[${i}].role_config_id`);
  });
  result.ok = result.blocking_errors.length === 0;
  return result;
}
