import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle,
  GitBranch,
  Lightning,
  LockKey,
  PencilSimple,
  Plugs,
  Warning,
} from "@phosphor-icons/react";
import {
  api,
  type BindableRoleConfig,
  type CredentialBatchBindingResult,
  type CredentialImpact,
  type Project,
  type ProviderAccountCatalogItemView,
  type ProviderCredential,
  type RuntimeImageSummary,
} from "./api";
import {
  type AgentCli,
  buildSettingsConfigFromEditor,
  CredentialConfigEditor,
  extractContextWindowTokens,
  extractBaseUrlFromSettingsClient,
  extractSecretFromSettings,
  providerProtocolLabel,
  redactSecretText,
  redactSecretValues,
  restoreRedactedSecretText,
  restoreRedactedSecrets,
} from "./CredentialConfigEditor";
import { formatJsonObject } from "./json-text";
import { SearchableSelect } from "./SearchableSelect";
import { HelpTip } from "./ui";

type FlowStep = "account" | "roles" | "effect";

function newBatchIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `provider-batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const cliLabel: Record<string, string> = {
  "claude-code": "Claude Code",
  "open-code": "OpenCode",
  codex: "Codex",
  pi: "Pi Coding Agent",
  dsh: "DeepSeek Harness",
};

const AGENT_CLI_OPTIONS: ReadonlyArray<{ value: AgentCli; label: string }> = [
  { value: "claude-code", label: "claude-code（Claude Code）" },
  { value: "codex", label: "codex（Codex）" },
  { value: "open-code", label: "open-code（OpenCode）" },
  { value: "pi", label: "pi（Pi Coding Agent）" },
  { value: "dsh", label: "dsh（DeepSeek Harness）" },
];

/** Resolve hub / system / role even if bindable API omits role_kind (legacy scheduler). */
function resolveBindableRoleKind(roleConfig: BindableRoleConfig): "hub" | "system" | "role" {
  const kind = roleConfig.role_kind;
  if (kind === "hub" || kind === "system" || kind === "role") return kind;
  const name = (roleConfig.role_name ?? "").toLowerCase();
  const title = roleConfig.role_title ?? "";
  if (name === "hub" || name === "hub_reason" || title.includes("决策中枢") || title.toLowerCase().includes("hub")) {
    return "hub";
  }
  if (
    name === "verify"
    || name === "report"
    || title.includes("验证")
    || title.includes("报告")
    || title.includes("调度内核")
  ) {
    return "system";
  }
  return "role";
}

function isBuiltinBindableRole(roleConfig: BindableRoleConfig): boolean {
  if (typeof roleConfig.role_builtin === "boolean") return roleConfig.role_builtin;
  // Seed builtins when API omits the flag.
  return ["explore", "analyze", "review", "test", "code", "audit", "hub_reason", "hub", "verify", "report"]
    .includes((roleConfig.role_name ?? "").toLowerCase());
}

/** Models declared inside CC Switch settingsConfig (env / toml / open-code). */
function modelsFromSettingsConfig(credential: ProviderCredential | null): string[] {
  if (!credential?.settings_config_json) return [];
  const settings = credential.settings_config_json;
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !found.includes(value.trim())) found.push(value.trim());
  };
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  push(env.ANTHROPIC_MODEL);
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  push(settings.model);
  const openCodeModels = settings.models && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models as Record<string, unknown>
    : {};
  for (const model of Object.keys(openCodeModels)) push(model);
  const piProviders = settings.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
    ? settings.providers as Record<string, unknown>
    : {};
  for (const rawProvider of Object.values(piProviders)) {
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
    const models = (rawProvider as Record<string, unknown>).models;
    if (Array.isArray(models)) {
      for (const rawModel of models) {
        if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) push((rawModel as Record<string, unknown>).id);
      }
    } else if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const model of Object.keys(models as Record<string, unknown>)) push(model);
    }
  }
  if (typeof settings.config === "string") {
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    push(match?.[1] || match?.[2]);
  }
  return found;
}

function modelIds(credential: ProviderCredential | null): string[] {
  if (!credential) return [];
  const catalog = credential.health?.model_catalog ?? credential.model_catalog_json ?? [];
  const allowed = credential.public_metadata_json?.allowed_model_ids;
  const allowlist = Array.isArray(allowed)
    ? new Set(allowed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))
    : null;
  const fromCatalog = Array.isArray(catalog)
    ? catalog.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item) => !allowlist || allowlist.has(item))
    : [];
  const fromSettings = modelsFromSettingsConfig(credential).filter((item) => !allowlist || allowlist.has(item));
  // Prefer catalog (health probe) but keep settingsConfig models so binding is not blocked
  // when the profile already declares a model and the catalog is still warming up.
  return [...new Set([...fromCatalog, ...fromSettings])].sort((a, b) => a.localeCompare(b));
}

function rawModelCatalog(credential: ProviderCredential | null): string[] {
  if (!credential) return [];
  const catalog = credential.health?.model_catalog ?? credential.model_catalog_json ?? [];
  const fromCatalog = Array.isArray(catalog)
    ? catalog.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  return [...new Set([...fromCatalog, ...modelsFromSettingsConfig(credential)])];
}

const HEALTH_STATUS_LABEL: Record<string, string> = {
  ok: "正常",
  error: "异常",
  unknown: "未知",
  degraded: "降级",
};

function healthStatusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return HEALTH_STATUS_LABEL[status] ?? status;
}

export function ProviderAccountFlow({
  credentials,
  projects,
  onChanged,
}: {
  credentials: ProviderCredential[];
  projects: Project[];
  onChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<ProviderAccountCatalogItemView[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<BindableRoleConfig[]>([]);
  const [runtimeImages, setRuntimeImages] = useState<RuntimeImageSummary[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(() => new Set());
  const [actorProjectId, setActorProjectId] = useState<string | null>(null);
  const [sourceCredentialId, setSourceCredentialId] = useState("");
  const [mode, setMode] = useState<"bind" | "migrate">("bind");
  const [effect, setEffect] = useState<"new_jobs_only" | "refresh_pending">("new_jobs_only");
  const [repairProvider, setRepairProvider] = useState("");
  const [step, setStep] = useState<FlowStep>("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [impact, setImpact] = useState<CredentialBatchBindingResult | null>(null);
  const [previewImpact, setPreviewImpact] = useState<CredentialImpact | null>(null);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [createDiscovering, setCreateDiscovering] = useState(false);
  const [createModels, setCreateModels] = useState<string[]>([]);
  const [createName, setCreateName] = useState("");
  const [createProvider, setCreateProvider] = useState("");
  const [createSecret, setCreateSecret] = useState("");
  const [createBaseUrl, setCreateBaseUrl] = useState("");
  const [createAgentCli, setCreateAgentCli] = useState<AgentCli>("claude-code");
  const [createSettingsJson, setCreateSettingsJson] = useState("");
  const [createTomlText, setCreateTomlText] = useState("");
  const [createAuthJson, setCreateAuthJson] = useState("");
  const [createContextWindowTokens, setCreateContextWindowTokens] = useState("");
  const [createProjectId, setCreateProjectId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editingCredentialId, setEditingCredentialId] = useState("");
  const [editName, setEditName] = useState("");
  const [editProvider, setEditProvider] = useState("");
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>("claude-code");
  const [editProjectId, setEditProjectId] = useState("");
  const [editSettingsJson, setEditSettingsJson] = useState("");
  const [editTomlText, setEditTomlText] = useState("");
  const [editAuthJson, setEditAuthJson] = useState("");
  const [editContextWindowTokens, setEditContextWindowTokens] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editOriginalSettings, setEditOriginalSettings] = useState<Record<string, unknown> | null>(null);
  const [editOriginalAgentCli, setEditOriginalAgentCli] = useState<AgentCli | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [batchIdempotencyKey, setBatchIdempotencyKey] = useState(newBatchIdempotencyKey);
  /** Bind list scope: all | global-only | one project id */
  const [roleScopeFilter, setRoleScopeFilter] = useState<"all" | "global" | string>("all");

  const selectedCredential = credentials.find((credential) => credential.id === selectedCredentialId) ?? null;
  const editingCredential = credentials.find((credential) => credential.id === editingCredentialId) ?? null;
  const models = useMemo(() => modelIds(selectedCredential), [selectedCredential]);
  /** Roles currently bound to the selected credential (from bindable list). */
  const boundRoleIds = useMemo(() => {
    if (!selectedCredentialId) return [] as string[];
    return roleConfigs
      .filter((roleConfig) => roleConfig.can_bind && roleConfig.credential_id === selectedCredentialId)
      .map((roleConfig) => roleConfig.id);
  }, [roleConfigs, selectedCredentialId]);
  const boundRoleCount = selectedCredential?.bound_role_config_count ?? boundRoleIds.length;
  const selectedRoles = useMemo(
    () => roleConfigs.filter((roleConfig) => selectedRoleIds.has(roleConfig.id)),
    [roleConfigs, selectedRoleIds],
  );
  const sourceOptions = useMemo(() => {
    const ids = new Set(selectedRoles.map((roleConfig) => roleConfig.credential_id).filter((id): id is string => Boolean(id)));
    return credentials.filter((credential) => ids.has(credential.id));
  }, [credentials, selectedRoles]);
  const targetProvider = selectedCredential?.provider ?? "";
  const targetCatalog = catalog.find((item) => item.provider === targetProvider) ?? null;
  const createCatalog = catalog.find((item) => item.provider === createProvider) ?? null;
  const currentCatalog = useMemo(() => rawModelCatalog(selectedCredential), [selectedCredential]);
  const connectionHealthy = Boolean(
    selectedCredential
      && selectedCredential.status === "active"
      && selectedCredential.provider_valid !== false
      && selectedCredential.health?.status === "ok"
      && selectedCredential.health.last_tested_at,
  );
  // Binding keeps an optional RoleConfig model override. Credential settings remain
  // the default model source; catalog refresh is optional reference only.
  const bindingGateReason = !selectedCredential
    ? "请先选择 Provider 账号。"
    : selectedCredential.provider_valid === false
      ? "请先修复 Provider 映射，再绑定。"
      : selectedCredential.status !== "active"
        ? "请先启用该账号，再绑定。"
        : !connectionHealthy
          ? "绑定前需最近一次连通性测试成功。请先测试连接后重试。"
          : selectedCredential.kind !== "llm_provider"
            ? "仅 LLM Provider 账号可绑定到角色配置。"
            : "";
  /**
   * Roles listed for binding/CLI edit: can_bind + scope filter.
   * Do NOT hide CLI-mismatched rows — user must be able to change RoleConfig.agent_cli
   * here (e.g. codex → claude-code) before binding to the account.
   */
  const eligibleRoleConfigs = useMemo(() => {
    return roleConfigs.filter((roleConfig) => {
      if (!roleConfig.can_bind) return false;
      if (roleScopeFilter === "global") {
        if (roleConfig.scope !== "global" && roleConfig.project_id) return false;
      } else if (roleScopeFilter !== "all") {
        if (String(roleConfig.project_id ?? "") !== roleScopeFilter) return false;
      }
      // Project-scoped credentials can only bind same-project RoleConfigs.
      if (selectedCredential?.project_id) {
        if (String(roleConfig.project_id ?? "") !== String(selectedCredential.project_id)) return false;
      }
      return true;
    });
  }, [roleConfigs, selectedCredential?.project_id, roleScopeFilter]);

  /** Projects that have at least one bindable RoleConfig (for the scope picker). */
  const projectsWithRoleConfigs = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const roleConfig of roleConfigs) {
      if (!roleConfig.can_bind || !roleConfig.project_id) continue;
      if (selectedCredential?.project_id && String(roleConfig.project_id) !== String(selectedCredential.project_id)) continue;
      const id = roleConfig.project_id;
      const existing = map.get(id);
      if (existing) existing.count += 1;
      else map.set(id, { id, name: roleConfig.project_name ?? "项目", count: 1 });
    }
    // Also list known projects (even if 0 overrides) so user can switch scope explicitly.
    for (const project of projects) {
      if (selectedCredential?.project_id && project.id !== selectedCredential.project_id) continue;
      if (!map.has(project.id)) map.set(project.id, { id: project.id, name: project.name, count: 0 });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [roleConfigs, projects, selectedCredential?.project_id]);

  /** Group bindable roles: 全局配置 → 各项目；系统角色单独着色。 */
  const roleBindGroups = useMemo(() => {
    type Group = { key: string; title: string; kind: "global" | "project"; items: BindableRoleConfig[]; emptyHint?: string };
    const global: BindableRoleConfig[] = [];
    const byProject = new Map<string, { name: string; items: BindableRoleConfig[] }>();
    for (const roleConfig of eligibleRoleConfigs) {
      if (roleConfig.scope === "global" || !roleConfig.project_id) {
        global.push(roleConfig);
        continue;
      }
      const key = roleConfig.project_id;
      const existing = byProject.get(key);
      if (existing) existing.items.push(roleConfig);
      else byProject.set(key, { name: roleConfig.project_name ?? "项目", items: [roleConfig] });
    }
    const sortRoles = (items: BindableRoleConfig[]) =>
      items.slice().sort((a, b) => {
        const kindRank = (rc: BindableRoleConfig) => {
          const kind = resolveBindableRoleKind(rc);
          return kind === "system" ? 0 : kind === "hub" ? 1 : 2;
        };
        const d = kindRank(a) - kindRank(b);
        if (d !== 0) return d;
        return (a.role_title || a.role_name).localeCompare(b.role_title || b.role_name, "zh");
      });
    const groups: Group[] = [];
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
      ? projectsWithRoleConfigs.filter((p) => p.id === roleScopeFilter)
      : projectsWithRoleConfigs;
    for (const project of projectEntries) {
      const bucket = byProject.get(project.id);
      const items = bucket ? sortRoles(bucket.items) : [];
      if (items.length === 0 && roleScopeFilter === "all") continue; // keep "全部" uncluttered
      groups.push({
        key: project.id,
        title: `项目 · ${project.name}`,
        kind: "project",
        items,
        emptyHint: items.length === 0
          ? "该项目尚无角色覆盖配置。请到「Agent 管理 → 项目设置」为角色添加项目覆盖后，再在此绑定 Provider。"
          : undefined,
      });
    }
    return groups;
  }, [eligibleRoleConfigs, projectsWithRoleConfigs, roleScopeFilter]);

  const incompatibleRoles = selectedRoles.filter((roleConfig) => {
    if (bindingGateReason) return true;
    if (selectedCredential?.agent_cli && roleConfig.agent_cli !== selectedCredential.agent_cli) return true;
    if (!targetCatalog || !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli)) return true;
    return false;
  });
  const unbindableSelectedRoles = selectedRoles.filter((roleConfig) => !roleConfig.can_bind);

  useEffect(() => {
    api.authMe().then((me) => setActorProjectId(me.actor?.project_id ?? null)).catch(() => setActorProjectId(null));
    api.credentialProviders().then(setCatalog).catch(() => {});
    api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
  }, []);

  useEffect(() => {
    if (!createProvider) {
      const firstProvider = catalog.find((item) => item.kind === "llm_provider");
      if (firstProvider) setCreateProvider(firstProvider.provider);
    }
  }, [catalog, createProvider]);

  // Same catalog as 镜像市场：enabled 镜像全量可选（官方含 OpenHarmony project_opt_in）。
  // project_id 仅用于选项上标注「需项目启用」；第三方未启用时仍过滤（与后端一致）。
  useEffect(() => {
    const projectId =
      roleScopeFilter !== "all" && roleScopeFilter !== "global"
        ? roleScopeFilter
        : selectedCredential?.project_id ?? actorProjectId ?? undefined;
    api.runtimeImages(projectId || undefined).then(setRuntimeImages).catch(() => setRuntimeImages([]));
  }, [roleScopeFilter, selectedCredential?.project_id, actorProjectId]);

  /** Marketplace-aligned options for a RoleConfig row (null key = system base). */
  const runtimeImageOptionsFor = (projectId: string | null): RuntimeImageSummary[] => {
    return runtimeImages
      .filter((image) => {
        if (!image.enabled) return false;
        // Official (base + specialty + OpenHarmony opt-in): always list, match market.
        if (image.official) return true;
        // Third-party: only when project has enabled it (or show if no project context with warning via option label).
        if (projectId) return image.project_enabled === true;
        return false;
      })
      .slice()
      .sort((a, b) => {
        const aBase = a.image_key === "deepsonar-base" ? 0 : a.official ? 1 : 2;
        const bBase = b.image_key === "deepsonar-base" ? 0 : b.official ? 1 : 2;
        if (aBase !== bBase) return aBase - bBase;
        return a.name.localeCompare(b.name, "zh");
      });
  };

  const runtimeImageOptionLabel = (image: RuntimeImageSummary, projectId: string | null): string => {
    const kind =
      image.image_key === "deepsonar-base"
        ? "底座"
        : image.official
          ? image.project_opt_in
            ? "专项·项目启用"
            : "专项"
          : "第三方";
    const needsProject =
      image.official && image.project_opt_in && projectId && image.project_enabled !== true
        ? " · 未在项目启用"
        : image.official && image.project_opt_in && !projectId
          ? " · 运行前需项目启用"
          : "";
    return `${image.name} · ${kind}${needsProject}`;
  };

  useEffect(() => {
    setCreateProjectId(actorProjectId ?? "");
  }, [actorProjectId]);

  useEffect(() => {
    if (!selectedCredentialId && credentials.length > 0) {
      setSelectedCredentialId(credentials.find((credential) => credential.kind === "llm_provider")?.id ?? credentials[0].id);
    }
  }, [credentials, selectedCredentialId]);

  // Prefill checkboxes from roles already bound to this credential (not "0 selected" after a successful bind).
  const boundRoleKey = boundRoleIds.slice().sort().join(",");
  useEffect(() => {
    if (!selectedCredentialId) {
      setSelectedRoleIds(new Set());
      return;
    }
    setSelectedRoleIds(new Set(boundRoleKey ? boundRoleKey.split(",") : []));
  }, [selectedCredentialId, boundRoleKey]);

  useEffect(() => {
    if (!selectedCredential) return;
    setRepairProvider(selectedCredential.provider_valid === false ? "" : selectedCredential.provider);
    const candidates = roleConfigs
      .filter((roleConfig) => selectedRoleIds.has(roleConfig.id))
      .map((roleConfig) => roleConfig.credential_id)
      .filter((id): id is string => Boolean(id));
    setSourceCredentialId(candidates.length && new Set(candidates).size === 1 ? candidates[0] : "");
    // Project-scoped account → default bind list to that project.
    if (selectedCredential.project_id) setRoleScopeFilter(selectedCredential.project_id);
    // Only re-derive when the selected account changes; do not fight user checkbox edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: selectedCredentialId gate
  }, [selectedCredentialId]);

  const loadEditorFromCredential = (credential: ProviderCredential) => {
    const settings = credential.settings_config_json ?? {};
    const cli = (credential.agent_cli as AgentCli | null) ?? "claude-code";
    setEditOriginalSettings(settings);
    setEditOriginalAgentCli(cli);
    setEditName(credential.name);
    setEditProvider(credential.provider);
    setEditAgentCli(cli);
    setEditProjectId(credential.project_id ?? "");
    setEditContextWindowTokens(extractContextWindowTokens(settings));
    if (cli === "codex") {
      const auth = settings.auth && typeof settings.auth === "object" && !Array.isArray(settings.auth)
        ? settings.auth as Record<string, unknown>
        : {};
      setEditAuthJson(Object.keys(auth).length > 0 ? formatJsonObject(redactSecretValues(auth) as Record<string, unknown>) : "");
      setEditTomlText(typeof settings.config === "string" ? redactSecretText(settings.config) : "");
      setEditSettingsJson("");
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    } else {
      setEditSettingsJson(Object.keys(settings).length > 0 ? formatJsonObject(redactSecretValues(settings) as Record<string, unknown>) : "");
      setEditTomlText("");
      setEditAuthJson("");
      // Existing Credential secrets are never copied into the editable API Key field.
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    }
  };

  const openEditCredential = (credential: ProviderCredential) => {
    setSelectedCredentialId(credential.id);
    setShowCreate(false);
    if (editingCredentialId === credential.id) {
      setEditingCredentialId("");
      return;
    }
    loadEditorFromCredential(credential);
    setEditingCredentialId(credential.id);
    setStep("account");
  };

  useEffect(() => {
    setCatalogError("");
    setPreviewImpact(null);
    if (selectedCredentialId) {
      api.credentialImpact(selectedCredentialId).then(setPreviewImpact).catch(() => setPreviewImpact(null));
    }
  }, [selectedCredentialId]);

  const createAccount = async () => {
    if (actorProjectId && createProjectId !== actorProjectId) {
      setError("项目作用域账号只能在本项目内创建 Provider 账号。");
      return;
    }
    const built = buildSettingsConfigFromEditor({
      agentCli: createAgentCli,
      settingsJson: createSettingsJson,
      tomlText: createTomlText,
      authJson: createAuthJson,
      secret: createSecret,
      baseUrl: createBaseUrl,
      provider: createProvider,
      contextWindowTokens: createContextWindowTokens,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const secret = createSecret.trim() || extractSecretFromSettings(built.settings);
    if (!secret) {
      setError("请填写 API Key，或直接粘贴含密钥的完整 settingsConfig（如 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）。");
      return;
    }
    const baseUrl = (createBaseUrl.trim() || extractBaseUrlFromSettingsClient(built.settings)).replace(/\/+$/u, "");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createCredential({
        name: createName.trim(),
        kind: "llm_provider",
        provider: createProvider,
        secret,
        project_id: actorProjectId ?? (createProjectId || null),
        metadata: createCatalog?.supports_base_url && baseUrl ? { base_url: baseUrl } : {},
        agent_cli: createAgentCli,
        settings_config: built.settings,
        meta: {},
      });
      setCreateSecret("");
      setCreateName("");
      setCreateBaseUrl("");
      setCreateSettingsJson("");
      setCreateTomlText("");
      setCreateAuthJson("");
      setCreateContextWindowTokens("");
      setSelectedCredentialId(created.id);
      setEditingCredentialId("");
      setShowCreate(false);
      setStep("roles");
      onChanged();
      setNotice(built.pastedAsIs
        ? "已按粘贴的完整配置直接保存。正在测试连接…"
        : "账号已保存。正在测试连接…");
      setTesting(true);
      try {
        const health = await api.testCredential(created.id);
        if (!health.ok) {
          setError(`账号已保存，但连接失败：${health.detail}${health.category ? `（${health.category}）` : ""}。请展开编辑修正后重试。`);
          return;
        }
        setDiscovering(true);
        try {
          const catalogResult = await api.credentialModels(created.id);
          setCatalogError("");
          setNotice(
            catalogResult.models.length > 0
              ? `账号已就绪：连接正常，模型目录 ${catalogResult.models.length} 个。可绑定角色。`
              : "账号连接正常。可绑定角色。",
          );
        } catch (catalogError) {
          setCatalogError(String(catalogError));
          setNotice("账号连接正常。模型目录刷新失败可稍后重试。");
        } finally {
          setDiscovering(false);
        }
      } catch (healthError) {
        setError(`账号已保存，健康检查失败：${String(healthError)}`);
      } finally {
        setTesting(false);
        onChanged();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const discoverCreateModels = async () => {
    if (!createProvider || !createSecret.trim()) {
      setError("请先填写 Provider 和 API Key");
      return;
    }
    const built = buildSettingsConfigFromEditor({
      agentCli: createAgentCli,
      settingsJson: createSettingsJson,
      tomlText: createTomlText,
      authJson: createAuthJson,
      secret: createSecret,
      baseUrl: createBaseUrl,
      provider: createProvider,
      contextWindowTokens: createContextWindowTokens,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const baseUrl = (createBaseUrl.trim() || extractBaseUrlFromSettingsClient(built.settings)).replace(/\/+$/u, "");
    setCreateDiscovering(true);
    setError("");
    try {
      const result = await api.credentialModelsPreview({
        agent_cli: createAgentCli,
        provider: createProvider,
        secret: createSecret,
        metadata: createCatalog?.supports_base_url && baseUrl ? { base_url: baseUrl } : {},
        settings_config: built.settings,
      });
      setCreateModels(result.models);
      setNotice(`模型目录已获取：${result.models.length} 个，可在配置中选择。`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateDiscovering(false);
    }
  };

  /** Edit save uses the same settingsConfig builder as create (paste-as-is). */
  const saveEditedConfig = async () => {
    if (!editingCredential) return;
    const built = buildSettingsConfigFromEditor({
      agentCli: editAgentCli,
      settingsJson: editSettingsJson,
      tomlText: editTomlText,
      authJson: editAuthJson,
      secret: editApiKey,
      baseUrl: editBaseUrl,
      provider: editProvider,
      contextWindowTokens: editContextWindowTokens,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const settingsToSave = editOriginalSettings && editOriginalAgentCli === editAgentCli
      ? restoreRedactedSecrets(editOriginalSettings, built.settings) as Record<string, unknown>
      : built.settings;
    if (typeof settingsToSave.config === "string" && typeof editOriginalSettings?.config === "string") {
      settingsToSave.config = restoreRedactedSecretText(editOriginalSettings.config, settingsToSave.config);
    }
    const baseUrl = (editBaseUrl.trim() || extractBaseUrlFromSettingsClient(settingsToSave)).replace(/\/+$/u, "");
    setBusy(true);
    setError("");
    try {
      const existingMeta = editingCredential.public_metadata_json ?? {};
      const metadata = { ...existingMeta };
      if (baseUrl) metadata.base_url = baseUrl;
      else delete metadata.base_url;
      await api.updateCredential(editingCredential.id, {
        name: editName.trim() || editingCredential.name,
        agent_cli: editAgentCli,
        settings_config: settingsToSave,
        metadata,
      });
      // Keep credential.secret column in sync when config carries a new key (same as create path).
      if (editApiKey.trim()) {
        await api.rotateCredential(editingCredential.id, editApiKey.trim());
      }
      setNotice(built.pastedAsIs
        ? "配置已原样保存（与创建逻辑一致）。请重新测试连接后再绑定。"
        : "配置已保存（与创建逻辑一致）。请重新测试连接后再绑定。");
      setEditingCredentialId("");
      setEditOriginalSettings(null);
      setEditOriginalAgentCli(null);
      setSelectedCredentialId(editingCredential.id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    if (!selectedCredential) return;
    setTesting(true);
    setError("");
    try {
      const result = await api.testCredential(selectedCredential.id);
      if (result.ok) {
        setNotice(`连接正常：${result.detail}`);
        setStep("roles");
      } else {
        setError(`连接失败：${result.detail}${result.category ? `（${result.category}）` : ""}。请修复后再次测试，再绑定。`);
      }
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const discoverModels = async () => {
    if (!selectedCredential) return;
    setDiscovering(true);
    setError("");
    try {
      const result = await api.credentialModels(selectedCredential.id);
      setCatalogError("");
      setNotice(
        result.models.length > 0
          ? `模型目录已刷新：${result.models.length} 个（参考，不作为绑定门槛）。`
          : "模型目录为空。不影响绑定；角色继续使用自身模型。",
      );
      onChanged();
    } catch (e) {
      const detail = String(e);
      setCatalogError(detail);
      setError(detail);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleRole = (id: string) => {
    const roleConfig = roleConfigs.find((item) => item.id === id);
    if (!roleConfig?.can_bind) return;
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setImpact(null);
    setNotice("");
  };

  const repair = async () => {
    if (!selectedCredential || !repairProvider) return;
    setBusy(true);
    setError("");
    try {
      await api.updateCredential(selectedCredential.id, { provider: repairProvider });
      setNotice("Provider 映射已修复。原始遗留值不会展示或回传。");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!selectedCredential || selectedRoleIds.size === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    setImpact(null);
    try {
      if (bindingGateReason) throw new Error(bindingGateReason);
      if (unbindableSelectedRoles.length > 0) throw new Error("项目作用域操作者只能绑定本项目的角色配置。");
      if (mode === "migrate" && !sourceCredentialId) throw new Error("请选择要迁移的源账号");
      if (incompatibleRoles.length > 0) throw new Error("部分所选角色配置与当前账号 CLI 不兼容");
      // Compatibility resolves the optional RoleConfig override first, then the
      // selected Credential's CLI-specific settings.
      const checks = await Promise.all(selectedRoles.map((roleConfig) =>
        api.credentialCompatibility(selectedCredential.id, roleConfig.agent_cli, roleConfig.model),
      ));
      const failed = checks.find((check) => !check.compatible);
      if (failed) throw new Error(failed.error ?? "Provider 与 Agent CLI 不兼容");
      const result = await api.bindCredentialsBatch({
        credential_id: selectedCredential.id,
        role_config_ids: [...selectedRoleIds],
        mode,
        ...(mode === "migrate" ? { source_credential_id: sourceCredentialId } : {}),
        effect,
        idempotency_key: batchIdempotencyKey,
      });
      setImpact(result);
      setNotice(effect === "refresh_pending"
        ? `已原子生效。已绑定 ${result.role_config_count} 个角色配置；刷新了 ${result.refreshed_pending_job_count} 个 pending 快照；运行中快照保持冻结。`
        : `已原子生效（仅新 Job）。已绑定 ${result.role_config_count} 个角色配置；已有 pending 与运行中快照保持冻结。`);
      setStep("effect");
      setBatchIdempotencyKey(newBatchIdempotencyKey());
      const [nextRoles, nextImpact] = await Promise.all([
        api.bindableRoleConfigs().catch(() => null),
        api.credentialImpact(selectedCredential.id).catch(() => null),
      ]);
      if (nextRoles) setRoleConfigs(nextRoles);
      if (nextImpact) setPreviewImpact(nextImpact);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps: Array<{ key: FlowStep; label: string; detail: string }> = [
    { key: "account", label: "Provider 账号", detail: selectedCredential
      ? providerProtocolLabel(selectedCredential.provider, (selectedCredential.agent_cli as AgentCli | null) ?? "claude-code", catalog)
      : "选择账号" },
    {
      key: "roles",
      label: "角色绑定",
      detail: selectedCredential
        ? `已绑定 ${boundRoleCount} · 本次勾选 ${selectedRoleIds.size}`
        : "选择角色配置",
    },
    { key: "effect", label: "生效策略", detail: effect === "refresh_pending" ? "刷新 pending" : "仅新 Job" },
  ];
  const stepIndex = steps.findIndex((item) => item.key === step);
  const canEnterRoles = Boolean(selectedCredential);
  const canEnterEffect = Boolean(selectedCredential);

  const goToStep = (next: FlowStep) => {
    if (next === "roles" && !canEnterRoles) {
      setError("请先选择 Provider 账号，再进入角色绑定。");
      setStep("account");
      return;
    }
    if (next === "effect" && !canEnterEffect) {
      setError("请先选择 Provider 账号，再进入生效策略。");
      setStep("account");
      return;
    }
    setError("");
    setStep(next);
  };

  return (
    <section className="provider-flow-shell" aria-label="Provider 账号流程">
      <div className="provider-flow-head">
        <div>
          <div className="provider-flow-eyebrow"><GitBranch size={13} weight="bold" /> 闭环 / 账号管控</div>
          <h2>接入账号，再完成绑定闭环。</h2>
          <p>按步骤完成：选账号 → 勾选角色 → 设定生效范围并应用。顶部步骤会切换下方内容。</p>
        </div>
        <div className="provider-flow-lock"><LockKey size={14} /> 密钥仅在创建或轮换时出现</div>
      </div>

      <div className="provider-flow-steps" role="list">
        {steps.map((item, index) => {
          const locked = (item.key === "roles" && !canEnterRoles) || (item.key === "effect" && !canEnterEffect);
          return (
            <button
              key={item.key}
              type="button"
              role="listitem"
              className={[
                "provider-flow-step",
                step === item.key ? "is-active" : "",
                index < stepIndex ? "is-complete" : "",
                locked ? "is-locked" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => goToStep(item.key)}
              aria-current={step === item.key ? "step" : undefined}
              title={locked ? "请先选择 Provider 账号" : undefined}
            >
              <span className="provider-flow-step-index">
                {index < stepIndex ? <Check size={12} weight="bold" /> : `0${index + 1}`}
              </span>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              {index < steps.length - 1 && <ArrowRight size={14} className="provider-flow-arrow" />}
            </button>
          );
        })}
      </div>

      {notice && <div className="provider-flow-notice"><CheckCircle size={15} /> {notice}</div>}
      {error && <div className="provider-flow-error"><Warning size={15} /> {error}</div>}

      <div className="provider-flow-grid">
        {step === "account" && (
        <div className="provider-flow-card provider-flow-account-card">
          <div className="provider-flow-card-kicker">01 / 账号列表</div>
          <div className="provider-flow-account-label-row">
            <label className="provider-flow-label">已保存的 Provider 账号</label>
            <button
              type="button"
              className="provider-flow-inline-action"
              onClick={() => {
                setEditingCredentialId("");
                setShowCreate((value) => !value);
              }}
            >
              {showCreate ? "收起添加表单" : "添加账号"}
            </button>
          </div>

          {showCreate && (
            <CredentialConfigEditor
              mode="create"
              name={createName}
              onNameChange={setCreateName}
              provider={createProvider}
              onProviderChange={setCreateProvider}
              agentCli={createAgentCli}
              onAgentCliChange={setCreateAgentCli}
              projectId={createProjectId}
              onProjectIdChange={setCreateProjectId}
              projects={projects}
              actorProjectId={actorProjectId}
              providerCatalog={catalog}
              secret={createSecret}
              onSecretChange={setCreateSecret}
              baseUrl={createBaseUrl}
              onBaseUrlChange={setCreateBaseUrl}
              settingsJson={createSettingsJson}
              onSettingsJsonChange={setCreateSettingsJson}
              tomlText={createTomlText}
              onTomlTextChange={setCreateTomlText}
              authJson={createAuthJson}
              onAuthJsonChange={setCreateAuthJson}
              contextWindowTokens={createContextWindowTokens}
              onContextWindowTokensChange={setCreateContextWindowTokens}
              modelOptions={createModels}
              onFetchModels={discoverCreateModels}
              fetchingModels={createDiscovering}
              canFetchModels={Boolean(createProvider && createSecret.trim())}
              onNotice={(message) => { setNotice(message); setError(""); }}
              onError={(message) => { if (message) setError(message); else setError(""); }}
              onSubmit={createAccount}
              onCancel={() => setShowCreate(false)}
              busy={busy}
              submitLabel="保存配置并添加账号"
            />
          )}

          <div className="provider-flow-credential-list" role="list">
            {credentials.length === 0 && (
              <div className="provider-flow-empty">暂无账号。点右上角「添加账号」创建。</div>
            )}
            {credentials.map((credential) => {
              const selected = selectedCredentialId === credential.id;
              const editing = editingCredentialId === credential.id;
              return (
                <div
                  key={credential.id}
                  role="listitem"
                  className={`provider-flow-credential-row ${selected ? "is-selected" : ""}${editing ? " is-editing" : ""}`}
                >
                  <button
                    type="button"
                    className="provider-flow-credential-main"
                    onClick={() => {
                      setSelectedCredentialId(credential.id);
                      if (editingCredentialId && editingCredentialId !== credential.id) setEditingCredentialId("");
                    }}
                  >
                    <span className={`provider-health-dot ${credential.health?.status ?? "unknown"}`} />
                    <span className="provider-flow-credential-title">
                      <strong>{credential.name}</strong>
                      <small>
                        {credential.provider_valid === false
                          ? "映射待修复"
                          : providerProtocolLabel(credential.provider, (credential.agent_cli as AgentCli | null) ?? "claude-code", catalog)}
                        {credential.agent_cli
                          ? ` · ${cliLabel[credential.agent_cli] ?? credential.agent_cli}`
                          : " · CLI 未设置"}
                        {credential.scope === "project" ? " · 项目" : " · 全局"}
                      </small>
                    </span>
                    <span className="provider-flow-credential-meta">
                      {healthStatusLabel(credential.health?.status)}
                      {" · "}
                      {credential.agent_cli
                        ? (cliLabel[credential.agent_cli] ?? credential.agent_cli)
                        : "CLI 未设"}
                      {" · ····"}{credential.last4}
                    </span>
                  </button>
                  <div className="provider-flow-credential-actions">
                    <button
                      type="button"
                      className="secondary-button !min-h-7 !px-2 !text-[10px]"
                      onClick={async () => {
                        setSelectedCredentialId(credential.id);
                        setTesting(true);
                        setError("");
                        try {
                          const result = await api.testCredential(credential.id);
                          if (result.ok) setNotice(`连接正常：${result.detail}`);
                          else setError(`连接失败：${result.detail}${result.category ? `（${result.category}）` : ""}`);
                          onChanged();
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setTesting(false);
                        }
                      }}
                      disabled={testing || discovering}
                    >
                      <Plugs size={12} /> 测试
                    </button>
                    <button
                      type="button"
                      className={`secondary-button !min-h-7 !px-2 !text-[10px] ${editing ? "is-active" : ""}`}
                      onClick={() => openEditCredential(credential)}
                    >
                      <PencilSimple size={12} /> {editing ? "收起" : "编辑"}
                    </button>
                  </div>
                  {editing && (
                    <div className="provider-flow-credential-editor">
                      <CredentialConfigEditor
                        mode="edit"
                        name={editName}
                        onNameChange={setEditName}
                        provider={editProvider}
                        onProviderChange={setEditProvider}
                        agentCli={editAgentCli}
                        onAgentCliChange={setEditAgentCli}
                        projectId={editProjectId}
                        onProjectIdChange={setEditProjectId}
                        projects={projects}
                        actorProjectId={actorProjectId}
                        providerCatalog={catalog}
                        secret={editApiKey}
                        onSecretChange={setEditApiKey}
                        baseUrl={editBaseUrl}
                        onBaseUrlChange={setEditBaseUrl}
                        settingsJson={editSettingsJson}
                        onSettingsJsonChange={setEditSettingsJson}
                        tomlText={editTomlText}
                        onTomlTextChange={setEditTomlText}
                        authJson={editAuthJson}
                        onAuthJsonChange={setEditAuthJson}
                        contextWindowTokens={editContextWindowTokens}
                        onContextWindowTokensChange={setEditContextWindowTokens}
                        modelOptions={models}
                        onFetchModels={discoverModels}
                        fetchingModels={discovering}
                        canFetchModels
                        onNotice={(message) => { setNotice(message); setError(""); }}
                        onError={(message) => { if (message) setError(message); else setError(""); }}
                        onSubmit={saveEditedConfig}
                        onCancel={() => {
                          setEditingCredentialId("");
                          setEditOriginalSettings(null);
                          setEditOriginalAgentCli(null);
                        }}
                        busy={busy}
                        submitLabel="保存配置修改"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selectedCredential && (
            <div className="provider-flow-health">
              <span className={`provider-health-dot ${selectedCredential.health?.status ?? "unknown"}`} />
              <strong>{selectedCredential.provider_valid === false ? "Provider 映射待修复" : healthStatusLabel(selectedCredential.health?.status)}</strong>
              <span>当前选中 · 绑定 {boundRoleCount}</span>
              <span>{selectedCredential.health?.last_tested_at ? `最近测试 ${new Date(selectedCredential.health.last_tested_at).toLocaleString()}` : "尚未测试"}</span>
            </div>
          )}
          {selectedCredential && (
            <div className="provider-flow-account-actions">
              <button type="button" onClick={testConnection} disabled={testing || discovering} className="secondary-button">
                <Plugs size={13} /> {testing ? "测试中…" : "测试连接"}
              </button>
              <button type="button" onClick={discoverModels} disabled={discovering || testing} className="secondary-button">
                <Lightning size={13} /> {discovering ? "刷新中…" : "刷新模型目录"}
              </button>
            </div>
          )}
          {selectedCredential?.provider_valid === false && (
            <div className="provider-flow-repair">
              <div className="text-[11px] text-amber-300">遗留 Provider 值已隐藏。请选择正确映射以修复。</div>
              <div className="flex gap-2">
                <SearchableSelect
                  value={repairProvider}
                  onChange={setRepairProvider}
                  options={[
                    ...catalog.filter((item) => item.kind === "llm_provider").map((item) => ({
                      value: item.provider,
                      label: providerProtocolLabel(item.provider, (selectedCredential.agent_cli as AgentCli | null) ?? "claude-code", catalog),
                    })),
                    ...(repairProvider && !catalog.some((item) => item.kind === "llm_provider" && item.provider === repairProvider)
                      ? [{ value: repairProvider, label: `${repairProvider}（当前 · 不在目录）` }]
                      : []),
                  ]}
                  placeholder="选择 Provider"
                  ariaLabel="选择 Provider"
                  className="min-w-0 flex-1"
                />
                <button type="button" onClick={repair} disabled={busy || !repairProvider} className="secondary-button px-3">修复映射</button>
              </div>
            </div>
          )}
          <div className="provider-flow-account-meta">
            <span><Plugs size={13} /> {selectedCredential?.health?.error_category ?? "无错误类别"}</span>
            <span>末四位 ····{selectedCredential?.last4 ?? "----"}</span>
            <span>指纹 {selectedCredential?.fingerprint?.slice(0, 8) ?? "--------"}</span>
            {currentCatalog.length > 0 && <span>目录 {currentCatalog.length} 个</span>}
          </div>
          {catalogError && <div className="provider-flow-catalog-error"><Warning size={13} /> {catalogError}</div>}
          {selectedCredential && bindingGateReason && <div className="provider-flow-warning"><Warning size={13} /> {bindingGateReason}</div>}
        </div>
        )}

        {step === "roles" && (
      <div className="provider-flow-card provider-flow-bind-card">
        <div className="provider-flow-card-kicker">02 / 角色配置</div>
        <div className="provider-flow-bind-head">
          <div>
            <label className="provider-flow-label">
              按全局 / 项目选择角色配置
              <HelpTip>
                用下方作用域切换「全局」或某个「项目」。项目列表来自已有项目；若某项目还没有角色覆盖，需先在 Agent 管理里添加项目覆盖。
                <strong className="provider-flow-role-legend-system"> 系统角色（调度内核）</strong>
                {" "}与
                <strong className="provider-flow-role-legend-hub"> Hub</strong>
                {" "}有颜色区分。
              </HelpTip>
            </label>
            <div className="provider-flow-scope-bar" role="group" aria-label="角色配置作用域">
              <div className="provider-flow-scope-toggles">
                <button
                  type="button"
                  className={roleScopeFilter === "all" ? "is-active" : ""}
                  onClick={() => setRoleScopeFilter("all")}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={roleScopeFilter === "global" ? "is-active" : ""}
                  onClick={() => setRoleScopeFilter("global")}
                >
                  全局配置
                </button>
              </div>
              <div className="provider-flow-filter-row">
                <SearchableSelect
                  label="项目"
                  ariaLabel="选择项目"
                  value={roleScopeFilter !== "all" && roleScopeFilter !== "global" ? roleScopeFilter : ""}
                  onChange={(next) => setRoleScopeFilter(next || "all")}
                  options={[
                    ...projectsWithRoleConfigs.map((project) => ({
                      value: project.id,
                      label: `${project.name}${project.count > 0 ? `（${project.count} 个覆盖）` : "（尚无覆盖）"}`,
                    })),
                    ...(roleScopeFilter !== "all" && roleScopeFilter !== "global"
                      && !projectsWithRoleConfigs.some((project) => project.id === roleScopeFilter)
                      ? [{ value: roleScopeFilter, label: `${roleScopeFilter}（当前 · 项目不可用）` }]
                      : []),
                  ]}
                  placeholder="选择项目…"
                  className="provider-flow-filter-field"
                />
                <fieldset className="provider-flow-filter-field" disabled={busy || !selectedCredential}>
                  <span>账号目标 CLI</span>
                  <SearchableSelect
                    value={selectedCredential?.agent_cli ?? ""}
                    onChange={(next) => {
                      if (!selectedCredential || !next) return;
                      void (async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await api.updateCredential(selectedCredential.id, { agent_cli: next as AgentCli });
                          setNotice(`已限制账号 CLI 为 ${cliLabel[next] ?? next}；CLI 不匹配的角色将标为不可绑定，可先改角色 CLI。`);
                          onChanged();
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                    options={AGENT_CLI_OPTIONS}
                    placeholder={!selectedCredential ? "请先选择账号" : "未设置 — 请选择以限制绑定"}
                    ariaLabel="账号目标 CLI"
                    className="w-full [&>button]:w-full"
                    clearable={false}
                  />
                </fieldset>
              </div>
            </div>
          </div>
          <div className="provider-flow-count-stack" aria-label="绑定与勾选数量">
            <div className="provider-flow-count">{boundRoleCount}<span>已绑定</span></div>
            <div className="provider-flow-count is-muted">{selectedRoleIds.size}<span>本次勾选</span></div>
          </div>
        </div>
        <div className="provider-flow-role-list">
          {roleConfigs.length === 0 && <div className="provider-flow-empty">暂无角色配置。请先在「Agent 角色」中创建，再回到这里绑定。</div>}
          {roleConfigs.length > 0 && eligibleRoleConfigs.length === 0 && (
            <div className="provider-flow-empty">
              当前作用域下没有可绑定的角色配置。请切换「全局 / 项目」，或在「Agent 角色」中创建配置。
            </div>
          )}
          {roleBindGroups.length === 0 && roleConfigs.length > 0 && eligibleRoleConfigs.length > 0 && (
            <div className="provider-flow-empty">当前作用域下没有角色配置，请切换「全局」或选择其他项目。</div>
          )}
          {roleBindGroups.map((group) => (
            <div key={group.key} className={`provider-flow-role-group is-${group.kind}`}>
              <div className="provider-flow-role-group-head">
                <strong>{group.title}</strong>
                <span>{group.items.length} 个</span>
              </div>
              {group.items.length === 0 && group.emptyHint && (
                <div className="provider-flow-empty" style={{ margin: "4px 0 0" }}>{group.emptyHint}</div>
              )}
              <div className="provider-flow-role-group-body">
                {group.items.map((roleConfig) => {
                  const selected = selectedRoleIds.has(roleConfig.id);
                  const kind = resolveBindableRoleKind(roleConfig);
                  const isSystem = kind === "system";
                  const isHub = kind === "hub";
                  const isBuiltin = isBuiltinBindableRole(roleConfig);
                  const roleCli = (["claude-code", "codex", "open-code", "pi", "dsh"].includes(roleConfig.agent_cli)
                    ? roleConfig.agent_cli
                    : "claude-code") as AgentCli;
                  const incompatible = Boolean(
                    selectedCredential
                    && (
                      (selectedCredential.agent_cli && roleCli !== selectedCredential.agent_cli)
                      || (targetCatalog && !targetCatalog.compatible_agent_cli.includes(roleCli))
                    ),
                  );
                  const accent = roleConfig.role_ui_color?.trim() || undefined;
                  const canToggle = roleConfig.can_bind && !incompatible;
                  return (
                    <div
                      key={roleConfig.id}
                      className={[
                        "provider-flow-role",
                        selected ? "is-selected" : "",
                        isSystem ? "is-system" : "",
                        isHub ? "is-hub" : "",
                        isBuiltin && !isSystem && !isHub ? "is-builtin" : "",
                        !canToggle ? "is-disabled-bind" : "",
                      ].filter(Boolean).join(" ")}
                      style={accent && !isSystem && !isHub ? { ["--role-accent" as string]: accent } : undefined}
                      data-role-kind={kind}
                      onClick={() => {
                        if (canToggle) toggleRole(roleConfig.id);
                      }}
                      onKeyDown={(event) => {
                        if (!canToggle) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleRole(roleConfig.id);
                        }
                      }}
                      role="checkbox"
                      aria-checked={selected}
                      tabIndex={canToggle ? 0 : -1}
                    >
                      <span className="provider-flow-role-check" aria-hidden><Check size={11} weight="bold" /></span>
                      <span className="provider-flow-role-main">
                        <strong>
                          {roleConfig.role_title || roleConfig.role_name}
                          {isSystem && <em className="provider-flow-role-badge is-system">系统角色（调度内核）</em>}
                          {isHub && <em className="provider-flow-role-badge is-hub">Hub 中枢</em>}
                          {isBuiltin && !isSystem && !isHub && <em className="provider-flow-role-badge is-builtin">内置</em>}
                        </strong>
                        <small>
                          {group.kind === "project" ? (roleConfig.project_name ?? "项目") : "全局默认"}
                          {isSystem ? " · 调度内核" : isHub ? " · Hub" : ""}
                        </small>
                      </span>
                      <fieldset
                        className="provider-flow-role-cli-wrap"
                        disabled={busy || !roleConfig.can_bind}
                        title="修改此角色配置的 Agent CLI（立即保存）"
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                      >
                        <span className="provider-flow-role-cli-caption">CLI</span>
                        <SearchableSelect
                          value={roleCli}
                          ariaLabel={`${roleConfig.role_title || roleConfig.role_name} 的 Agent CLI`}
                          onChange={(next) => {
                            if (!next || next === roleCli) return;
                            void (async () => {
                              setBusy(true);
                              setError("");
                              try {
                                await api.updateRoleConfigAgentCli(roleConfig.id, next as AgentCli);
                                setRoleConfigs((current) =>
                                  current.map((item) =>
                                    item.id === roleConfig.id ? { ...item, agent_cli: next as AgentCli } : item,
                                  ),
                                );
                                setNotice(`已将「${roleConfig.role_title || roleConfig.role_name}」CLI 改为 ${cliLabel[next] ?? next}`);
                                // Keep checkbox state; refresh from server for version consistency.
                                api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
                              } catch (e) {
                                setError(String(e));
                              } finally {
                                setBusy(false);
                              }
                            })();
                          }}
                          options={AGENT_CLI_OPTIONS.map((option) => ({ ...option, label: option.value }))}
                          placeholder="选择 CLI…"
                          className="w-full [&>button]:!min-h-[30px] [&>button]:w-full"
                          clearable={false}
                        />
                      </fieldset>
                      {roleConfig.project_id ? (
                        <span
                          className="provider-flow-role-cli-wrap provider-flow-role-image-wrap"
                          title="项目 RoleConfig 的镜像由项目镜像策略集中决定"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <span className="provider-flow-role-cli-caption">镜像</span>
                          <span className="provider-flow-role-image-readonly">由项目镜像策略决定</span>
                        </span>
                      ) : (
                        <div
                          className="provider-flow-role-cli-wrap provider-flow-role-image-wrap"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <span className="provider-flow-role-cli-caption">镜像</span>
                          <SearchableSelect
                            value={roleConfig.runtime_image_key ?? ""}
                            onChange={(value) => {
                              if (busy || !roleConfig.can_bind) return;
                              const next = value.trim() || null;
                              const current = roleConfig.runtime_image_key ?? null;
                              if (next === current) return;
                              void (async () => {
                                setBusy(true);
                                setError("");
                                try {
                                  await api.updateRoleConfigRuntimeImage(roleConfig.id, next);
                                  setRoleConfigs((currentRows) =>
                                    currentRows.map((item) =>
                                      item.id === roleConfig.id ? { ...item, runtime_image_key: next } : item,
                                    ),
                                  );
                                  const label = next
                                    ? (runtimeImages.find((image) => image.image_key === next)?.name ?? next)
                                    : "系统底座";
                                  setNotice(`已将「${roleConfig.role_title || roleConfig.role_name}」镜像改为 ${label}`);
                                  api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
                                } catch (e) {
                                  setError(String(e));
                                } finally {
                                  setBusy(false);
                                }
                              })();
                            }}
                            options={[
                              { value: "", label: "系统底座（默认）", disabled: busy || !roleConfig.can_bind },
                              ...runtimeImageOptionsFor(roleConfig.project_id).map((image) => ({
                                value: image.image_key,
                                label: runtimeImageOptionLabel(image, roleConfig.project_id),
                                disabled: busy || !roleConfig.can_bind,
                              })),
                              ...(roleConfig.runtime_image_key
                                && !runtimeImageOptionsFor(roleConfig.project_id).some((image) => image.image_key === roleConfig.runtime_image_key)
                                ? [{
                                    value: roleConfig.runtime_image_key,
                                    label: `${roleConfig.runtime_image_key}（当前 · 需检查启用）`,
                                    disabled: busy || !roleConfig.can_bind,
                                  }]
                                : []),
                            ]}
                            placeholder="系统底座（默认）"
                            ariaLabel={`${roleConfig.role_title || roleConfig.role_name} 的运行镜像`}
                            className="min-w-0"
                          />
                        </div>
                      )}
                      <span className="provider-flow-role-model">
                        {roleConfig.model
                          ? `Role 覆盖 · ${roleConfig.model}`
                          : modelsFromSettingsConfig(selectedCredential)[0]
                            ? `配置文件 · ${modelsFromSettingsConfig(selectedCredential)[0]}`
                            : "配置文件 · 未声明模型"}
                      </span>
                      <span
                        className={`provider-flow-role-status ${incompatible || !roleConfig.can_bind ? "is-warning" : ""}`}
                        title={
                          !roleConfig.can_bind
                            ? "全局角色配置可见，但项目操作者只能绑定本项目角色配置"
                            : incompatible
                              ? selectedCredential?.agent_cli
                                ? `角色 CLI 与账号目标 CLI（${cliLabel[selectedCredential.agent_cli] ?? selectedCredential.agent_cli}）不一致，请先改 CLI 再勾选绑定`
                                : `请选择与 ${cliLabel[roleCli] ?? roleCli} 兼容的 Provider`
                              : undefined
                        }
                      >
                        {!roleConfig.can_bind
                          ? "只读 · 项目作用域"
                          : incompatible
                            ? "CLI 不匹配 · 可改 CLI"
                            : roleConfig.credential_name
                              ? `已绑定 · ${roleConfig.credential_name}`
                              : "未绑定"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
        )}

        {step === "effect" && (
      <div className="provider-flow-card provider-flow-effect-card">
        <div className="provider-flow-card-kicker">03 / 生效策略</div>
        <div className="provider-flow-effect-grid">
          <div>
            <label className="provider-flow-label">绑定操作</label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={mode === "bind" ? "is-active" : ""} onClick={() => setMode("bind")}>绑定账号</button>
              <button type="button" className={mode === "migrate" ? "is-active" : ""} onClick={() => setMode("migrate")}>从账号迁移</button>
            </div>
            {mode === "migrate" && (
              <SearchableSelect
                value={sourceCredentialId}
                onChange={setSourceCredentialId}
                options={[
                  ...sourceOptions.map((credential) => ({
                    value: credential.id,
                    label: `${credential.name} · ${providerProtocolLabel(credential.provider, (credential.agent_cli as AgentCli | null) ?? "claude-code", catalog)}`,
                  })),
                  ...(sourceCredentialId && !sourceOptions.some((credential) => credential.id === sourceCredentialId)
                    ? [{ value: sourceCredentialId, label: `${sourceCredentialId}（当前 · 账号不可用）` }]
                    : []),
                ]}
                placeholder="选择源账号"
                ariaLabel="选择迁移源账号"
                className="mt-2"
              />
            )}
          </div>
          <div>
            <label className="provider-flow-label">
              何时生效？
              <HelpTip>运行中与终态 Job 始终保留冻结快照。「刷新 pending」需显式选择且有边界。</HelpTip>
            </label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={effect === "new_jobs_only" ? "is-active" : ""} onClick={() => setEffect("new_jobs_only")}>仅新 Job</button>
              <button type="button" className={effect === "refresh_pending" ? "is-active" : ""} onClick={() => setEffect("refresh_pending")}>刷新 pending</button>
            </div>
          </div>
        </div>
        {incompatibleRoles.length > 0 && selectedRoleIds.size > 0 && (
          <div className="provider-flow-warning">
            <Warning size={14} /> 已选 {incompatibleRoles.length} 个角色配置与当前账号 CLI 不兼容。请更换账号或角色。
          </div>
        )}
        <button
          type="button"
          onClick={apply}
          disabled={busy || !selectedCredential || selectedRoleIds.size === 0 || Boolean(bindingGateReason) || incompatibleRoles.length > 0 || unbindableSelectedRoles.length > 0}
          className="provider-flow-apply"
        >
          {busy ? "正在检查兼容性…" : <><GitBranch size={15} /> 应用到所选角色配置</>}
        </button>
      </div>
        )}

        {step === "effect" && impact && (
        <div className="provider-flow-impact" role="status">
          <div className="provider-flow-impact-title"><CheckCircle size={16} /> 已在同一事务中生效</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{impact.role_config_count}</strong> 本次绑定角色配置</span>
            <span><strong>{previewImpact?.role_configs.count ?? boundRoleCount}</strong> 当前已绑定</span>
            <span><strong>{impact.pending_job_count}</strong> pending</span>
            <span><strong>{impact.refreshed_pending_job_count}</strong> 已刷新</span>
            <span><strong>{impact.active_frozen_job_count}</strong> 活跃冻结</span>
            <span><strong>{impact.terminal_historical_job_count}</strong> 终态 / 重试</span>
          </div>
        </div>
        )}
        {step === "effect" && previewImpact && (
        <div className="provider-flow-preview" role="status">
          <div className="provider-flow-impact-title"><GitBranch size={15} /> 当前账号影响预览</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{previewImpact.role_configs.count}</strong> 已绑定角色配置</span>
            <span><strong>{previewImpact.jobs.pending_unclaimed.count}</strong> pending 冻结</span>
            <span><strong>{previewImpact.jobs.active_frozen.count}</strong> 活跃冻结</span>
            <span><strong>{previewImpact.jobs.terminal_historical.count}</strong> 终态 / 重试</span>
          </div>
        </div>
        )}

        <div className="provider-flow-step-nav" role="navigation" aria-label="步骤导航">
          <button
            type="button"
            className="secondary-button"
            disabled={step === "account"}
            onClick={() => {
              if (step === "roles") goToStep("account");
              else if (step === "effect") goToStep("roles");
            }}
          >
            上一步
          </button>
          <div className="provider-flow-step-nav-meta">
            {step === "account" && (selectedCredential
              ? `已选：${selectedCredential.name}`
              : "请选择或添加一个 Provider 账号")}
            {step === "roles" && `已勾选 ${selectedRoleIds.size} 个角色配置 · 已绑定 ${boundRoleCount}`}
            {step === "effect" && (effect === "refresh_pending" ? "生效：刷新 pending" : "生效：仅新 Job")}
          </div>
          {step !== "effect" ? (
            <button
              type="button"
              className="provider-flow-step-next"
              disabled={step === "account" ? !canEnterRoles : !canEnterEffect}
              onClick={() => {
                if (step === "account") goToStep("roles");
                else goToStep("effect");
              }}
            >
              下一步 <ArrowRight size={14} />
            </button>
          ) : (
            <span className="provider-flow-step-nav-hint">在上方确认策略后点击「应用」</span>
          )}
        </div>
      </div>
    </section>
  );
}
