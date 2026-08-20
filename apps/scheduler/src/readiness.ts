import {
  ReadinessResponse,
  type ReadinessCheck,
  type ReadinessCredentialSummary,
  type ReadinessEvidenceSummary,
  type ReadinessFixAction,
  type ReadinessResponse as ReadinessResponseType,
  type ReadinessRoleSummary,
  type ReadinessRuntimeImageSummary,
} from "@deepsonar/shared-types";
import { config } from "./config.js";
import { sql } from "./db.js";
import { globalRules, rolesForProject, rulesForProject, type ProjectRules } from "./core.js";
import { isProviderKnown, projectCredentialProvider, validateCredentialCompatibility } from "./credentials.js";
import { getAgentCliRuntimeAdapter, REQUIRED_RUNTIME_CAPABILITIES } from "@deepsonar/runtime-sandbox";
import {
  classifyRuntimeImagePin,
  defaultRuntimeImageKey,
  hostRuntimePlatform,
  immutableDigest,
  localImageDigest,
  readRuntimeRegistryChannel,
  runtimeImagePinStaleMessage,
} from "./runtime-images.js";
import {
  parseProjectImagePolicy,
  runtimeImageKeyForProjectPolicy,
  type ProjectImagePolicy,
} from "./domains/role-runtime-snapshot/application.js";
import { refreshHostDiskPressure, type HostDiskPressureStatus } from "./host-disk.js";

const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ReadinessScopeInput = {
  kind: "global" | "project";
  projectId: string | null;
};

export type ReadinessMaterialSource =
  | "workspace_or_offline"
  | "external_or_workspace"
  | "declared"
  | "unspecified";

export interface ReadinessRoleRow {
  role_id: string;
  name: string;
  title: string;
  kind: "role" | "hub" | "system";
  builtin?: boolean;
  project_config_id: string | null;
  project_config_scope: "project" | "none";
  project_agent_cli: string | null;
  project_model: string | null;
  project_runtime_image_key: string | null;
  global_config_id: string | null;
  global_agent_cli: string | null;
  global_model: string | null;
  global_runtime_image_key: string | null;
}

export interface ReadinessCredentialRow {
  role_config_id: string;
  purpose: string;
  credential_id: string | null;
  name: string | null;
  kind: "llm_provider" | "plane" | "git" | "oci_registry" | null;
  provider: string | null;
  project_id: string | null;
  status: "active" | "disabled" | "rotation_required" | null;
  public_metadata_json: unknown;
  agent_cli?: string | null;
  settings_config_json?: unknown;
}

export interface ReadinessRuntimeImageRow {
  image_key: string;
  image_enabled: boolean;
  project_opt_in: boolean | null;
  source_kind: "official" | "third_party" | null;
  official: boolean | null;
  project_enabled: boolean | null;
  version_id: string | null;
  digest: string | null;
  resolved_ref: string | null;
  trust_status: string | null;
  has_revoked?: boolean;
  admission_scan_id: string | null;
  admission_bypassed: boolean;
  platforms_json?: unknown;
  promoted_at?: string | Date | null;
  approved_at?: string | Date | null;
  created_at?: string | Date | null;
  runtime_image_id?: string | null;
  selected_version_id?: string | null;
  selected_version?: string | null;
  latest_version_id?: string | null;
  latest_version?: string | null;
}

export interface ReadinessAuditRow {
  resource_id: string;
  action: "credential.test" | "credential.models_discover";
  at: string | Date;
  result: string | null;
  after_json: unknown;
}

export interface ReadinessEvaluationInput {
  scope: ReadinessScopeInput;
  executionMode: "fake" | "real";
  now?: Date;
  projectStatus?: "active" | "archived" | null;
  hubEnabled: boolean;
  allowEgress: boolean;
  networkSource: "global" | "project" | "task_override";
  materialSource?: ReadinessMaterialSource;
  roles: ReadinessRoleRow[];
  /** 项目镜像策略；项目 RoleConfig 的遗留 runtime_image_key 不参与解析。 */
  projectImagePolicy?: ProjectImagePolicy;
  credentials?: ReadinessCredentialRow[];
  runtimeImages?: ReadinessRuntimeImageRow[];
  audits?: ReadinessAuditRow[];
  hostDisk?: HostDiskPressureStatus;
}

type EffectiveRole = ReadinessRoleRow & {
  configId: string | null;
  configScope: "project" | "global" | "platform_default";
  agentCli: string | null;
  model: string | null;
  runtimeImageKey: string | null;
};

function projectHref(scope: ReadinessScopeInput, globalPath: string, projectPath: string): string {
  return scope.projectId ? projectPath.replace(":projectId", scope.projectId) : globalPath;
}

function roleSummary(role: EffectiveRole): ReadinessRoleSummary {
  return {
    role_id: role.role_id,
    name: role.name,
    title: role.title,
    kind: role.kind,
    config_id: role.configId,
    config_scope: role.configScope,
    agent_cli: role.agentCli,
    model: role.model,
    runtime_image_key: role.runtimeImageKey,
  };
}

function credentialSummary(row: ReadinessCredentialRow): ReadinessCredentialSummary | null {
  if (!row.credential_id || !row.name || !row.kind || !row.provider || !row.status) return null;
  const providerProjection = projectCredentialProvider(row.kind, row.provider);
  return {
    credential_id: row.credential_id,
    name: row.name,
    kind: row.kind,
    ...providerProjection,
    project_id: row.project_id,
    status: row.status,
  };
}

