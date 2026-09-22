import type { BindableRoleConfig, Project, ProviderCredential } from "./api";
import { extractModelsFromSettingsClient, type AgentCli } from "./CredentialConfigEditor";

export const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  pi: "Pi Coding Agent",
  dsh: "DeepSeek Harness",
  "open-code": "OpenCode（已停用）",
  codex: "Codex（已停用）",
};

export const AGENT_CLI_OPTIONS: ReadonlyArray<{ value: AgentCli; label: string }> = [
  { value: "claude-code", label: "claude-code（Claude Code）" },
  { value: "pi", label: "pi（Pi Coding Agent）" },
  { value: "dsh", label: "dsh（DeepSeek Harness）" },
];

const HEALTH_STATUS_LABEL: Record<string, string> = {
  ok: "正常",
  error: "异常",
  unknown: "未知",
  degraded: "降级",
};

export function newBatchIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `provider-batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function healthStatusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return HEALTH_STATUS_LABEL[status] ?? status;
}

/** Models declared inside CC Switch settingsConfig (env / toml / official llm-pi-ai / open-code). */
export function modelsFromSettingsConfig(credential: Pick<ProviderCredential, "settings_config_json"> | null): string[] {
  return extractModelsFromSettingsClient(credential?.settings_config_json ?? null);
}

export function boundCredentialLabel(
  roleConfig: Pick<BindableRoleConfig, "credential_id" | "credential_name" | "credential_project_id" | "credential_project_name">,
  selectedCredentialId: string | null,
): string {
  if (!roleConfig.credential_id) return "未绑定";
  const shortId = roleConfig.credential_id.slice(0, 8);
  const scope = roleConfig.credential_project_id
    ? `项目 ${roleConfig.credential_project_name ?? `#${roleConfig.credential_project_id.slice(0, 8)}`}`
    : "全局";
  const other = selectedCredentialId && roleConfig.credential_id !== selectedCredentialId ? " · 已绑定另一账号" : "";
  return `${roleConfig.credential_name ?? "未命名"} · ${scope} #${shortId}${other}`;
}

export function sameLast4CredentialCount(
  credential: Pick<ProviderCredential, "provider" | "agent_cli" | "last4">,
  credentials: ReadonlyArray<Pick<ProviderCredential, "provider" | "agent_cli" | "last4">>,
): number {
  return credentials.filter((item) =>
    item.provider === credential.provider
    && (item.agent_cli ?? null) === (credential.agent_cli ?? null)
    && item.last4 === credential.last4
  ).length;
}

export function resolvedUpstreamModel(
  agentCli: string,
  requestedModel: string | null,
  settingsConfig: Record<string, unknown> | null | undefined,
): string | null {
  const settings = settingsConfig ?? {};
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  const main = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
  const requested = requestedModel?.trim() || main || null;
  if (!requested || agentCli !== "claude-code") return requested;
  const aliasKey = ({
    fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
    sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  } as const)[requested.toLowerCase() as "fable" | "sonnet" | "opus" | "haiku"];
  const mapped = aliasKey && typeof env[aliasKey] === "string" ? String(env[aliasKey]).trim() : "";
  return mapped || main || requested;
}

export function roleModelLabel(
  roleConfig: Pick<BindableRoleConfig, "agent_cli" | "model"> & Partial<Pick<BindableRoleConfig, "scope" | "project_id" | "image_strategy">>,
  credential: Pick<ProviderCredential, "settings_config_json"> | null,
): string {
  const requested = roleConfig.model?.trim() || modelsFromSettingsConfig(credential)[0] || null;
  if (!requested) return "未指定模型 · 将使用 CLI 内置默认（建议填写账号已配置的 provider 模型 id）";
  const upstream = resolvedUpstreamModel(roleConfig.agent_cli, requested, credential?.settings_config_json);
  if (upstream && upstream !== requested) {
    const aliasHint = ["fable", "sonnet", "opus", "haiku"].includes(requested.toLowerCase())
      ? "（由别名映射决定）"
      : "";
    return `CLI 选择 · ${requested} → 上游 · ${upstream}${aliasHint}`;
  }
  return roleConfig.model ? `Role 覆盖 · ${requested}` : `配置文件 · ${requested}`;
}

/** Account-configured provider model ids only (#656). Probed catalog is diagnostic-only. */
export function modelIds(credential: ProviderCredential | null): string[] {
  return [...new Set(modelsFromSettingsConfig(credential))].sort((a, b) => a.localeCompare(b));
}

/**
 * Selection allowlist: same SSOT as modelIds (settings_config_json), not probed model_catalog_json.
 * Name retained for call-site compatibility; do not merge health/probe catalogs here.
 */
export function rawModelCatalog(credential: ProviderCredential | null): string[] {
  return modelsFromSettingsConfig(credential);
}

export function asRoleCli(agentCli: string): AgentCli {
  return (["claude-code", "pi", "dsh", "codex", "open-code"].includes(agentCli) ? agentCli : "claude-code") as AgentCli;
}

