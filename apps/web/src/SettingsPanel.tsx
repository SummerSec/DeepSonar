import { ArrowsClockwise, FloppyDisk, GearSix, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { ROLE_UI_COLOR_PATTERN } from "@deepsonar/shared-types";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  type AuthMe,
  type EffectiveRules,
  type GlobalRoleConfigEntry,
  type ProjectRole,
  type ProjectRoleConfigEntry,
  type ProviderCredential,
  type ProjectSettings,
  type FindingProtocolConfig,
  type EffectiveFindingProtocol,
  type RoleConfigInput,
  type RoleConfigView,
  type ProjectImageStrategy,
  type RuntimeImageSummary,
  type SkillSource,
  type SkillSourceDetail,
} from "./api";
import { useAuth } from "./auth";
import { canAccessAnyScope } from "./permissions";

import { TokensPanel } from "./TokensPanel";
import { CredentialsPanel } from "./CredentialsPanel";
import { RoleConfigEditor } from "./RoleConfigEditor";
import { TransferPanel } from "./TransferPanel";
import { UsersPanel } from "./UsersPanel";
import { AccountPanel } from "./AccountPanel";
import { MarkdownView } from "./MarkdownView";
import { FindingProtocolEditor } from "./FindingProtocolEditor";
import { SharedAssetsPanel } from "./SharedAssetsPanel";
import { SearchableSelect } from "./SearchableSelect";
import { HelpTip } from "./ui";
import { inferToastKind, showToast } from "./toast";

/**
 * 设置面板（§8.1/§8.2/§8.3 + 角色即配置 §4.2）：
 * 角色注册表 + 角色运行配置（全局缺省 / 项目覆盖）+ 规则配置 + 模块源管理。
 * 生效语义：下一 job 生效 —— job 创建时冻结快照，改配置不影响已建 job
 */

type Tab = "rules" | "roles" | "sources" | "plane" | "tokens" | "credentials" | "transfer" | "users" | "account" | "assets";
export type GlobalSettingsSection = "agents" | "modules" | "access" | "credentials" | "platform";

const PROJECT_TAB_KEYS: readonly Tab[] = ["rules", "roles", "assets", "plane"];
const GLOBAL_TAB_KEYS: readonly Tab[] = ["roles", "sources", "rules", "assets", "account", "users", "transfer", "credentials", "tokens"];
const GLOBAL_SECTION_TABS: Record<GlobalSettingsSection, readonly Tab[]> = {
  agents: ["roles"],
  modules: ["sources"],
  access: ["account", "users", "tokens"],
  credentials: ["credentials"],
  platform: ["rules", "assets", "transfer"],
};
const GLOBAL_TAB_SCOPES: Partial<Record<Tab, readonly string[]>> = {
  roles: ["agents:read"],
  sources: ["skills:read"],
  rules: ["agents:read"],
  account: ["projects:read"],
  users: ["admin"],
  transfer: ["exports:read", "imports:read"],
  credentials: ["agents:read"],
  tokens: ["tokens:manage"],
  assets: ["assets:manage"],
};

export function settingsTabsForActor(section: GlobalSettingsSection, me: AuthMe | null): readonly Tab[] {
  return GLOBAL_SECTION_TABS[section].filter((tab) => canAccessAnyScope(me, GLOBAL_TAB_SCOPES[tab] ?? ["admin"]));
}

/** Resolve a URL tab without allowing project pages to expose global-only tabs. */
export function resolveSettingsTab(projectId: string | null, requested: string | null): Tab {
  const allowed = projectId ? PROJECT_TAB_KEYS : GLOBAL_TAB_KEYS;
  return requested && (allowed as readonly string[]).includes(requested) ? requested as Tab : "roles";
}

export function resolveSettingsSectionTab(section: GlobalSettingsSection, requested: string | null): Tab {
  const allowed = GLOBAL_SECTION_TABS[section];
  return requested && (allowed as readonly string[]).includes(requested) ? requested as Tab : allowed[0]!;
}

export function settingsSectionDataNeeds(projectId: string | null, section: GlobalSettingsSection) {
  return {
    agent: Boolean(projectId || section === "agents"),
    modules: Boolean(projectId || section === "agents" || section === "modules"),
    roleCredentialBindings: Boolean(projectId || section === "agents"),
  };
}

export function nextEnabledRoleNames(roles: ProjectRole[], targetName: string): string[] {
  return roles
    .filter((role) => role.name === targetName ? !role.enabled : role.enabled)
    .map((role) => role.name);
}

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

// ---------- 角色表单状态（§8.3） ----------

interface RoleForm {
  id: string | null;
  name: string;
  title: string;
  description: string;
  builtin: boolean;
  kind: "hub" | "system" | "role";
}

const EMPTY_ROLE: RoleForm = {
  id: null,
  name: "",
  title: "",
  description: "",
  builtin: false,
  kind: "role",
};