function imageSummary(row: ReadinessRuntimeImageRow | undefined, imageKey: string): ReadinessRuntimeImageSummary {
  const selectedVersionId = row?.selected_version_id ?? null;
  const latestVersionId = row?.latest_version_id ?? null;
  const pinStale = classifyRuntimeImagePin({
    selectedVersionId,
    pinMatchesExecutableTrusted: Boolean(row?.version_id && selectedVersionId && row.version_id === selectedVersionId),
    latestTrustedVersionId: latestVersionId,
  }) === "pin_stale";
  return {
    image_key: imageKey,
    version_id: row?.version_id ?? null,
    digest: row?.digest && /^sha256:[0-9a-f]{64}$/.test(row.digest) ? row.digest : null,
    source_kind: row?.source_kind ?? null,
    official: row?.official ?? null,
    trust_status: row?.trust_status ?? null,
    project_enabled: row?.project_enabled ?? null,
    admission_scan_id: row?.admission_scan_id ?? null,
    runtime_image_id: row?.runtime_image_id ?? null,
    selected_version_id: selectedVersionId,
    selected_version: row?.selected_version ?? null,
    latest_version_id: latestVersionId,
    latest_version: row?.latest_version ?? null,
    pin_stale: pinStale,
  };
}

function resolvedRuntimeImageDigest(resolvedRef: string | null): string | null {
  return resolvedRef ? immutableDigest(resolvedRef) ?? localImageDigest(resolvedRef) : null;
}

function evidenceSummary(
  kind: ReadinessEvidenceSummary["kind"],
  status: ReadinessEvidenceSummary["status"],
  audit: ReadinessAuditRow | undefined,
  now: Date,
  modelCount: number | null = null,
): ReadinessEvidenceSummary {
  const at = audit ? new Date(audit.at) : null;
  const ageSeconds = at && Number.isFinite(at.getTime())
    ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000))
    : null;
  return {
    kind,
    status,
    at: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
    age_seconds: ageSeconds,
    model_count: modelCount,
    source: audit ? "audit_log" : "not_recorded",
  };
}

function latestAudit(audits: ReadinessAuditRow[], credentialId: string, action: ReadinessAuditRow["action"]): ReadinessAuditRow | undefined {
  return audits
    .filter((row) => row.resource_id === credentialId && row.action === action)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
}