export function filterEligibleRoleConfigs(
  roleConfigs: readonly BindableRoleConfig[],
  roleScopeFilter: "all" | "global" | string,
  selectedProjectId: string | null,
): BindableRoleConfig[] {
  return roleConfigs.filter((roleConfig) => {
    if (!roleConfig.can_bind) return false;
    if (roleScopeFilter === "global") {
      if (roleConfig.scope !== "global" && roleConfig.project_id) return false;
    } else if (roleScopeFilter !== "all") {
      if (String(roleConfig.project_id ?? "") !== roleScopeFilter) return false;
    }
    if (selectedProjectId && String(roleConfig.project_id ?? "") !== selectedProjectId) return false;
    return true;
  });
}

export function collectProjectsWithRoleConfigs(
  roleConfigs: readonly BindableRoleConfig[],
  projects: readonly Project[],
  selectedProjectId: string | null,
): Array<{ id: string; name: string; count: number }> {
  const map = new Map<string, { id: string; name: string; count: number }>();
  for (const roleConfig of roleConfigs) {
    if (!roleConfig.can_bind || !roleConfig.project_id) continue;
    if (selectedProjectId && String(roleConfig.project_id) !== selectedProjectId) continue;
    const existing = map.get(roleConfig.project_id);
    if (existing) existing.count += 1;
    else map.set(roleConfig.project_id, { id: roleConfig.project_id, name: roleConfig.project_name ?? "项目", count: 1 });
  }
  for (const project of projects) {
    if (selectedProjectId && project.id !== selectedProjectId) continue;
    if (!map.has(project.id)) map.set(project.id, { id: project.id, name: project.name, count: 0 });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export type RoleBindGroup = {
  key: string;
  title: string;
  kind: "global" | "project";
  items: BindableRoleConfig[];
  emptyHint?: string;
};

export function groupBindableRoles(
  eligibleRoleConfigs: readonly BindableRoleConfig[],
  projectsWithRoleConfigs: ReadonlyArray<{ id: string; name: string; count: number }>,
  roleScopeFilter: "all" | "global" | string,
): RoleBindGroup[] {
  const global: BindableRoleConfig[] = [];
  const byProject = new Map<string, { name: string; items: BindableRoleConfig[] }>();
  for (const roleConfig of eligibleRoleConfigs) {
    if (roleConfig.scope === "global" || !roleConfig.project_id) {
      global.push(roleConfig);
      continue;
    }
    const existing = byProject.get(roleConfig.project_id);
    if (existing) existing.items.push(roleConfig);
    else byProject.set(roleConfig.project_id, { name: roleConfig.project_name ?? "项目", items: [roleConfig] });
  }
  const sortRoles = (items: BindableRoleConfig[]) =>
    items.slice().sort((a, b) => {
      const kindRank = (rc: BindableRoleConfig) => (rc.role_kind === "system" ? 0 : rc.role_kind === "hub" ? 1 : 2);
      const d = kindRank(a) - kindRank(b);
      if (d !== 0) return d;
      return (a.role_title || a.role_name).localeCompare(b.role_title || b.role_name, "zh");
    });
  const groups: RoleBindGroup[] = [];
  if (roleScopeFilter === "all" || roleScopeFilter === "global") {
    if (global.length) groups.push({ key: "global", title: "全局配置", kind: "global", items: sortRoles(global) });
    else if (roleScopeFilter === "global") {
      groups.push({
        key: "global",
        title: "全局配置",
        kind: "global",
        items: [],
        emptyHint: "没有可绑定的全局角色配置（请检查 CLI 是否匹配）。",
      });
    }
  }
  const projectEntries = roleScopeFilter !== "all" && roleScopeFilter !== "global"
    ? projectsWithRoleConfigs.filter((project) => project.id === roleScopeFilter)
    : projectsWithRoleConfigs;
  for (const project of projectEntries) {
    const bucket = byProject.get(project.id);
    const items = bucket ? sortRoles(bucket.items) : [];
    if (items.length === 0 && roleScopeFilter === "all") continue;
    groups.push({
      key: project.id,
      title: `项目 · ${project.name}`,
      kind: "project",
      items,
      emptyHint: items.length === 0
        ? "该项目尚无角色覆盖配置。请到「角色注册表」为角色添加项目覆盖后，再在此绑定 Provider。"
        : undefined,
    });
  }
  return groups;
}

export function bindingGateReason(credential: Pick<ProviderCredential, "kind" | "status" | "provider_valid" | "health"> | null): string {
  if (!credential) return "";
  if (credential.provider_valid === false) return "请先修复 Provider 映射，再绑定。";
  if (credential.status !== "active") return "请先启用该账号，再绑定。";
  const health = credential.health;
  if (health?.status !== "ok" || !health.last_tested_at) {
    return "绑定前需最近一次连通性测试成功。请先到账号页测试连接后重试。";
  }
  if (credential.kind !== "llm_provider") return "仅 LLM Provider 账号可绑定到角色配置。";
  return "";
}