export function SettingsPanel({
  projectId,
  onClose,
  variant = "drawer",
  globalSection = "agents",
}: {
  /** null = 全局 Agent 管理模式（无项目级绑定/规则/角色启用） */
  projectId: string | null;
  onClose?: () => void;
  /** drawer=浮层侧栏；page=独立设置页 */
  variant?: "drawer" | "page";
  /** 全局页按产品职责限制可见 tab；项目页忽略此参数。 */
  globalSection?: GlobalSettingsSection;
}) {
  const { me } = useAuth();
  const visibleGlobalTabs = useMemo(() => settingsTabsForActor(globalSection, me), [globalSection, me]);
  const [tab, setTab] = useState<Tab>(() => projectId ? "roles" : resolveSettingsSectionTab(globalSection, null));
  const [searchParams, setSearchParams] = useSearchParams();
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [rules, setRules] = useState<EffectiveRules | null>(null);
  const [findingProtocol, setFindingProtocol] = useState<FindingProtocolConfig | null>(null);
  const [effectiveFindingProtocol, setEffectiveFindingProtocol] = useState<EffectiveFindingProtocol | null>(null);
  const [imageStrategy, setImageStrategy] = useState<ProjectImageStrategy>("inherit_global");
  const [roleRuntimeImages, setRoleRuntimeImages] = useState<Record<string, string | null>>({});
  const [runtimeImages, setRuntimeImages] = useState<RuntimeImageSummary[]>([]);
  const [imagePolicyBusy, setImagePolicyBusy] = useState(false);
  const [imagePolicySaved, setImagePolicySaved] = useState(false);
  const [imagePolicyFailed, setImagePolicyFailed] = useState(false);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [rulesFailed, setRulesFailed] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  const [cliActive, setCliActive] = useState<Record<string, number>>({});
  const [projectJobQuota, setProjectJobQuota] = useState("");
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [sourceDetails, setSourceDetails] = useState<Record<string, SkillSourceDetail>>({});
  const [newSource, setNewSource] = useState({ name: "", repo_url: "", branch: "main" });
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [roleForm, setRoleForm] = useState<RoleForm>(EMPTY_ROLE);
  // 角色即配置：全局缺省清单 + 项目视角清单 + 正在编辑运行配置的角色 id
  const [globalConfigs, setGlobalConfigs] = useState<GlobalRoleConfigEntry[]>([]);
  const [projConfigs, setProjConfigs] = useState<ProjectRoleConfigEntry[]>([]);
  const [configRoleId, setConfigRoleId] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [planeBind, setPlaneBind] = useState<string | null>(null);
  const [planeInput, setPlaneInput] = useState("");
  const [planeBusy, setPlaneBusy] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);

  const reload = () => {
    if (!projectId && visibleGlobalTabs.length === 0) return;
    setAgentLoadError(null);
    const showAgentLoadError = (label: string, error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      setAgentLoadError(`${label}加载失败：${detail}`);
    };
    const dataNeeds = settingsSectionDataNeeds(projectId, globalSection);
    const canLoadTab = (key: Tab) => Boolean(projectId || visibleGlobalTabs.includes(key));
    if (dataNeeds.agent && canLoadTab("roles")) {
      api.globalRoleConfigs().then(setGlobalConfigs).catch((error) => showAgentLoadError("全局 Agent 配置", error));
    }
    if (projectId) {
      // 项目模式：角色带启用态 + 角色配置来源（项目覆盖/全局缺省/未配置）
      api.projectRoles(projectId).then(setRoles).catch((error) => showAgentLoadError("项目角色", error));
      api.projectRoleConfigs(projectId).then(setProjConfigs).catch((error) => showAgentLoadError("项目 Agent 配置", error));
      api.runtimeImages(projectId).then(setRuntimeImages).catch((error) => showAgentLoadError("运行时镜像", error));
      api
        .projects()
        .then((list) => setPlaneBind(list.find((p) => p.id === projectId)?.plane_project_id ?? null))
        .catch(() => {});
      api
        .settings(projectId)
        .then((s) => {
          setSettings(s);
          setRules(s.effective_rules);
          setFindingProtocol(s.finding_protocol);
          setEffectiveFindingProtocol(s.effective_finding_protocol);
          setImageStrategy(s.image_strategy ?? "inherit_global");
          setRoleRuntimeImages(s.role_runtime_images ?? {});
          const storedQuota = (s.rules as { maxConcurrentJobs?: unknown }).maxConcurrentJobs;
          setProjectJobQuota(typeof storedQuota === "number" ? String(storedQuota) : "");
        })
        .catch(() => {});
    } else if (globalSection === "agents" && canLoadTab("roles")) {
      // 全局模式：纯角色注册表（无启用态/绑定）+ 全局规则默认值
      api
        .agentRoles()
        .then((list) =>
          setRoles(
            list.map((r) => ({ ...r, enabled: false, default_enabled: false })),
          ),
        )
        .catch((error) => showAgentLoadError("内置 Agent", error));
    } else if (globalSection === "platform" && canLoadTab("rules")) {
      api.globalSettings().then((g) => {
        setRules(g.effective_rules);
        setFindingProtocol(g.finding_protocol);
        setEffectiveFindingProtocol(g.effective_finding_protocol);
        setCliActive(g.active_by_agent_cli ?? {});
      }).catch(() => {});
    }
    if (dataNeeds.roleCredentialBindings && canLoadTab("roles")) api.credentials().then(setCredentials).catch(() => {});
    if (dataNeeds.modules && canAccessAnyScope(me, ["skills:read"]) && (canLoadTab("roles") || canLoadTab("sources"))) api.skillSources()
      .then(async (list) => {
        setSources(list);
        // 拉各源目录（模块勾选列表用）
        const details: Record<string, SkillSourceDetail> = {};
        await Promise.all(
          list.map((s) =>
            api
              .skillSource(s.id)
              .then((d) => {
                details[s.id] = d;
              })
              .catch(() => {}),
          ),
        );
        setSourceDetails(details);
      })
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [globalSection, projectId, visibleGlobalTabs]);

  useEffect(() => {
    setTab(projectId
      ? resolveSettingsTab(projectId, searchParams.get("tab"))
      : visibleGlobalTabs.includes(searchParams.get("tab") as Tab)
        ? searchParams.get("tab") as Tab
        : visibleGlobalTabs[0] ?? resolveSettingsSectionTab(globalSection, null));
  }, [globalSection, projectId, searchParams, visibleGlobalTabs]);

  const flash = (m: string) => {
    setMsg(m);
    showToast(m, inferToastKind(m));
    setTimeout(() => setMsg(null), 3000);
  };

  const saveRules = async () => {
    if (!rules) return;
    const ruleBody: Record<string, unknown> = {
      minVerifySeverity: rules.minVerifySeverity,
      maxFollowupsPerJob: rules.maxFollowupsPerJob,
      maxFollowupDepth: rules.maxFollowupDepth,
      maxAutoRetries: rules.maxAutoRetries,
      auditTimeoutSec: rules.auditTimeoutSec,
      verifyTimeoutSec: rules.verifyTimeoutSec,
      hubEnabled: rules.hubEnabled,
      maxHubRounds: rules.maxHubRounds,
      maxIntentsPerDecision: rules.maxIntentsPerDecision,
      allowEgress: rules.allowEgress,
    };
    // CLI 并发仅全局可写；Provider 并发在凭据页配置，此处不写
    if (!projectId) {
      ruleBody.maxGlobalJobs = rules.maxGlobalJobs;
      ruleBody.maxJobsPerProject = rules.maxJobsPerProject;
      ruleBody.maxConcurrentProvisioning = rules.maxConcurrentProvisioning;
      ruleBody.maxConcurrentByAgentCli = rules.maxConcurrentByAgentCli ?? {};
    } else {
      const trimmed = projectJobQuota.trim();
      ruleBody.maxConcurrentJobs = trimmed === "" ? null : Number(trimmed);
    }
    setRulesBusy(true);
    setRulesSaved(false);
    setRulesFailed(false);
    try {
      if (projectId) {
        await api.patchSettings(projectId, { rules: ruleBody, finding_protocol: findingProtocol });
      } else {
        // 全局模式：写入 global_settings（项目未覆盖时的默认值）
        await api.patchGlobalSettings({ rules: ruleBody, finding_protocol: findingProtocol });
      }
      flash("规则已保存（下一 job 生效）");
      setRulesSaved(true);
      window.setTimeout(() => setRulesSaved(false), 2000);
      reload();
    } catch (e) {
      setRulesFailed(true);
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setRulesBusy(false);
    }
  };

  const projectRuntimeImageChoices = useMemo(() => runtimeImages.filter((image) => {
    if (!image.enabled || image.trust_status !== "trusted" || !image.digest || !image.resolved_ref) return false;
    return image.official && !image.project_opt_in ? image.project_enabled !== false : image.project_enabled === true;
  }), [runtimeImages]);

  const saveImagePolicy = async () => {
    if (!projectId) return;
    setImagePolicyBusy(true);
    setImagePolicySaved(false);
    setImagePolicyFailed(false);
    try {
      const result = await api.patchSettings(projectId, {
        image_strategy: imageStrategy,
        ...(imageStrategy === "project_managed" ? { role_runtime_images: roleRuntimeImages } : {}),
      });
      if ("saved" in result && result.saved === false) {
        setImagePolicyFailed(true);
        flash(`正在后台准备 ${result.task.total} 个运行镜像；本次未保存，请在拉取完成后重试`);
        return;
      }
      flash("项目镜像策略已保存（下一 job 生效）");
      setImagePolicySaved(true);
      window.setTimeout(() => setImagePolicySaved(false), 2000);
      reload();
    } catch (e) {
      setImagePolicyFailed(true);
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setImagePolicyBusy(false);
    }
  };

  // ---------- 角色（hub 可下发清单 + 运行配置） ----------

  /** 勾选启用：立即保存整个 enabled 清单（首次勾选后从默认模式转为显式清单） */
  const toggleRole = async (role: ProjectRole) => {
    if (!projectId) return;
    const next = nextEnabledRoleNames(roles, role.name);
    try {
      await api.patchSettings(projectId, { roles: { enabled: next } });
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  /** 保存角色运行配置（全局缺省 / 项目覆盖共用；全量声明式 PUT） */
  const saveRoleConfig = async (roleId: string, body: RoleConfigInput) => {
    setConfigBusy(true);
    setConfigSaved(false);
    setConfigFailed(false);
    try {
      if (projectId) await api.putProjectRoleConfig(projectId, roleId, body);
      else await api.putGlobalRoleConfig(roleId, body);
      flash(projectId ? "项目覆盖已保存（下一 job 生效）" : "全局缺省已保存（下一 job 生效）");
      setConfigSaved(true);
      window.setTimeout(() => {
        setConfigRoleId(null);
        setConfigSaved(false);
      }, 1200);
      reload();
    } catch (e) {
      setConfigFailed(true);
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConfigBusy(false);
    }
  };

  /** 移除项目覆盖（回落到全局缺省） */
  const removeProjectConfig = async (roleId: string) => {
    if (!projectId) return;
    try {
      await api.deleteProjectRoleConfig(projectId, roleId);
      flash("已移除项目覆盖（回落全局缺省）");
      reload();
    } catch (e) {
      flash(`移除失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const saveRole = async () => {
    try {
      const body = {
        title: roleForm.title.trim(),
        description: roleForm.description.trim(),
      };
      if (roleForm.id) {
        await api.updateRole(roleForm.id, body);
        flash("角色已保存（下一 job 生效）");
      } else {
        if (!roleForm.name.trim()) return flash("角色标识必填");
        await api.createRole({ name: roleForm.name.trim(), ...body });
        flash("角色已创建（默认未启用，勾选后 hub 可下发）");
      }
      setRoleForm(EMPTY_ROLE);
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const numField = (key: keyof EffectiveRules, label: string, help?: string) => (
    <div key={key}>
      <label className={labelCls}>
        {label}
        {help ? <HelpTip>{help}</HelpTip> : null}
      </label>
      <input
        type="number"
        value={String(rules?.[key] ?? "")}
        onChange={(e) =>
          setRules((r) => (r ? { ...r, [key]: Number(e.target.value) } : r))
        }
        className={inputCls}
      />
    </div>
  );

  const setCliLimit = (cli: "claude-code" | "codex" | "open-code" | "pi" | "dsh", raw: string) => {
    setRules((current) => {
      if (!current) return current;
      const next = { ...(current.maxConcurrentByAgentCli ?? {}) };
      if (raw === "") delete next[cli];
      else next[cli] = Math.max(0, Number(raw));
      return { ...current, maxConcurrentByAgentCli: next };
    });
  };

  // ---------- 角色行（运行配置入口 + 配置来源徽标） ----------

  const globalConfigOf = (roleId: string): RoleConfigView | null =>
    globalConfigs.find((c) => c.role_id === roleId) ?? null;
  const projConfigOf = (roleId: string) => projConfigs.find((c) => c.role_id === roleId) ?? null;
  const imagePolicyRoles = projConfigs.length > 0
    ? projConfigs.map((entry) => ({ id: entry.role_id, name: entry.name, title: entry.title }))
    : roles.map((role) => ({ id: role.id, name: role.name, title: role.title }));

  /** kind 只读徽标：Hub 品红 / 系统角色琥珀；普通角色不展示 */
  const kindBadge = (kind: string) =>
    kind === "hub" ? (
      <span className="rounded-full bg-violet-400/[.14] px-2 py-1 font-mono text-[9px] font-semibold text-violet-200 ring-1 ring-violet-300/35">
        Hub 中枢
      </span>
    ) : kind === "system" ? (
      <span className="rounded-full bg-amber-400/[.14] px-2 py-1 font-mono text-[9px] font-semibold text-amber-200 ring-1 ring-amber-300/40">
        系统角色（调度内核）
      </span>
    ) : null;

  /** 项目模式：配置来源徽标（项目覆盖 / 全局缺省 / 未配置） */
  const sourceBadge = (roleId: string) => {
    const src = projConfigOf(roleId)?.config_source;
    if (src === "project")
      return (
        <span className="rounded-full bg-acc-500/[.07] px-2 py-1 font-mono text-[9px] text-acc-400 ring-1 ring-acc-400/15">项目覆盖</span>
      );
    if (src === "global")
      return (
        <span className="rounded-full bg-white/[.035] px-2 py-1 font-mono text-[9px] text-zinc-500 ring-1 ring-white/[.06]">全局缺省</span>
      );
    return (
      <span className="rounded-full bg-black/20 px-2 py-1 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]">未配置</span>
    );
  };

  /** 单个角色行：启用勾选（项目）+ 模板编辑入口（全局）+ 运行配置编辑器 */
  const renderRoleRow = (r: ProjectRole) => {
    const globalCfg = globalConfigOf(r.id);
    const projEntry = projConfigOf(r.id);
    const editing = configRoleId === r.id;
    const kindTone =
      r.kind === "system"
        ? "bg-amber-400/[.06] ring-amber-400/30 hover:bg-amber-400/[.09] hover:ring-amber-400/45"
        : r.kind === "hub"
          ? "bg-violet-400/[.06] ring-violet-400/30 hover:bg-violet-400/[.09] hover:ring-violet-400/45"
          : "bg-white/[.022] ring-white/[.055] hover:bg-white/[.038] hover:ring-white/[.09]";
    const editingTone =
      r.kind === "system"
        ? "bg-amber-400/[.1] ring-amber-400/45"
        : r.kind === "hub"
          ? "bg-violet-400/[.1] ring-violet-400/45"
          : "bg-acc-500/[.045] ring-acc-400/25";
    return (
      <div
        key={r.id}
        className={`role-card rounded-[22px] p-4 ring-1 transition-all ${editing ? "sm:col-span-2 xl:col-span-3" : ""} ${
          roleForm.id === r.id || editing ? editingTone : kindTone
        } ${r.kind === "system" ? "shadow-[inset_3px_0_0_#f0a35e]" : r.kind === "hub" ? "shadow-[inset_3px_0_0_#c084fc]" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* 启用勾选只对普通角色有意义（hub/system 角色不受启用清单限制） */}
          {projectId && r.kind === "role" && (
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={() => toggleRole(r)}
              className="size-4 accent-emerald-500"
              title="启用后 hub 可下发此角色"
            />
          )}
          {projectId ? (
            <span className="flex items-center gap-1.5">
              {r.kind === "role" && typeof r.ui_color === "string" && ROLE_UI_COLOR_PATTERN.test(r.ui_color) && (
                <span
                  className="inline-block size-2.5 rounded-full ring-1 ring-white/20"
                  style={{ background: r.ui_color }}
                  title={`工作角色专色 ${r.ui_color}`}
                  aria-label={`工作角色专色 ${r.ui_color}`}
                />
              )}
              <span className="font-mono text-[13px] font-medium text-zinc-100">{r.name}</span>
              <span className="text-[11px] text-zinc-500">{r.title}</span>
            </span>
          ) : (
            <button
              onClick={() =>
                setRoleForm({
                  id: r.id,
                  name: r.name,
                  title: r.title,
                  description: r.description,
                  builtin: r.builtin,
                  kind: r.kind,
                })
              }
              className="flex items-center gap-1.5 text-left"
              title="编辑角色职责"
            >
              {r.kind === "role" && typeof r.ui_color === "string" && ROLE_UI_COLOR_PATTERN.test(r.ui_color) && (
                <span
                  className="inline-block size-2.5 rounded-full ring-1 ring-white/20"
                  style={{ background: r.ui_color }}
                  title={`工作角色专色 ${r.ui_color}`}
                  aria-label={`工作角色专色 ${r.ui_color}`}
                />
              )}
              <span className="font-mono text-[13px] font-medium text-zinc-100">{r.name}</span>
              <span className="text-[11px] text-zinc-500">{r.title}</span>
              <PencilSimple size={12} className="text-zinc-600" />
            </button>
          )}
          {kindBadge(r.kind)}
          {r.builtin && r.kind === "role" && (
            <span className="rounded-full bg-white/[.03] px-2 py-1 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.05]">内置</span>
          )}
          {projectId && sourceBadge(r.id)}
          {!projectId && (
            <span className="font-mono text-[9px] text-zinc-600">
              {globalCfg
                ? `${globalCfg.agent_cli}${globalCfg.model ? ` · ${globalCfg.model}` : ""} · v${globalCfg.version}`
                : "未配置"}
            </span>
          )}
          {/* 运行配置入口：全局=编辑缺省；项目=添加/编辑覆盖 */}
          <button
            onClick={() => setConfigRoleId(editing ? null : r.id)}
            className="ml-auto flex items-center gap-1 rounded-full bg-white/[.035] px-3 py-1.5 font-mono text-[10px] text-zinc-400 ring-1 ring-white/[.06] transition-colors hover:bg-acc-500/[.07] hover:text-acc-300 hover:ring-acc-400/20"
            title={projectId ? "项目覆盖：指令 / 平台工具 / 模块" : "全局缺省：指令 / 平台工具 / 模块"}
          >
            <GearSix size={12} />
            {projectId ? (projEntry?.project_config_id ? "编辑覆盖" : "添加覆盖") : "角色配置"}
          </button>
          {projectId && projEntry?.project_config_id && (
            <button
              onClick={() => removeProjectConfig(r.id)}
              className="flex items-center gap-1 rounded-full bg-red-400/[.05] px-3 py-1.5 font-mono text-[10px] text-red-300 ring-1 ring-red-300/15 transition-colors hover:bg-red-400/[.09]"
              title="删除项目覆盖，回落全局缺省"
            >
              <Trash size={11} /> 移除覆盖
            </button>
          )}
        </div>
        {r.description && (
          <div className={`mt-3 text-[11px] leading-5 text-zinc-600 ${projectId && r.kind === "role" ? "pl-6" : ""}`}>
            <MarkdownView markdown={r.description} controls={false} />
          </div>
        )}
        {editing && (
          <div className="mt-4 border-t border-white/[.05] pt-4">
            <RoleConfigEditor
              title={`${projectId ? "项目覆盖" : "全局缺省配置"} · ${r.name}`}
              roleName={r.name}
              roleKind={r.kind}
              projectId={projectId ?? undefined}
              initial={projectId ? (projEntry?.project_config ?? globalCfg) : globalCfg}
              credentials={
                projectId
                  ? credentials.filter((c) => c.project_id === null || c.project_id === projectId)
                  : credentials.filter((c) => c.project_id === null)
              }
              sources={sources}
              sourceDetails={sourceDetails}
              busy={configBusy}
              saved={configSaved}
              failed={configFailed}
              onSave={(body) => saveRoleConfig(r.id, body)}
              onCancel={() => setConfigRoleId(null)}
            />
            {projectId && projEntry?.project_config_id && (
              <div className="mt-1 font-mono text-[12px] text-zinc-600">
                已有项目覆盖（v{projEntry.project_config_version}）：表单已载入项目实时配置，保存将整体替换现有覆盖。
              </div>
            )}
          </div>
        )}
      </div>
    );
  };


  const shellCls =
    variant === "page"
      ? "settings-panel flex h-full w-full flex-col bg-transparent"
      : "theme-drawer deepsonar-sidebar absolute inset-y-2 right-2 z-30 flex w-[calc(100%-1rem)] max-w-[440px] flex-col overflow-hidden rounded-[22px] ring-1 ring-[var(--line-strong)]";

  // 全局模式：角色注册表（含运行配置）/ 模块源 / 全局规则；项目模式：规则覆盖 / 角色启用与覆盖 / Plane 集成
  // 项目数据包在项目模块「数据」页；此处项目设置只做策略。平台包仅在全局 Agent 管理。
  const globalTabList: { key: Tab; label: string }[] = [
    { key: "roles", label: "角色注册表" },
    { key: "sources", label: "模块源" },
    { key: "rules", label: "调度策略" },
    { key: "account", label: "我的账号" },
    { key: "users", label: "用户" },
    { key: "transfer", label: "平台数据" },
    { key: "credentials", label: "Provider 凭据" },
    { key: "tokens", label: "API Token" },
    { key: "assets", label: "共享资产" },
  ];
  const tabList: { key: Tab; label: string }[] = projectId
    ? [
        { key: "rules", label: "规则配置" },
        { key: "roles", label: "角色配置" },
        { key: "assets", label: "共享资产" },
        { key: "plane", label: "Plane 集成" },
      ]
    : globalTabList.filter((item) => visibleGlobalTabs.includes(item.key));
  const activeTab = projectId
    ? resolveSettingsTab(projectId, searchParams.get("tab") ?? tab)
    : tabList.find((item) => item.key === (searchParams.get("tab") ?? tab))?.key ?? tabList[0]?.key ?? null;

  return (
    <aside className={shellCls}>
      {variant === "drawer" && (
        <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
          <span className="text-[15px] font-semibold text-zinc-100">设置</span>
          <span className="font-mono text-[12px] text-zinc-600">下一 job 生效</span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="关闭"
              className="ml-auto rounded-md p-1 text-zinc-500 transition-colors hover:bg-ink-800 hover:text-zinc-200"
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}

      <div className={`settings-tabs flex shrink-0 gap-1 overflow-x-auto ${variant === "page" ? "mx-5 sm:mx-9" : "px-3 py-1.5"}`}>
        {tabList.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              const next = new URLSearchParams(searchParams);
              next.set("tab", t.key);
              setSearchParams(next, { replace: true });
            }}
            aria-current={activeTab === t.key ? "page" : undefined}
            className={`shrink-0 px-3 py-2 text-[11px] transition-colors ${
              activeTab === t.key ? "is-active text-zinc-100" : "text-zinc-600 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
        {msg && <span className="ml-auto shrink-0 self-center px-2 font-mono text-[10px] text-acc-400">{msg}</span>}
      </div>

      <div className={`settings-content flex-1 overflow-y-auto py-5 ${variant === "page" ? "w-full px-5 sm:px-9" : "px-4"}`}>
        {!projectId && tabList.length === 0 && (
          <div role="alert" className="border border-amber-300/20 bg-amber-300/[.05] px-4 py-3 text-[12px] text-amber-200">当前身份没有访问此配置域的权限。</div>
        )}
        {agentLoadError && (
          <div role="alert" className="mb-4 flex items-start gap-3 rounded-[10px] border border-red-400/20 bg-red-400/[.06] px-4 py-3 text-[12px] leading-relaxed text-red-200">
            <span className="min-w-0 flex-1">{agentLoadError}</span>
            <button onClick={reload} className="shrink-0 font-mono text-[10px] text-red-300 underline underline-offset-2 hover:text-red-100">
              重试
            </button>
          </div>
        )}
        {activeTab === "rules" && rules && (!projectId || settings) && (
          <div className="flex flex-col gap-4">
            {projectId && (
              <section>
                <div className="flex items-center gap-1 rounded-[10px] border border-ink-700 bg-ink-900/60 px-4 py-3 text-[13px] text-zinc-300">
                  项目规则与覆盖说明
                  <HelpTip>
                    各角色的指令 / 平台工具 / 模块在<strong>「角色配置」tab 的项目覆盖</strong>中维护；
                    CLI / 模型 / 凭据在「凭据」页的 Provider 绑定中配置。未覆盖的角色使用全局缺省。
                  </HelpTip>
                </div>
              </section>
            )}

            {!projectId && (
              <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
                <div className="border-b border-white/[.055] px-4 py-3">
                  <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
                    <span>调度器总并发硬上限</span>
                    <HelpTip>
                      claim 使用本页规则的 effective 值；<code>.env</code> 只在数据库未配置时提供启动默认。
                      全局上限是安全顶，每项目上限不能被项目配置放宽。修改只影响后续 claim，不终止已运行 Job。
                    </HelpTip>
                  </div>
                </div>
                <div className="px-4 py-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {numField("maxGlobalJobs", "全局活跃 Job 上限", "所有 claimed / provisioning / running Job 的总数。")}
                    {numField("maxJobsPerProject", "每项目活跃 Job 上限", "单个项目的安全 cap；effective 值不会超过全局设置。")}
                    {numField("maxConcurrentProvisioning", "Provisioning并发上限", "同时处于 claimed / provisioning 阶段的 Job 数量；超出的 Job 保持 pending。")}
                  </div>
                  <div className="mt-2 font-mono text-[10px] text-zinc-600">
                    当前运行 {Object.values(cliActive).reduce((sum, value) => sum + Number(value || 0), 0)} / {rules.maxGlobalJobs}
                  </div>
                </div>
              </section>
            )}

            {projectId && settings && (
              <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
                <div className="border-b border-white/[.055] px-4 py-3">
                  <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
                    <span>项目调度配额</span>
                    <HelpTip>
                      该项目所有任务共享此额度，不是每个任务分别拥有 M 个名额。
                      有效上限 = min(全局每项目上限, 本项设置)；留空则继承全局。
                      0 表示暂停领取新 Job，已运行 Job 继续完成。
                      计数口径为 claimed / provisioning / running；pending 与 waiting_human 不占额度。
                      修改只影响后续 claim，不终止已运行 Job。
                    </HelpTip>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>
                      最大同时运行 Job 数
                      <HelpTip>正整数收紧该项目预算；留空继承全局 {rules.maxJobsPerProject}。</HelpTip>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={rules.maxJobsPerProject}
                      placeholder={`继承全局 ${rules.maxJobsPerProject}`}
                      value={projectJobQuota}
                      onChange={(e) => setProjectJobQuota(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <div className={labelCls}>当前运行 / 有效上限</div>
                    <div className="font-mono text-[15px] text-zinc-200">
                      {settings.active_jobs} / {rules.maxConcurrentJobs}
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-zinc-600">
                      来源：{rules.maxConcurrentJobsSource === "project" ? "项目设置" : "继承全局"}
                      · 全局硬上限 {rules.maxJobsPerProject}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {projectId && (
              <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
                <div className="border-b border-white/[.055] px-4 py-3">
                  <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
                    <span>项目镜像策略</span>
                    <HelpTip>
                      全局继承只读取各角色的全局运行配置；项目托管在这里集中选择项目已启用的可信镜像。未选择的角色使用系统基础环境。
                    </HelpTip>
                  </div>
                </div>
                <div className="space-y-4 px-4 py-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${imageStrategy === "inherit_global" ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"}`}>
                      <input
                        type="radio"
                        name={`project-image-strategy-${projectId}`}
                        checked={imageStrategy === "inherit_global"}
                        onChange={() => setImageStrategy("inherit_global")}
                        className="mt-1 accent-emerald-500"
                      />
                      <span>
                        <strong className="block text-[13px] text-zinc-200">继承全局</strong>
                        <small className="text-[11px] leading-5 text-zinc-500">每个角色使用全局 RoleConfig 的镜像。</small>
                      </span>
                    </label>
                    <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${imageStrategy === "project_managed" ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"}`}>
                      <input
                        type="radio"
                        name={`project-image-strategy-${projectId}`}
                        checked={imageStrategy === "project_managed"}
                        onChange={() => setImageStrategy("project_managed")}
                        className="mt-1 accent-emerald-500"
                      />
                      <span>
                        <strong className="block text-[13px] text-zinc-200">项目托管</strong>
                        <small className="text-[11px] leading-5 text-zinc-500">在项目内集中选择可信镜像，未选角色使用系统基础环境。</small>
                      </span>
                    </label>
                  </div>

                  <div className="space-y-2">
                    {imagePolicyRoles.map((role) => {
                      const globalImage = globalConfigOf(role.id)?.runtime_image_key;
                      const currentImage = roleRuntimeImages[role.name] ?? "";
                      return (
                        <div key={role.id} className="grid gap-2 border-t border-ink-800 pt-2 sm:grid-cols-[minmax(0,1fr)_minmax(190px,240px)] sm:items-center">
                          <div>
                            <div className="text-[13px] text-zinc-300">{role.title || role.name}</div>
                            <div className="font-mono text-[10px] text-zinc-600">{role.name}</div>
                          </div>
                          {imageStrategy === "inherit_global" ? (
                            <div className="font-mono text-[11px] text-zinc-500">全局镜像：{globalImage ?? "全局未绑定（系统默认）"}</div>
                          ) : (
                            <SearchableSelect
                              value={currentImage}
                              onChange={(next) => setRoleRuntimeImages((current) => ({ ...current, [role.name]: next || null }))}
                              options={[
                                { value: "", label: "系统基础环境" },
                                ...projectRuntimeImageChoices.map((image) => ({ value: image.image_key, label: `${image.name} · ${image.image_key}` })),
                                ...(currentImage && !projectRuntimeImageChoices.some((image) => image.image_key === currentImage)
                                  ? [{ value: currentImage, label: `${currentImage}（当前 · 需检查启用）` }]
                                  : []),
                              ]}
                              placeholder="选择运行镜像"
                              ariaLabel={`${role.title || role.name} 的运行镜像`}
                              className="w-full"
                            />
                          )}
                        </div>
                      );
                    })}
                    {imagePolicyRoles.length === 0 && <div className="text-[12px] text-zinc-600">暂无可配置角色。</div>}
                  </div>

                  <button
                    type="button"
                    onClick={saveImagePolicy}
                    disabled={imagePolicyBusy}
                    className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    <FloppyDisk size={13} /> {imagePolicyBusy ? "保存中…" : imagePolicySaved ? "已保存" : imagePolicyFailed ? "保存失败" : "保存镜像策略"}
                  </button>
                </div>
              </section>
            )}

            {!projectId && (
              <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
                <div className="border-b border-white/[.055] px-4 py-3">
                  <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
                    <span>Agent CLI 全局并发</span>
                    <HelpTip>
                      Agent CLI 配额是调度 claim 的操作面；同时受上方全局/项目安全 cap 与「凭据」页的 Provider / Credential / Model 限制。
                      留空表示该 CLI 不单独限额；0 暂停该 CLI 新任务。修改只影响后续 claim，不终止已运行 Job。
                    </HelpTip>
                  </div>
                </div>
                <div className="px-4 py-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                    {(["claude-code", "codex", "open-code", "pi", "dsh"] as const).map((cli) => (
                      <div key={cli}>
                        <label className={labelCls}>{cli}</label>
                        <input
                          type="number"
                          min={0}
                          placeholder="不限"
                          value={rules.maxConcurrentByAgentCli?.[cli] ?? ""}
                          onChange={(event) => setCliLimit(cli, event.target.value)}
                          className={inputCls}
                        />
                        <div className="mt-1 font-mono text-[10px] text-zinc-600">
                          当前运行 {cliActive[cli] ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            <section className={projectId ? "border-t border-ink-800 pt-3" : ""}>
              <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                网络边界
                <HelpTip>
                  这是{projectId ? "项目" : "全局"}默认值；任务创建时可覆盖，最终值会冻结到画布。Hub 始终不代 Worker 访问目标。
                </HelpTip>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rules.allowEgress}
                  onChange={(e) => setRules({ ...rules, allowEgress: e.target.checked })}
                  className="accent-emerald-500"
                />
                <span className="text-[14px] text-zinc-200">允许 Worker 访问外部网络</span>
              </label>
            </section>

            <section className="border-t border-ink-800 pt-3">
              <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                关注策略（只配这一项）
              </div>
              <div>
                <label className={labelCls}>
                  最低关注级别
                  <HelpTip>
                    达到该级别的 Finding 会自动验证；Hub 等它们验完再决策；验完且无活跃任务后停自驱；队列永远高危优先。更低级别不自动验，可在画布人工处理。
                  </HelpTip>
                </label>
                <SearchableSelect
                  value={rules.minVerifySeverity ?? "high"}
                  onChange={(next) =>
                    setRules({
                      ...rules,
                      minVerifySeverity: next as EffectiveRules["minVerifySeverity"],
                    })
                  }
                  options={[
                    { value: "critical", label: "critical — 只动 critical" },
                    { value: "high", label: "high — critical + high（推荐）" },
                    { value: "medium", label: "medium — 含 medium 及以上" },
                    { value: "low", label: "low — 含 low 及以上" },
                    { value: "info", label: "info — 全部自动验证" },
                  ]}
                  placeholder="选择最低关注级别…"
                  ariaLabel="最低关注级别"
                  clearable={false}
                />
              </div>
            </section>

            <section className="border-t border-ink-800 pt-3">
              <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                hub 与护栏
                <HelpTip>
                  {projectId
                    ? "未覆盖项继承全局。任务页可随时暂停/恢复决策。"
                    : "全局默认；项目可覆盖。"}
                </HelpTip>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rules.hubEnabled}
                  onChange={(e) => setRules({ ...rules, hubEnabled: e.target.checked })}
                  className="accent-emerald-500"
                />
                <span className="text-[14px] text-zinc-200">启用 hub 自驱</span>
              </label>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {numField("maxHubRounds", "hub 轮次上限")}
                {numField("maxIntentsPerDecision", "单次派发意图上限")}
                {numField(
                  "maxFollowupsPerJob",
                  "每 job 派生上限",
                  "单个 audit 最多自动建多少个 verify，防队列打爆。",
                )}
                {numField(
                  "maxFollowupDepth",
                  "派生最大深度",
                  "0=直接任务，verify 一般为 1；到顶不再自动派生。",
                )}
                {numField("maxAutoRetries", "失败自动重试上限")}
                <div className="hidden sm:block" />
                {numField("auditTimeoutSec", "审计超时（秒）")}
                {numField("verifyTimeoutSec", "验证超时（秒）")}
              </div>
            </section>

            {effectiveFindingProtocol && (
              <FindingProtocolEditor
                value={findingProtocol}
                effective={effectiveFindingProtocol}
                onChange={setFindingProtocol}
                allowInherit={Boolean(projectId)}
              />
            )}

            <button
              onClick={saveRules}
              disabled={rulesBusy}
              className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
            >
              <FloppyDisk size={13} /> {rulesBusy ? "保存中…" : rulesSaved ? "已保存" : rulesFailed ? "保存失败" : "保存规则"}
            </button>
          </div>
        )}
        {activeTab === "assets" && <SharedAssetsPanel projectId={projectId} />}

        {activeTab === "roles" && (
          <div className="flex flex-col gap-3">
            <div className="settings-role-intro flex items-center gap-1 text-[13px] text-zinc-400">
              {projectId ? "项目角色启用与覆盖" : "角色注册与全局运行缺省"}
              <HelpTip>
                {projectId ? (
                  <>
                    本项目只声明与全局缺省的差异：<strong>启用 Hub 可派发的角色，并在确有需要时覆盖运行配置</strong>。
                    未覆盖项继续继承全局值，避免项目配置漂移。
                  </>
                ) : (
                  <>
                    系统角色由调度器调用，工作角色由 Hub 按意图派发。先为需要使用的角色设置<strong>可信的全局运行配置</strong>，
                    再由各项目决定启用范围或少量覆盖。点击角色名称编辑 Hub 可见的职责描述。
                  </>
                )}
              </HelpTip>
            </div>

            {/* Hub 与 系统角色分开展示，颜色显著不同 */}
            {roles.some((r) => r.kind === "hub") && (
              <>
                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-violet-300">
                    Hub 中枢
                    <HelpTip>决策与派发；与调度内核系统角色不同色</HelpTip>
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {roles.filter((r) => r.kind === "hub").map(renderRoleRow)}
                </div>
              </>
            )}
            {roles.some((r) => r.kind === "system") && (
              <>
                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-300">
                    系统角色（调度内核）
                    <HelpTip>verify / report 等由调度器调用，非 Hub 派发</HelpTip>
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {roles.filter((r) => r.kind === "system").map(renderRoleRow)}
                </div>
              </>
            )}

            {/* 普通角色分组：全局=注册表；项目=启用勾选 + 项目覆盖 */}
            <div className="mt-1 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
              {projectId ? "工作角色（Hub 可下发）" : "工作角色注册表（Hub 可下发）"}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roles.filter((r) => r.kind === "role").map(renderRoleRow)}
              {!agentLoadError && roles.filter((r) => r.kind === "role").length === 0 && (
                <div className="py-2 font-mono text-[13px] text-zinc-600 sm:col-span-2 xl:col-span-3">角色注册表为空，请检查当前 schema 基线数据</div>
              )}
            </div>

            {/* 角色/模板编辑表单：仅全局模式（项目设置只负责启用与覆盖） */}
            {!projectId && (
            <div className="role-form-panel surface-shell mt-4"><div className="surface-core flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  {roleForm.id ? `编辑 ${roleForm.name}` : "新建自定义角色"}
                  {roleForm.id && roleForm.kind !== "role" && (
                    <span className={`ml-2 rounded px-1.5 text-[11px] normal-case ${
                      roleForm.kind === "hub"
                        ? "border border-violet-400/35 bg-violet-400/10 text-violet-200"
                        : "border border-amber-400/35 bg-amber-400/10 text-amber-200"
                    }`}>
                      {roleForm.kind === "hub" ? "Hub 中枢" : "系统角色（调度内核）"}
                      ：可改展示名、职责与角色配置，不可删除或修改 kind
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setRoleForm(EMPTY_ROLE)}
                  className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 hover:border-ink-600 hover:text-zinc-200"
                >
                  <Plus size={12} weight="bold" className="block" />新建
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>标识（job 类型名）</label>
                  <input
                    value={roleForm.name}
                    onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                    disabled={Boolean(roleForm.id)}
                    className={`${inputCls} disabled:opacity-50`}
                    placeholder="如 threat_model"
                  />
                </div>
                <div>
                  <label className={labelCls}>展示名</label>
                  <input
                    value={roleForm.title}
                    onChange={(e) => setRoleForm({ ...roleForm, title: e.target.value })}
                    className={`${inputCls} disabled:opacity-50`}
                    placeholder="如 威胁建模"
                  />
                </div>
              </div>
              <div>
                <label className={labelCls}>能力描述（hub 决策时看到的角色说明）</label>
                <textarea
                  value={roleForm.description}
                  onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
                  rows={2}
                  className={`${inputCls} resize-y`}
                  placeholder="这个角色擅长什么、适合接什么意图"
                />
              </div>
              <div className="mt-1 flex gap-2">
                <button
                  onClick={saveRole}
                  className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
                >
                  <FloppyDisk size={13} /> {roleForm.id ? "保存" : "创建"}
                </button>
                {roleForm.id && roleForm.kind === "role" && (
                  <button
                    onClick={async () => {
                      await api.deleteRole(roleForm.id!).catch((e) => flash(`删除失败：${e instanceof Error ? e.message : e}`));
                      setRoleForm(EMPTY_ROLE);
                      flash("已删除");
                      reload();
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-red-900/60 px-3 py-1.5 text-[14px] text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash size={13} /> 删除
                  </button>
                )}
              </div>
            </div></div>
            )}
          </div>
        )}

        {activeTab === "users" && !projectId && <UsersPanel />}
        {activeTab === "account" && !projectId && <AccountPanel />}
        {activeTab === "transfer" && !projectId && <TransferPanel projectId={null} scope="platform" />}

        {activeTab === "plane" && projectId && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1 text-[13px] text-zinc-400">
              Plane 协作镜像
              <HelpTip>
                Plane 是可选的协作镜像：绑定后 Ready 状态的 issue（描述含 type= 标记）会被自动认领为任务；
                本地库才是唯一状态真相，Plane 故障不影响本地任务。解绑只停止后续同步，不删除已导入的任务。
              </HelpTip>
            </div>

            <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5">
              <div className="mb-1 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                当前绑定
              </div>
              {planeBind ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-run-400">{planeBind}</span>
                  <button
                    onClick={async () => {
                      setPlaneBusy(true);
                      try {
                        const r = await api.syncPlane(projectId);
                        flash(`同步完成：新建 ${r.created} 个任务`);
                      } catch (e) {
                        flash(`同步失败：${e instanceof Error ? e.message : e}`);
                      } finally {
                        setPlaneBusy(false);
                      }
                    }}
                    disabled={planeBusy}
                    className="ml-auto flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200 disabled:opacity-50"
                  >
                    <ArrowsClockwise size={11} className={planeBusy ? "animate-spin" : ""} />
                    {planeBusy ? "同步中…" : "手动同步"}
                  </button>
                  <button
                    onClick={async () => {
                      await api.unbindPlane(projectId).catch((e) => flash(`解绑失败：${e instanceof Error ? e.message : e}`));
                      flash("已解绑（已导入任务保留）");
                      reload();
                    }}
                    className="flex items-center gap-1 rounded-md border border-red-900/60 px-2 py-0.5 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash size={11} /> 解绑
                  </button>
                </div>
              ) : (
                <div className="font-mono text-[13px] text-zinc-600">未绑定 —— 纯本地项目</div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
              <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                {planeBind ? "改绑其它 Plane 项目" : "绑定 Plane 项目"}
              </span>
              <input
                value={planeInput}
                onChange={(e) => setPlaneInput(e.target.value)}
                className={inputCls}
                placeholder="Plane project UUID"
              />
              <button
                onClick={async () => {
                  if (!planeInput.trim()) return flash("Plane project UUID 必填");
                  try {
                    await api.bindPlane(projectId, planeInput.trim());
                    setPlaneInput("");
                    flash("已绑定 —— Ready issue 会被自动认领");
                    reload();
                  } catch (e) {
                    flash(`绑定失败：${e instanceof Error ? e.message : e}`);
                  }
                }}
                className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
              >
                <FloppyDisk size={13} /> 绑定
              </button>
            </div>
          </div>
        )}

        {activeTab === "credentials" && !projectId && <CredentialsPanel />}

        {activeTab === "tokens" && !projectId && <TokensPanel />}

        {activeTab === "sources" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1 text-[13px] text-zinc-400">
              模块源
              <HelpTip>
                Agent 的插件 / skill 集中托管在 Git 仓库（默认内置 <code>DeepSonar-Skills</code>
                ）。同步后扫描出全部模块，在「角色配置」里按角色勾选下发；内容随同步缓存，跑任务不再访问 Git。
              </HelpTip>
            </div>

            {sources.map((s) => (
              <div key={s.id} className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-zinc-100">{s.name}</span>
                  <span className="font-mono text-[12px] text-zinc-500">{s.branch}</span>
                  {(() => {
                    const trust = s.trust_status ?? "trusted";
                    const badge =
                      trust === "trusted" && s.enabled
                        ? { text: "已信任", cls: "border-emerald-800/60 text-emerald-300" }
                        : trust === "disabled"
                          ? { text: "已禁用", cls: "border-red-900/60 text-red-300" }
                          : { text: "待审批", cls: "border-amber-800/60 text-amber-300" };
                    return (
                      <span className={`rounded border px-1.5 py-px font-mono text-[11px] ${badge.cls}`}>
                        {badge.text}
                      </span>
                    );
                  })()}
                  <span className="ml-auto font-mono text-[12px] text-zinc-600">
                    {s.module_count ?? sourceDetails[s.id]?.catalog_json.length ?? 0} 模块
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] text-zinc-600">{s.repo_url}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-700">
                  {s.last_commit_sha ? `commit ${s.last_commit_sha.slice(0, 10)}` : "无 commit 记录"}
                  {s.last_content_hash ? ` · hash ${s.last_content_hash.slice(0, 10)}` : ""}
                  {s.synced_by ? ` · by ${s.synced_by}` : ""}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-[12px] text-zinc-600">
                    {s.synced_at ? `同步于 ${new Date(s.synced_at).toLocaleString()}` : "未同步"}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {s.trust_status !== "trusted" && (
                      <button
                        onClick={async () => {
                          await api.trustSkillSource(s.id, "trusted").catch((e) => flash(String(e)));
                          flash("已批准下发");
                          reload();
                        }}
                        className="rounded-md border border-emerald-900/60 px-2 py-0.5 font-mono text-[12px] text-emerald-300 transition-colors hover:bg-emerald-950/40"
                      >
                        批准
                      </button>
                    )}
                    {s.trust_status === "trusted" && (
                      <button
                        onClick={async () => {
                          await api.trustSkillSource(s.id, "quarantined").catch((e) => flash(String(e)));
                          flash("已撤回信任（回到隔离区）");
                          reload();
                        }}
                        className="rounded-md border border-amber-900/60 px-2 py-0.5 font-mono text-[12px] text-amber-300 transition-colors hover:bg-amber-950/40"
                      >
                        隔离
                      </button>
                    )}
                    {s.trust_status !== "disabled" && (
                      <button
                        onClick={async () => {
                          await api.trustSkillSource(s.id, "disabled").catch((e) => flash(String(e)));
                          flash("已禁用");
                          reload();
                        }}
                        className="rounded-md border border-red-900/60 px-2 py-0.5 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40"
                      >
                        禁用
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        setSyncing(s.id);
                        try {
                          const r = await api.syncSkillSource(s.id);
                          flash(`同步完成：${r.modules} 个模块`);
                          reload();
                        } catch (e) {
                          flash(`同步失败：${e instanceof Error ? e.message : e}`);
                        } finally {
                          setSyncing(null);
                        }
                      }}
                      disabled={syncing === s.id}
                      className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200 disabled:opacity-50"
                    >
                      <ArrowsClockwise size={11} className={syncing === s.id ? "animate-spin" : ""} />
                      {syncing === s.id ? "同步中…" : "同步"}
                    </button>
                    <button
                      onClick={async () => {
                        await api.deleteSkillSource(s.id).catch(() => {});
                        flash("已删除");
                        reload();
                      }}
                      className="flex items-center gap-1 rounded-md border border-red-900/60 px-2 py-0.5 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40"
                    >
                      <Trash size={11} />
                    </button>
                  </span>
                </div>
              </div>
            ))}

            <div className="flex flex-col gap-2 border-t border-ink-800 pt-3">
              <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                添加模块源
              </span>
              <input
                value={newSource.name}
                onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                className={inputCls}
                placeholder="名称（如 team-agent-skills）"
              />
              <input
                value={newSource.repo_url}
                onChange={(e) => setNewSource({ ...newSource, repo_url: e.target.value })}
                className={inputCls}
                placeholder="https://github.com/example/team-agent-skills"
              />
              <input
                value={newSource.branch}
                onChange={(e) => setNewSource({ ...newSource, branch: e.target.value })}
                className={inputCls}
                placeholder="分支（默认 main）"
              />
              <button
                onClick={async () => {
                  if (!newSource.name.trim() || !newSource.repo_url.trim()) return flash("名称与仓库地址必填");
                  try {
                    await api.createSkillSource({
                      name: newSource.name.trim(),
                      repo_url: newSource.repo_url.trim(),
                      branch: newSource.branch.trim() || "main",
                    });
                    setNewSource({ name: "", repo_url: "", branch: "main" });
                    flash("已添加，点「同步」扫描模块");
                    reload();
                  } catch (e) {
                    flash(`添加失败：${e instanceof Error ? e.message : e}`);
                  }
                }}
                className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
              >
                <Plus size={13} weight="bold" className="block" />添加
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
