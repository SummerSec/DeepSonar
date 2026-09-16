import { CURRENT_AGENT_CLIS, isCurrentAgentCli, type CurrentAgentCli } from "@deepsonar/shared-types";
import { PROVIDER_CATALOG, credentialConcurrencyPolicy } from "../../credentials.js";
import { PLATFORM_DEFAULT_AGENT_CLI } from "../role-runtime-snapshot/application.js";

export interface ProjectAgentAllowlist {
  /** true once enabled_agent_clis / enabled_credential_ids 已显式落库（含迁移种子）。 */
  configured: boolean;
  enabled_agent_clis: CurrentAgentCli[];
  enabled_credential_ids: string[];
  /** Hub 省略时的软缺省；必须 ∈ 白名单。 */
  default_agent_cli: CurrentAgentCli | null;
  default_credential_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseCliList(value: unknown): CurrentAgentCli[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const out: CurrentAgentCli[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isCurrentAgentCli(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function parseCredentialIdList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !UUID_RE.test(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function parseOptionalCli(value: unknown): CurrentAgentCli | null {
  return isCurrentAgentCli(value) ? value : null;
}

function parseOptionalCredentialId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * 读取项目 config_json 中的 CLI/Provider 白名单。
 * 缺键 = 尚未配置（configured=false）；由迁移种子补齐后才 fail-closed。
 */
export function parseProjectAgentAllowlist(value: unknown): ProjectAgentAllowlist {
  const cfg = asRecord(value);
  const clis = parseCliList(cfg.enabled_agent_clis);
  const creds = parseCredentialIdList(cfg.enabled_credential_ids);
  const configured = clis !== null || creds !== null;
  const enabled_agent_clis = clis ?? [...CURRENT_AGENT_CLIS];
  const enabled_credential_ids = creds ?? [];
  let default_agent_cli = parseOptionalCli(cfg.default_agent_cli);
  let default_credential_id = parseOptionalCredentialId(cfg.default_credential_id);
  if (default_agent_cli && !enabled_agent_clis.includes(default_agent_cli)) default_agent_cli = null;
  if (default_credential_id && !enabled_credential_ids.includes(default_credential_id)) {
    default_credential_id = null;
  }
  return { configured, enabled_agent_clis, enabled_credential_ids, default_agent_cli, default_credential_id };
}

export interface AllowlistBindingSeed {
  agent_clis: string[];
  credential_ids: string[];
}

/**
 * 迁移：把当前 RoleConfig 已绑定的 CLI / Credential 写入白名单，避免静默丢配置。
 * 仅在尚未 configured 时落库；已显式配置则不改写。
 */
export function seedProjectAgentAllowlist(
  cfg: Record<string, unknown>,
  seed: AllowlistBindingSeed,
): { changed: boolean; allowlist: ProjectAgentAllowlist } {
  const current = parseProjectAgentAllowlist(cfg);
  if (current.configured) return { changed: false, allowlist: current };

  const cliSet = new Set<CurrentAgentCli>();
  cliSet.add(PLATFORM_DEFAULT_AGENT_CLI);
  for (const cli of seed.agent_clis) {
    if (isCurrentAgentCli(cli)) cliSet.add(cli);
  }
  const credSet = new Set<string>();
  for (const id of seed.credential_ids) {
    if (typeof id === "string" && UUID_RE.test(id)) credSet.add(id);
  }

  cfg.enabled_agent_clis = [...cliSet];
  cfg.enabled_credential_ids = [...credSet];
  // 软缺省：优先已绑定的第一个 CLI/凭据，否则平台默认 CLI、无缺省凭据。
  const defaultCli = [...cliSet].find((c) => c !== PLATFORM_DEFAULT_AGENT_CLI) ?? PLATFORM_DEFAULT_AGENT_CLI;
  cfg.default_agent_cli = defaultCli;
  if (credSet.size === 1) cfg.default_credential_id = [...credSet][0];
  else delete cfg.default_credential_id;

  return { changed: true, allowlist: parseProjectAgentAllowlist(cfg) };
}

/** PATCH 校验并写回；缺省必须来自白名单。 */
export function applyProjectAgentAllowlistPatch(
  cfg: Record<string, unknown>,
  patch: {
    enabled_agent_clis?: string[];
    enabled_credential_ids?: string[];
    default_agent_cli?: string | null;
    default_credential_id?: string | null;
  },
): ProjectAgentAllowlist {
  if (patch.enabled_agent_clis !== undefined) {
    const clis = parseCliList(patch.enabled_agent_clis) ?? [];
    if (clis.length === 0) throw new Error("至少启用一种 Agent CLI（claude-code / pi / dsh）");
    cfg.enabled_agent_clis = clis;
  }
  if (patch.enabled_credential_ids !== undefined) {
    cfg.enabled_credential_ids = parseCredentialIdList(patch.enabled_credential_ids) ?? [];
  }
  if (patch.default_agent_cli !== undefined) {
    if (patch.default_agent_cli === null) delete cfg.default_agent_cli;
    else if (!isCurrentAgentCli(patch.default_agent_cli)) {
      throw new Error(`缺省 Agent CLI 非法: ${patch.default_agent_cli}`);
    } else cfg.default_agent_cli = patch.default_agent_cli;
  }
  if (patch.default_credential_id !== undefined) {
    if (patch.default_credential_id === null) delete cfg.default_credential_id;
    else if (!UUID_RE.test(patch.default_credential_id)) {
      throw new Error("缺省 Provider credential_id 必须是 UUID");
    } else cfg.default_credential_id = patch.default_credential_id;
  }

  // 确保键存在，标记为 configured。
  if (!Object.prototype.hasOwnProperty.call(cfg, "enabled_agent_clis")) {
    cfg.enabled_agent_clis = [...CURRENT_AGENT_CLIS];
  }
  if (!Object.prototype.hasOwnProperty.call(cfg, "enabled_credential_ids")) {
    cfg.enabled_credential_ids = [];
  }

  const enabledClis = parseCliList(cfg.enabled_agent_clis) ?? [...CURRENT_AGENT_CLIS];
  const enabledCreds = parseCredentialIdList(cfg.enabled_credential_ids) ?? [];
  const requestedCli = parseOptionalCli(cfg.default_agent_cli);
  const requestedCred = parseOptionalCredentialId(cfg.default_credential_id);
  // 显式 PATCH 缺省到白名单外 → 硬拒绝；仅当启用集合收缩时才静默清除旧缺省。
  if (patch.default_agent_cli !== undefined && patch.default_agent_cli !== null) {
    if (!requestedCli || !enabledClis.includes(requestedCli)) {
      throw new Error("缺省 Agent CLI 必须属于已启用白名单");
    }
  }
  if (patch.default_credential_id !== undefined && patch.default_credential_id !== null) {
    if (!requestedCred || !enabledCreds.includes(requestedCred)) {
      throw new Error("缺省 Provider 必须属于已启用白名单");
    }
  }
  if (requestedCli && !enabledClis.includes(requestedCli)) delete cfg.default_agent_cli;
  if (requestedCred && !enabledCreds.includes(requestedCred)) delete cfg.default_credential_id;
  return parseProjectAgentAllowlist(cfg);
}

export function assertAgentCliAllowlisted(
  allowlist: ProjectAgentAllowlist,
  agentCli: string,
): void {
  if (!isCurrentAgentCli(agentCli)) {
    throw new Error(`未知 agent_cli，当前仅支持 ${CURRENT_AGENT_CLIS.join(" / ")}`);
  }
  if (!allowlist.configured) return; // 迁移前不阻断
  if (!allowlist.enabled_agent_clis.includes(agentCli)) {
    throw new Error(`agent_cli=${agentCli} 不在本项目已启用白名单内`);
  }
}

export function assertCredentialAllowlisted(
  allowlist: ProjectAgentAllowlist,
  credentialId: string | null | undefined,
): void {
  if (!credentialId) return;
  if (!allowlist.configured) return;
  if (!allowlist.enabled_credential_ids.includes(credentialId)) {
    throw new Error(`credential_id=${credentialId} 不在本项目已启用 Provider 白名单内`);
  }
}

export function compatibleAgentClisForProvider(provider: string): CurrentAgentCli[] {
  const entry = PROVIDER_CATALOG.find((item) => item.provider === provider && item.kind === "llm_provider");
  if (!entry) return [];
  return entry.compatible_agent_cli.filter(isCurrentAgentCli);
}

export interface HubAgentCliCatalogEntry {
  agent_cli: CurrentAgentCli;
  is_default: boolean;
}

export interface HubProviderCatalogEntry {
  credential_id: string;
  name: string;
  provider: string;
  status: string;
  compatible_agent_clis: CurrentAgentCli[];
  max_concurrent: number | null;
  model_concurrency: Record<string, number>;
  is_default: boolean;
}

export function toHubAgentCliCatalog(
  allowlist: ProjectAgentAllowlist,
): HubAgentCliCatalogEntry[] {
  const clis = allowlist.configured
    ? allowlist.enabled_agent_clis
    : [...CURRENT_AGENT_CLIS];
  return clis.map((agent_cli) => ({
    agent_cli,
    is_default: allowlist.default_agent_cli === agent_cli,
  }));
}

export function toHubProviderCatalogEntry(
  row: {
    id: string;
    name: string;
    provider: string;
    status: string;
    public_metadata_json?: unknown;
  },
  allowlist: ProjectAgentAllowlist,
): HubProviderCatalogEntry | null {
  if (allowlist.configured && !allowlist.enabled_credential_ids.includes(row.id)) return null;
  const compatible = compatibleAgentClisForProvider(row.provider)
    .filter((cli) => !allowlist.configured || allowlist.enabled_agent_clis.includes(cli));
  if (compatible.length === 0) return null;
  if (row.status !== "active") return null;
  const policy = credentialConcurrencyPolicy(row.public_metadata_json);
  return {
    credential_id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    compatible_agent_clis: compatible,
    max_concurrent: policy.maxConcurrent,
    model_concurrency: policy.modelConcurrency,
    is_default: allowlist.default_credential_id === row.id,
  };
}