function modelCountFromAudit(audit: ReadinessAuditRow | undefined): number | null {
  if (!audit || !audit.after_json || typeof audit.after_json !== "object" || Array.isArray(audit.after_json)) return null;
  const count = (audit.after_json as Record<string, unknown>).model_count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

function runtimePlatformRank(row: ReadinessRuntimeImageRow, hostPlatform: string): number {
  const platforms = Array.isArray(row.platforms_json)
    ? row.platforms_json.filter((value): value is string => typeof value === "string")
    : [];
  if (platforms.includes(hostPlatform)) return 0;
  return platforms.length === 0 ? 1 : 2;
}

function runtimeTimestamp(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareRuntimeTimestampDesc(a: string | Date | null | undefined, b: string | Date | null | undefined): number {
  const left = runtimeTimestamp(a);
  const right = runtimeTimestamp(b);
  if (left === 0 && right !== 0) return 1;
  if (left !== 0 && right === 0) return -1;
  return right - left;
}

/**
 * Select the same candidate the resolver can execute: trusted versions are
 * filtered before platform/latest ordering, so an untrusted host-platform
 * version cannot hide a trusted fallback. The fallback to an untrusted row is
 * diagnostic-only for pure projections; SQL loading mirrors the resolver and
 * returns no version when no trusted candidate exists.
 */
export function selectRuntimeImageCandidate(
  rows: ReadinessRuntimeImageRow[],
  imageKey: string,
  hostPlatform: string,
): ReadinessRuntimeImageRow | undefined {
  const candidates = rows.filter((row) => row.image_key === imageKey);
  if (candidates.length === 0) return undefined;
  const trusted = candidates.filter((row) => row.trust_status === "trusted");
  const pool = trusted.length > 0 ? trusted : candidates;
  return [...pool].sort((a, b) => {
    const platform = runtimePlatformRank(a, hostPlatform) - runtimePlatformRank(b, hostPlatform);
    if (platform !== 0) return platform;
    const promoted = compareRuntimeTimestampDesc(a.promoted_at, b.promoted_at);
    if (promoted !== 0) return promoted;
    const approved = compareRuntimeTimestampDesc(a.approved_at, b.approved_at);
    if (approved !== 0) return approved;
    return compareRuntimeTimestampDesc(a.created_at, b.created_at);
  })[0];
}

function fail(
  code: string,
  message: string,
  fix: ReadinessCheck["fix"],
  context: Partial<Pick<ReadinessCheck, "role" | "credential" | "runtime_image" | "evidence">> = {},
): ReadinessCheck {
  return { code, state: "fail", severity: "error", message, fix: normalizeFix(code, fix), ...context };
}

function attention(
  code: string,
  message: string,
  fix: ReadinessCheck["fix"],
  context: Partial<Pick<ReadinessCheck, "role" | "credential" | "runtime_image" | "evidence">> = {},
): ReadinessCheck {
  return { code, state: "attention", severity: "warning", message, fix: normalizeFix(code, fix), ...context };
}

function pass(
  code: string,
  message: string,
  context: Partial<Pick<ReadinessCheck, "role" | "credential" | "runtime_image" | "evidence">> = {},
): ReadinessCheck {
  return { code, state: "pass", severity: "info", fix: null, ...context, message };
}

function effectiveRole(row: ReadinessRoleRow, projectImagePolicy?: ProjectImagePolicy): EffectiveRole {
  const project = row.project_config_id !== null;
  const global = row.global_config_id !== null;
  const runtimeImageKey = project
    ? runtimeImageKeyForProjectPolicy(
      projectImagePolicy ?? parseProjectImagePolicy(undefined),
      row.name,
      row.global_runtime_image_key,
    )
    : row.global_runtime_image_key;
  return {
    ...row,
    configId: project ? row.project_config_id : row.global_config_id,
    configScope: project ? "project" : global ? "global" : "platform_default",
    agentCli: project ? row.project_agent_cli : row.global_agent_cli ?? "claude-code",
    model: project ? row.project_model : row.global_model,
    runtimeImageKey,
  };
}

function credentialFix(_scope: ReadinessScopeInput): ReadinessCheck["fix"] {
  return readinessFix("credentials", "global", null, "/settings/credentials", "credentials");
}

function roleConfigFix(scope: ReadinessScopeInput): ReadinessCheck["fix"] {
  const targetScope = scope.projectId ? "project" : "global";
  const projectId = scope.projectId;
  return {
    action: "role_config",
    scope: targetScope,
    project_id: projectId,
    href: projectHref(scope, "/agents?tab=roles", "/projects/:projectId/settings?tab=roles"),
    target: "role-config",
  };
}

function readinessFix(
  action: ReadinessFixAction,
  scope: "global" | "project",
  projectId: string | null,
  href: string,
  target: string,
): ReadinessCheck["fix"] {
  return { action, scope, project_id: projectId, href, target };
}

function rulesFix(scope: ReadinessScopeInput): ReadinessCheck["fix"] {
  const targetScope = scope.projectId ? "project" : "global";
  return readinessFix(
    "rules",
    targetScope,
    scope.projectId,
    projectHref(scope, "/settings/platform?tab=rules", "/projects/:projectId/settings?tab=rules"),
    "rules",
  );
}

function runtimeImagesFix(
  scope: ReadinessScopeInput,
  targetScope: "global" | "project" = scope.projectId ? "project" : "global",
): ReadinessCheck["fix"] {
  const projectId = targetScope === "project" ? scope.projectId : null;
  const href = targetScope === "project"
    ? projectId ? `/projects/${projectId}/images` : "/projects"
    : "/images";
  return readinessFix("runtime_images", targetScope, projectId, href, "runtime-images");
}

const ROLE_CONFIG_FIX_CODES = new Set([
  "HUB_ROLE_UNAVAILABLE",
  "WORKER_ROLE_UNAVAILABLE",
  "CREDENTIAL_BINDING_AMBIGUOUS",
  "CREDENTIAL_MISSING",
  "CREDENTIAL_MISSING_FAKE",
  "CREDENTIAL_SCOPE_MISMATCH",
  "CREDENTIAL_CLI_INCOMPATIBLE",
  "CREDENTIAL_KIND_INCOMPATIBLE",
]);

const CREDENTIAL_FIX_CODES = new Set([
  "CREDENTIAL_PROVIDER_UNKNOWN",
  "CREDENTIAL_NOT_ACTIVE",
  "CREDENTIAL_TEST_FAILED",
  "CREDENTIAL_TEST_FAILED_FAKE",
  "CREDENTIAL_TEST_EVIDENCE_STALE",
  "MODEL_DISCOVERY_FAILED",
  "MODEL_DISCOVERY_EVIDENCE_MISSING",
  "MODEL_DISCOVERY_EVIDENCE_STALE",
]);

const RULES_FIX_CODES = new Set([
  "PROJECT_ARCHIVED",
  "HUB_DISABLED",
  "NETWORK_POLICY_MATERIAL_CONFLICT",
  "MATERIAL_SOURCE_UNSPECIFIED",
]);

function inferFixAction(code: string): ReadinessFixAction | null {
  if (ROLE_CONFIG_FIX_CODES.has(code)) return "role_config";
  if (CREDENTIAL_FIX_CODES.has(code)) return "credentials";
  if (RULES_FIX_CODES.has(code)) return "rules";
  if (code.startsWith("RUNTIME_IMAGE_")) return "runtime_images";
  return null;
}

function normalizeFix(code: string, fix: ReadinessCheck["fix"]): ReadinessCheck["fix"] {
  if (!fix) return fix;
  const action = fix.action ?? inferFixAction(code);
  if (!action) return fix;
  const hrefProject = fix.href.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] ?? null;
  const inferredScope = fix.scope ?? (hrefProject ? "project" : action === "credentials" ? "global" : "global");
  const projectId = fix.project_id ?? (inferredScope === "project" ? hrefProject : null);
  const href = action === "credentials"
    ? "/settings/credentials"
    : action === "role_config"
      ? inferredScope === "project" && projectId ? `/projects/${projectId}/settings?tab=roles` : "/agents?tab=roles"
      : action === "rules"
        ? inferredScope === "project" && projectId ? `/projects/${projectId}/settings?tab=rules` : "/settings/platform?tab=rules"
        : inferredScope === "project"
          ? projectId ? `/projects/${projectId}/images` : "/projects"
          : "/images";
  return { ...fix, action, scope: inferredScope, project_id: projectId, href };
}

/**
 * Pure readiness projection.  All inputs are already server-owned rows; no
 * caller-provided env, secret or OCI reference is accepted here.
 */
export function evaluateReadiness(input: ReadinessEvaluationInput): ReadinessResponseType {
  const now = input.now ?? new Date();
  const checks: ReadinessCheck[] = [];
  let unresolved = false;
  const credentials = input.credentials ?? [];
  const audits = input.audits ?? [];
  const images = input.runtimeImages ?? [];
  const roles = input.roles.map((row) => effectiveRole(row, input.projectImagePolicy));
  const hub = roles.find((role) => role.kind === "hub" && role.name === "hub_reason");
  const workers = roles.filter((role) => role.kind === "role");
  const credentialByConfig = new Map<string, ReadinessCredentialRow[]>();
  for (const row of credentials) {
    if (!credentialByConfig.has(row.role_config_id)) credentialByConfig.set(row.role_config_id, []);
    credentialByConfig.get(row.role_config_id)!.push(row);
  }
  const hostPlatform = hostRuntimePlatform();
  const imageByKey = new Map(
    [...new Set(images.map((row) => row.image_key))]
      .map((imageKey) => [imageKey, selectRuntimeImageCandidate(images, imageKey, hostPlatform)] as const),
  );

  if (input.hostDisk?.level === "error") {
    checks.push(fail(
      "HOST_DISK_PRESSURE",
      `宿主文件系统 ${input.hostDisk.path} 已用 ${input.hostDisk.usedPercent?.toFixed(2)}%，达到 error 阈值 ${input.hostDisk.errorPercent}%；Dispatcher 已暂停新领取。`,
      null,
    ));
  } else if (input.hostDisk?.level === "warning") {
    checks.push(attention(
      "HOST_DISK_PRESSURE",
      `宿主文件系统 ${input.hostDisk.path} 已用 ${input.hostDisk.usedPercent?.toFixed(2)}%，达到 warning 阈值 ${input.hostDisk.warningPercent}%。`,
      null,
    ));
  } else if (input.hostDisk?.level === "unknown") {
    checks.push(fail(
      "HOST_DISK_CHECK_FAILED",
      `无法读取宿主文件系统 ${input.hostDisk.path} 水位；Dispatcher 按 fail-closed 暂停新领取。`,
      null,
    ));
  } else if (input.hostDisk?.level === "ok") {
    checks.push(pass(
      "HOST_DISK_READY",
      `宿主文件系统 ${input.hostDisk.path} 水位正常（${input.hostDisk.usedPercent?.toFixed(2)}%）。`,
    ));
  }

  if (input.scope.projectId && input.projectStatus === "archived") {
    checks.push(fail(
      "PROJECT_ARCHIVED",
      "当前项目已归档，不能创建新的任务；请先恢复项目。",
      readinessFix("rules", "project", input.scope.projectId, `/projects/${input.scope.projectId}/settings?tab=rules`, "project-status"),
    ));
  }

  if (!input.hubEnabled) {
    checks.push(fail(
      "HUB_DISABLED",
      "Hub 已被当前项目或全局规则关闭，一键任务无法生成第一步决策。",
      rulesFix(input.scope),
    ));
  } else {
    checks.push(pass("HUB_ENABLED", "Hub 决策循环已启用。"));
  }

  if (!hub) {
    checks.push(fail(
      "HUB_ROLE_UNAVAILABLE",
      "未找到 Scheduler 的 hub_reason 角色，无法创建 Hub 决策 Job。",
      roleConfigFix(input.scope),
    ));
  }
  if (workers.length === 0) {
    checks.push(fail(
      "WORKER_ROLE_UNAVAILABLE",
      "当前作用域没有可供 Hub 下发的 Worker 角色。",
      roleConfigFix(input.scope),
    ));
  }

  for (const role of roles) {
    const summary = roleSummary(role);
    const isHub = role.kind === "hub" && role.name === "hub_reason";
    if (!isHub && role.kind !== "role") continue;
    if (!role.configId) {
      checks.push(pass(
        isHub ? "HUB_ROLE_PLATFORM_DEFAULT" : "WORKER_ROLE_PLATFORM_DEFAULT",
        `${isHub ? "Hub" : `Worker 角色 ${role.name}`} 使用 Scheduler 平台安全默认；可在 RoleConfig 中显式覆盖。`,
        { role: summary },
      ));
    } else {
      checks.push(pass(
        isHub ? "HUB_ROLE_CONFIG_READY" : "WORKER_ROLE_CONFIG_READY",
        `${isHub ? "Hub" : `Worker 角色 ${role.name}`} 已解析到 ${role.configScope} RoleConfig。`,
        { role: summary },
      ));
    }

    const bindings = role.configId
      ? (credentialByConfig.get(role.configId) ?? []).filter((row) => row.purpose === "llm")
      : [];
    if (bindings.length > 1) {
      checks.push(fail(
        "CREDENTIAL_BINDING_AMBIGUOUS",
        `RoleConfig ${role.name} 绑定了多个 llm Credential，Scheduler 无法安全选择唯一账号。`,
        roleConfigFix(input.scope),
        { role: summary },
      ));
    }
    const binding = bindings[0];
    if (!binding || !binding.credential_id) {
      checks.push(input.executionMode === "real"
        ? fail("CREDENTIAL_MISSING", `${role.name} 未绑定 llm Credential，real 模式无法运行。`, roleConfigFix(input.scope), { role: summary })
        : attention("CREDENTIAL_MISSING_FAKE", `${role.name} 未绑定 llm Credential；fake 模式可继续，但切换 real 前需要配置账号。`, roleConfigFix(input.scope), { role: summary }));
    } else {
      const credential = credentialSummary(binding);
      const credentialRef = credential ?? undefined;
      const expectedProject = input.scope.projectId;
      const credentialScopeMismatch = role.configScope === "global"
        ? Boolean(binding.project_id)
        : Boolean(binding.project_id && (!expectedProject || binding.project_id !== expectedProject));
      if (credentialScopeMismatch) {
        checks.push(fail(
          "CREDENTIAL_SCOPE_MISMATCH",
          role.configScope === "global"
            ? `${role.name} 的全局 RoleConfig 只能绑定全局 Credential，不能引用项目凭据。`
            : `${role.name} 绑定的 Credential 属于其他项目，不能用于当前作用域。`,
          roleConfigFix(input.scope),
          { role: summary, credential: credentialRef },
        ));
      } else if (!binding.project_id && role.configScope === "project") {
        // Global credentials are valid for project RoleConfigs; this is the
        // intended project > global overlay and therefore not an error.
      }
      if (!isProviderKnown(String(binding.provider ?? ""))) {
        checks.push(fail(
          "CREDENTIAL_PROVIDER_UNKNOWN",
          `${role.name} 使用了 Scheduler 不认识的 Provider，无法生成受治理的认证映射。`,
          credentialFix(input.scope),
          { role: summary, credential: credentialRef },
        ));
      } else {
        const compatibility = validateCredentialCompatibility(role.agentCli ?? "", String(binding.provider));
        const profileCompatibility = binding.agent_cli && binding.agent_cli !== role.agentCli
          ? `Credential 配置文件属于 ${binding.agent_cli}，不能绑定到 ${role.agentCli}`
          : null;
        if (compatibility || profileCompatibility) {
          checks.push(fail("CREDENTIAL_CLI_INCOMPATIBLE", compatibility ?? profileCompatibility!, roleConfigFix(input.scope), { role: summary, credential: credentialRef }));
        }
      }
      if (binding.status !== "active") {
        checks.push(fail(
          "CREDENTIAL_NOT_ACTIVE",
          `${role.name} 的 Credential 当前状态为 ${String(binding.status)}，不能用于新 Job。`,
          credentialFix(input.scope),
          { role: summary, credential: credentialRef },
        ));
      }
      if (binding.kind !== "llm_provider") {
        checks.push(fail(
          "CREDENTIAL_KIND_INCOMPATIBLE",
          `${role.name} 的 llm 绑定不是 LLM Provider Credential，Scheduler 不会把其他凭据类型当作模型账号。`,
          roleConfigFix(input.scope),
          { role: summary, credential: credentialRef },
        ));
      }
      const latestTest = latestAudit(audits, binding.credential_id, "credential.test");
      const latestModels = latestAudit(audits, binding.credential_id, "credential.models_discover");
      const testAt = latestTest ? new Date(latestTest.at) : null;
      const testFresh = Boolean(testAt && Number.isFinite(testAt.getTime()) && now.getTime() - testAt.getTime() <= EVIDENCE_MAX_AGE_MS);
      const testStatus: ReadinessEvidenceSummary["status"] = !latestTest
        ? "missing"
        : latestTest.result === "ok" && testFresh ? "ok" : latestTest.result === "ok" ? "stale" : "error";
      checks.push(testStatus === "error"
        ? input.executionMode === "real"
          ? fail("CREDENTIAL_TEST_FAILED", `${role.name} 最近一次 Credential 连接测试失败；请重新测试后再运行。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("credential_test", testStatus, latestTest, now) })
          : attention("CREDENTIAL_TEST_FAILED_FAKE", `${role.name} 最近一次 Credential 连接测试失败；fake 模式不消费 Provider 凭据，但切换 real 前请重新测试。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("credential_test", testStatus, latestTest, now) })
        : testStatus === "missing" || testStatus === "stale"
          ? attention("CREDENTIAL_TEST_EVIDENCE_STALE", `${role.name} 没有 24 小时内成功的连接测试证据；服务端不会凭空声称 Provider 在线。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("credential_test", testStatus, latestTest, now) })
          : pass("CREDENTIAL_TEST_READY", `${role.name} 有近期成功的 Credential 连接测试证据。`, { role: summary, credential: credentialRef, evidence: evidenceSummary("credential_test", testStatus, latestTest, now) }));
      const modelCount = modelCountFromAudit(latestModels);
      const modelsAt = latestModels ? new Date(latestModels.at) : null;
      const modelsFresh = Boolean(modelsAt && Number.isFinite(modelsAt.getTime()) && now.getTime() - modelsAt.getTime() <= EVIDENCE_MAX_AGE_MS);
      const modelStatus: ReadinessEvidenceSummary["status"] = !latestModels
        ? "missing"
        : latestModels.result !== "ok" ? "error"
          : !modelsFresh || modelCount === null ? "stale"
            : "ok";
      checks.push(modelStatus === "error"
        ? attention("MODEL_DISCOVERY_FAILED", `${role.name} 最近一次模型目录获取失败；请重新获取模型或检查 Provider。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("model_discovery", modelStatus, latestModels, now, modelCount) })
        : modelStatus === "missing"
          ? attention("MODEL_DISCOVERY_EVIDENCE_MISSING", `${role.name} 尚无可验证的模型目录证据；Scheduler 不会把未发现的模型当作在线可用。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("model_discovery", modelStatus, latestModels, now, modelCount) })
          : modelStatus === "stale"
            ? attention("MODEL_DISCOVERY_EVIDENCE_STALE", `${role.name} 没有 24 小时内成功的模型目录证据；请重新获取模型目录。`, credentialFix(input.scope), { role: summary, credential: credentialRef, evidence: evidenceSummary("model_discovery", modelStatus, latestModels, now, modelCount) })
          : pass("MODEL_DISCOVERY_READY", `${role.name} 有模型目录获取证据（仅记录数量，不回显 Provider 响应）。`, { role: summary, credential: credentialRef, evidence: evidenceSummary("model_discovery", modelStatus, latestModels, now, modelCount) }));
    }

    const imageKey = role.runtimeImageKey || defaultRuntimeImageKey(role.name);
    const image = imageByKey.get(imageKey);
    const runtimeSummary = imageSummary(image, imageKey);
    if (input.executionMode === "real") {
      const adapter = getAgentCliRuntimeAdapter(role.agentCli);
      if (!adapter) {
        checks.push(fail("AGENT_CLI_UNREGISTERED", `${role.name} 的 agent_cli=${role.agentCli ?? "<missing>"} 未在 Scheduler 治理注册表中注册。`, roleConfigFix(input.scope), { role: summary }));
      } else {
        const missing = REQUIRED_RUNTIME_CAPABILITIES.filter((capability) => !adapter.capabilities[capability]);
        if (missing.length > 0) {
          checks.push(fail("AGENT_CLI_CAPABILITY_MISSING", `${role.name} 的 ${adapter.id} 缺少必需运行能力：${missing.join(", " )}。`, roleConfigFix(input.scope), { role: summary }));
        } else if (!adapter.capabilities.controlMcp && !adapter.capabilities.platformControlApi) {
          checks.push(fail("AGENT_CLI_CONTROL_CAPABILITY_MISSING", `${role.name} 的 ${adapter.id} 未提供控制 MCP 或 Job 控制 API。`, roleConfigFix(input.scope), { role: summary }));
        } else if (typeof adapter.resume !== "function") {
          checks.push(fail("AGENT_CLI_RESUME_UNSUPPORTED", `${role.name} 的 ${adapter.id} 不支持进程级同会话恢复。`, roleConfigFix(input.scope), { role: summary }));
        } else if (!adapter.compatibleImageKeys.includes(imageKey)) {
          checks.push(fail("AGENT_CLI_IMAGE_INCOMPATIBLE", `${role.name} 的 ${adapter.id} 与 runtime image ${imageKey} 不兼容；请选择受治理的匹配镜像。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
        } else {
          checks.push(pass("AGENT_CLI_READY", `${role.name} 已解析到受治理的 ${adapter.id} runtime adapter。`, { role: summary }));
        }
      }
    }
    if (input.executionMode === "fake") {
      checks.push(pass("RUNTIME_IMAGE_SKIPPED_FAKE", `${role.name} 在 fake 模式使用 NoopRunner；real 模式才会校验可信 runtime image。`, { role: summary, runtime_image: runtimeSummary }));
    } else if (!image) {
      const inherited = Boolean(input.scope.projectId && input.projectImagePolicy?.image_strategy !== "project_managed");
      checks.push(fail(
        "RUNTIME_IMAGE_UNAVAILABLE",
        inherited
          ? `${role.name} 继承全局 RoleConfig 的 runtime image ${imageKey}，该镜像不可用；如需项目镜像请切换 project_managed 并配置角色映射。`
          : `${role.name} 所需 runtime image ${imageKey} 不存在或未被 Scheduler 选中。`,
        runtimeImagesFix(input.scope),
        { role: summary, runtime_image: runtimeSummary },
      ));
    } else if (!image.image_enabled) {
      checks.push(fail("RUNTIME_IMAGE_DISABLED", `${role.name} 所需 runtime image ${imageKey} 已被禁用。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (!input.scope.projectId && !(image.official === true && image.project_opt_in === false)) {
      unresolved = true;
      checks.push(attention("RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED", `${role.name} 的 runtime image 需要具体项目启用；请在项目作用域重新执行 real 预检。`, runtimeImagesFix(input.scope, "project"), { role: summary, runtime_image: runtimeSummary }));
    } else if (input.scope.projectId && image.project_enabled === false) {
      checks.push(fail("RUNTIME_IMAGE_PROJECT_NOT_ENABLED", `${role.name} 的 runtime image 已在当前项目显式禁用。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (input.scope.projectId && !(image.official === true && image.project_opt_in === false) && image.project_enabled !== true) {
      checks.push(fail("RUNTIME_IMAGE_PROJECT_NOT_ENABLED", `${role.name} 的 runtime image 尚未在当前项目启用。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (!image.version_id) {
      const pinState = classifyRuntimeImagePin({
        selectedVersionId: image.selected_version_id,
        pinMatchesExecutableTrusted: false,
        latestTrustedVersionId: image.latest_version_id,
      });
      if (pinState === "pin_stale" && image.selected_version_id && image.latest_version_id) {
        checks.push(fail(
          "RUNTIME_IMAGE_PIN_STALE",
          runtimeImagePinStaleMessage({
            roleName: role.name,
            imageKey,
            selectedVersion: image.selected_version ?? null,
            selectedVersionId: image.selected_version_id,
            latestVersion: image.latest_version ?? null,
            latestVersionId: image.latest_version_id,
          }),
          runtimeImagesFix(input.scope),
          { role: summary, runtime_image: runtimeSummary },
        ));
      } else if (image.has_revoked) {
        checks.push(fail("RUNTIME_IMAGE_REVOKED", `${role.name} 所需 runtime image ${imageKey} 的版本已被吊销，没有可执行的 trusted 版本。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
      } else {
        checks.push(fail("RUNTIME_IMAGE_UNAVAILABLE", `${role.name} 所需 runtime image ${imageKey} 没有 Scheduler 可执行的 trusted 版本。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
      }
    } else if (image.trust_status !== "trusted") {
      checks.push(fail("RUNTIME_IMAGE_NOT_TRUSTED", `${role.name} 所需 runtime image ${imageKey} 没有 trusted 版本。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (!image.digest || resolvedRuntimeImageDigest(image.resolved_ref) !== image.digest) {
      checks.push(fail("RUNTIME_IMAGE_DIGEST_INVALID", `${role.name} 的 runtime image 缺少一致的不可变 digest，不能进入 real 沙箱。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (image.source_kind === "third_party" && !image.admission_scan_id && !image.admission_bypassed) {
      checks.push(fail("RUNTIME_IMAGE_ADMISSION_INCOMPLETE", `${role.name} 的第三方 runtime image 尚未完成准入扫描。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary }));
    } else if (image.source_kind === "third_party" && !image.admission_scan_id && image.admission_bypassed) {
      checks.push(attention("RUNTIME_IMAGE_ADMISSION_BYPASSED", `${role.name} 使用了运维显式登记的 immutable digest；该版本标记为跳过准入扫描，请确认登记来源。`, runtimeImagesFix(input.scope), { role: summary, runtime_image: runtimeSummary, evidence: { kind: "none", status: "missing", at: null, age_seconds: null, model_count: null, source: "not_recorded" } }));
    } else {
      checks.push(pass("RUNTIME_IMAGE_READY", `${role.name} 已解析到 Scheduler 信任的不可变 runtime image。`, { role: summary, runtime_image: runtimeSummary }));
    }
  }

  const materialSource = input.materialSource ?? "unspecified";
  if (!input.allowEgress && materialSource === "external_or_workspace") {
    checks.push(fail(
      "NETWORK_POLICY_MATERIAL_CONFLICT",
      "任务声明需要外部材料，但 allow_egress=false；请允许出网或改为工作区/上传/离线材料。",
      rulesFix(input.scope),
    ));
  } else if (materialSource === "unspecified") {
    checks.push(attention(
      "MATERIAL_SOURCE_UNSPECIFIED",
      input.allowEgress
        ? "任务允许出网，但尚未声明材料来源；Worker 仍需在 prompt 中决定是否访问外部材料。"
        : "任务禁止出网，请在任务描述中明确提供工作区、上传物或离线材料；平台不会替 Worker 下载目标。",
      rulesFix(input.scope),
    ));
  } else {
    checks.push(pass(
      "NETWORK_POLICY_READY",
      `网络策略已解析为 allow_egress=${input.allowEgress ? "true" : "false"}；最终值会在画布创建时冻结。`,
    ));
  }

  const errors = checks.filter((check) => check.severity === "error").length;
  const warnings = checks.filter((check) => check.severity === "warning").length;
  const infos = checks.filter((check) => check.severity === "info").length;
  return ReadinessResponse.parse({
    schema: "deepsonar.readiness/v1",
    ready: errors === 0 && !unresolved,
    execution_mode: input.executionMode,
    scope: { kind: input.scope.kind, project_id: input.scope.projectId },
    network_policy: {
      allow_egress: input.allowEgress,
      source: input.networkSource,
      material_source: materialSource,
    },
    checks,
    summary: { errors, warnings, infos },
    generated_at: now.toISOString(),
  });
}

function roleRowsForScope(rows: Array<Record<string, unknown>>): ReadinessRoleRow[] {
  return rows.map((row) => ({
    role_id: String(row.role_id),
    name: String(row.name),
    title: String(row.title ?? ""),
    kind: row.kind as ReadinessRoleRow["kind"],
    builtin: Boolean(row.builtin),
    project_config_id: (row.project_config_id as string | null) ?? null,
    project_config_scope: row.project_config_id ? "project" : "none",
    project_agent_cli: (row.project_agent_cli as string | null) ?? null,
    project_model: (row.project_model as string | null) ?? null,
    project_runtime_image_key: (row.project_runtime_image_key as string | null) ?? null,
    global_config_id: (row.global_config_id as string | null) ?? null,
    global_agent_cli: (row.global_agent_cli as string | null) ?? null,
    global_model: (row.global_model as string | null) ?? null,
    global_runtime_image_key: (row.global_runtime_image_key as string | null) ?? null,
  }));
}

/** Load the read-only projection from Scheduler-owned tables. */
export async function loadReadiness(
  db: typeof sql,
  options: {
    projectId?: string;
    allowEgress?: boolean;
    materialSource?: ReadinessMaterialSource;
  } = {},
): Promise<ReadinessResponseType> {
  const hostDisk = config.runtime.agentMode === "real" && config.runtime.provider === "local-docker"
    ? await refreshHostDiskPressure()
    : undefined;
  const projectId = options.projectId ?? null;
  const scope: ReadinessScopeInput = { kind: projectId ? "project" : "global", projectId };
  const projectRow = projectId
    ? await db`SELECT id, config_json, status FROM projects WHERE id = ${projectId}`
    : [];
  if (projectId && projectRow.length === 0) throw new Error("project not found");
  const projectConfig = projectRow[0]?.config_json as Record<string, unknown> | undefined;
  const rules: ProjectRules = projectId
    ? await rulesForProject(db, projectId)
    : await globalRules(db);
  const projectRules = (projectConfig?.rules ?? {}) as Record<string, unknown>;
  const networkSource: ReadinessEvaluationInput["networkSource"] = options.allowEgress !== undefined
    ? "task_override"
    : projectId && typeof projectRules.allowEgress === "boolean"
      ? "project"
      : "global";
  const roleRows = await db`
    SELECT r.id AS role_id, r.name, r.title, r.kind, r.builtin,
           pc.id AS project_config_id, pc.agent_cli AS project_agent_cli,
           pc.model AS project_model, pc.runtime_image_key AS project_runtime_image_key,
           gc.id AS global_config_id, gc.agent_cli AS global_agent_cli,
           gc.model AS global_model, gc.runtime_image_key AS global_runtime_image_key
    FROM agent_roles r
    LEFT JOIN role_configs pc ON pc.role_id = r.id AND pc.project_id = ${projectId}
    LEFT JOIN role_configs gc ON gc.role_id = r.id AND gc.project_id IS NULL
    WHERE r.kind IN ('hub', 'role')
    ORDER BY r.kind DESC, r.builtin DESC, r.name`;
  const allRoleRows = roleRowsForScope(roleRows as unknown as Array<Record<string, unknown>>);
  const selectedRoleNames = projectId
    ? new Set((await rolesForProject(db, projectId)).map((role) => role.name))
    : null;
  const roles = allRoleRows.filter((role) => role.kind === "hub" || !selectedRoleNames || selectedRoleNames.has(role.name));
  const configIds = roles.map((role) => role.project_config_id ?? role.global_config_id).filter((id): id is string => Boolean(id));
  const credentials = configIds.length === 0
    ? []
    : await db`
      SELECT rc.role_config_id, rc.purpose,
             c.id AS credential_id, c.name, c.kind, c.provider, c.project_id,
             c.status, c.public_metadata_json, c.agent_cli, c.settings_config_json
      FROM role_credentials rc
      LEFT JOIN credentials c ON c.id = rc.credential_id
      WHERE rc.role_config_id = ANY(${configIds})`;
  const credentialIds = (credentials as unknown as ReadinessCredentialRow[])
    .map((row) => row.credential_id)
    .filter((id): id is string => Boolean(id));
  const audits = credentialIds.length === 0
    ? []
    : await db`
      SELECT resource_id, action, at, result, after_json
      FROM audit_logs
      WHERE resource_type = 'credential'
        AND resource_id = ANY(${credentialIds})
        AND action IN ('credential.test', 'credential.models_discover')
      ORDER BY at DESC
      LIMIT 500`;
  const imagePolicy = parseProjectImagePolicy(projectConfig);
  const imageKeys = [...new Set(roles.map((role) => {
    if (!projectId) return role.global_runtime_image_key ?? defaultRuntimeImageKey(role.name);
    return runtimeImageKeyForProjectPolicy(imagePolicy, role.name, role.global_runtime_image_key) ?? defaultRuntimeImageKey(role.name);
  }))];
  const selectedChannel = await readRuntimeRegistryChannel(db);
  const images = await db`
    SELECT ri.image_key, ri.id AS runtime_image_id, ri.enabled AS image_enabled, ri.project_opt_in, ri.source_kind, ri.official,
           pri.enabled AS project_enabled,
           pri.selected_version_id,
           pin.version AS selected_version,
           v.id AS version_id,
           CASE WHEN ri.official THEN v.channel_digest ELSE v.digest END AS digest,
           CASE WHEN ri.official THEN v.channel_resolved_ref ELSE v.resolved_ref END AS resolved_ref,
           v.trust_status,
           EXISTS (
             SELECT 1 FROM runtime_image_versions revoked
             WHERE revoked.runtime_image_id = ri.id AND revoked.trust_status = 'revoked'
           ) AS has_revoked,
           v.platforms_json, v.promoted_at, v.approved_at, v.created_at,
           latest.id AS latest_version_id,
           latest.version AS latest_version,
           scan.id AS admission_scan_id,
           COALESCE(v.scan_summary_json->>'risk', '') = 'bypasses-admission-scan' AS admission_bypassed
    FROM runtime_images ri
    LEFT JOIN project_runtime_images pri
      ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
    LEFT JOIN runtime_image_versions pin
      ON pin.id = pri.selected_version_id
    LEFT JOIN LATERAL (
      SELECT v.*, selected_ref.digest AS channel_digest,
             selected_ref.resolved_ref AS channel_resolved_ref
      FROM runtime_image_versions v
      LEFT JOIN runtime_image_version_refs selected_ref
        ON selected_ref.version_id = v.id AND selected_ref.channel = ${selectedChannel}
      WHERE v.runtime_image_id = ri.id
        AND v.trust_status = 'trusted'
        AND (NOT ri.official OR selected_ref.id IS NOT NULL)
        AND (pri.selected_version_id IS NULL OR v.id = pri.selected_version_id)
        AND ri.enabled = true
        AND (CASE WHEN ri.official AND NOT ri.project_opt_in THEN COALESCE(pri.enabled, true) ELSE COALESCE(pri.enabled, false) END)
      ORDER BY CASE WHEN v.platforms_json @> ${db.json([hostRuntimePlatform()])} THEN 0
                    WHEN v.platforms_json IS NULL OR jsonb_array_length(v.platforms_json) = 0 THEN 1 ELSE 2 END,
               v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT v.id, v.version
      FROM runtime_image_versions v
      LEFT JOIN runtime_image_version_refs selected_ref
        ON selected_ref.version_id = v.id AND selected_ref.channel = ${selectedChannel}
      WHERE v.runtime_image_id = ri.id
        AND v.trust_status = 'trusted'
        AND v.platforms_json @> ${db.json([hostRuntimePlatform()])}
        AND (NOT ri.official OR selected_ref.id IS NOT NULL)
        AND ri.enabled = true
      ORDER BY v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT s.id FROM runtime_image_scans s
      WHERE s.runtime_image_version_id = v.id AND s.status = 'succeeded'
      ORDER BY s.finished_at DESC NULLS LAST LIMIT 1
    ) scan ON true
    WHERE ri.image_key = ANY(${imageKeys})`;
  return evaluateReadiness({
    scope,
    executionMode: config.runtime.agentMode === "real" ? "real" : "fake",
    projectStatus: (projectRow[0]?.status as "active" | "archived" | null | undefined) ?? null,
    hubEnabled: rules.hubEnabled,
    allowEgress: options.allowEgress ?? rules.allowEgress,
    networkSource,
    materialSource: options.materialSource,
    roles,
    projectImagePolicy: imagePolicy,
    credentials: credentials as unknown as ReadinessCredentialRow[],
    runtimeImages: images as unknown as ReadinessRuntimeImageRow[],
    audits: audits as unknown as ReadinessAuditRow[],
    hostDisk,
  });
}
