import { CaretDown, Check, FloppyDisk, MagnifyingGlass, X } from "@phosphor-icons/react";
import {
  allowedPlatformTools,
  requiredPlatformTools,
  type PlatformToolConfig,
  type PlatformToolName,
} from "@deepsonar/shared-types";
import { useMemo, useState } from "react";
import {
  type ProviderCredential,
  type RoleConfigInput,
  type RoleConfigView,
  type SandboxLimitsOverride,
  type SkillSource,
  type SkillSourceDetail,
} from "./api";
import { MarkdownView } from "./MarkdownView";
import { HelpTip } from "./ui";
import {
  countIncludedModules,
  groupModuleOptions,
  isPluginGroupExpanded,
  moduleIsIncluded,
  moduleSelectorFor,
  pluginSelectorFor,
  selectorIsActive,
  sourceSelectorFor,
  toggleExplicitModule,
  togglePluginGroupExpanded,
  toggleSelector,
  type ModulePickerOption,
} from "./module-selector-state";

/**
 * 角色配置编辑器：指令 / 平台工具 / 模块 / CLI 客户端上下文预算覆盖。
 * Agent CLI、模型、LLM 凭据、settings/env 由 Provider 账号页承接；运行镜像由镜像页承接。
 * 保存时保留已有 agent_cli / credential / model / reasoning / env / runtime_image 绑定。
 */

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

const PLATFORM_TOOL_META: Record<PlatformToolName, { title: string; description: string }> = {
  list_available_roles: { title: "查询可用角色", description: "让 Hub 按需获取当前项目可派发的数据库角色。" },
  list_shared_assets: { title: "查询共享资产", description: "列出本 Job 冻结的只读资产目录；用 mount_path 直接读取，无单独下载工具（Scheduler 预挂载，含 S3）。" },
  publish_shared_asset: { title: "发布共享资产", description: "把 /workspace 普通文件发布为不可变版本；Scheduler 经 BlobStore（本地/S3）落库，禁止从只读挂载树发布。" },
  emit_progress: { title: "过程进度", description: "允许 Worker 增量上报当前动作和完成百分比。" },
  emit_fact: { title: "事实提交", description: "允许工作角色把新证据写成画布 Fact。" },
  emit_finding: { title: "漏洞提交", description: "允许审计角色提交带严重级别的 Finding。" },
  submit_hub_decision: { title: "Hub 决策", description: "允许 Hub 提交完成结论或下一批派发意图。" },
  mark_job_done: { title: "正常完成", description: "提交 Job 最终摘要并形成合法终态。" },
  request_human: { title: "请求人工", description: "遇到授权或高风险阻塞时结束本轮并请求人工介入。" },
  ack_human_message: { title: "确认人工消息", description: "仅在当前 Job 实际收到人工消息后显式 ACK；普通文本回复不会确认。" },
};

// ---------- 表单状态 ----------

type ReasoningForm = "" | "low" | "medium" | "high" | "xhigh";

interface ConfigForm {
  /** Provider 闭环字段：UI 不编辑，保存时原样回传。 */
  agent_cli: string;
  model: string;
  reasoning: ReasoningForm;
  context_window_tokens: string;
  credential_id: string;
  env_keys: string[];
  env_vars: Record<string, string>;
  config_files: Array<{ path: string; content: string }>;
  instructions_markdown: string;
  runtime_image_key: string;
  sandbox_limits: {
    cpu: string;
    memoryMiB: string;
    pidsLimit: string;
  };
  modules: string[];
  skills: string;
  commands: string;
  mcps: string;
  subagents: string;
  platform_tools: PlatformToolConfig;
}

const EMPTY: ConfigForm = {
  agent_cli: "claude-code",
  model: "",
  reasoning: "",
  context_window_tokens: "",
  credential_id: "",
  env_keys: [],
  env_vars: {},
  config_files: [],
  instructions_markdown: "",
  runtime_image_key: "",
  sandbox_limits: { cpu: "", memoryMiB: "", pidsLimit: "" },
  modules: [],
  skills: "[]",
  commands: "[]",
  mcps: "[]",
  subagents: "[]",
  platform_tools: {},
};

/** 从已有 RoleConfig 视图预填表单（无配置时给缺省值） */
function formOf(cfg: RoleConfigView | null | undefined): ConfigForm {
  if (!cfg) return EMPTY;
  return {
    agent_cli: cfg.agent_cli,
    model: cfg.model ?? "",
    reasoning: (cfg.reasoning as ReasoningForm | null) ?? "",
    context_window_tokens: cfg.context_window_tokens == null ? "" : String(cfg.context_window_tokens),
    credential_id: cfg.credentials.find((c) => c.purpose === "llm")?.credential_id ?? "",
    env_keys: cfg.env_keys ?? [],
    env_vars: cfg.env_vars_json ?? {},
    config_files: (cfg.config_files ?? []).map((file) => ({ path: file.path, content: file.content })),
    instructions_markdown: cfg.instructions_markdown ?? "",
    runtime_image_key: cfg.runtime_image_key ?? "",
    sandbox_limits: {
      cpu: cfg.sandbox_limits_json?.cpu === undefined ? "" : String(cfg.sandbox_limits_json.cpu),
      memoryMiB: cfg.sandbox_limits_json?.memoryMiB === undefined ? "" : String(cfg.sandbox_limits_json.memoryMiB),
      pidsLimit: cfg.sandbox_limits_json?.pidsLimit === undefined ? "" : String(cfg.sandbox_limits_json.pidsLimit),
    },
    modules: cfg.modules_json ?? [],
    skills: JSON.stringify(cfg.skills_json ?? [], null, 2),
    commands: JSON.stringify(cfg.commands_json ?? [], null, 2),
    mcps: JSON.stringify(cfg.mcps_json ?? [], null, 2),
    subagents: JSON.stringify(cfg.subagents_json ?? [], null, 2),
    platform_tools: cfg.platform_tools_json ?? {},
  };
}

const SANDBOX_LIMIT_FIELDS = [
  { key: "cpu", label: "CPU", unit: "cores", min: 0.25, max: 64, step: 0.25 },
  { key: "memoryMiB", label: "Memory", unit: "MiB", min: 256, max: 131_072, step: 256 },
  { key: "pidsLimit", label: "PIDs", unit: "processes", min: 64, max: 32_768, step: 1 },
] as const;

function numericSandboxOverride(raw: string, label: string, min: number, max: number, integer: boolean): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}${integer ? " (integer)" : ""}`);
  }
  return value;
}

function contextWindowTokensFromForm(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 10_000_000) {
    throw new Error("上下文预算必须是 1024–10000000 的整数");
  }
  return value;
}

function sandboxLimitsFromForm(form: ConfigForm): SandboxLimitsOverride {
  const cpu = numericSandboxOverride(form.sandbox_limits.cpu, "CPU", 0.25, 64, false);
  const memoryMiB = numericSandboxOverride(form.sandbox_limits.memoryMiB, "Memory MiB", 256, 131_072, true);
  const pidsLimit = numericSandboxOverride(form.sandbox_limits.pidsLimit, "PIDs", 64, 32_768, true);
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
    ...(pidsLimit === undefined ? {} : { pidsLimit }),
  };
}

function parseJsonArray(text: string): Record<string, unknown>[] {
  const v = JSON.parse(text || "[]") as unknown;
  if (!Array.isArray(v)) throw new Error("必须是 JSON 数组");
  return v as Record<string, unknown>[];
}

function ModulePicker({ sources, sourceDetails, selected, onChange }: { sources: SkillSource[]; sourceDetails: Record<string, SkillSourceDetail>; selected: string[]; onChange: (values: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("all");
  /** Per-plugin open/closed overrides; default is collapsed (search expands matches). */
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(() => new Map());
  const options = useMemo<ModulePickerOption[]>(
    () => sources.flatMap((source) => (sourceDetails[source.id]?.catalog_json ?? []).map((module) => ({
      ...module,
      key: moduleSelectorFor(source.id, module.id),
      sourceId: source.id,
      sourceName: source.name,
    }))),
    [sources, sourceDetails],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options.filter((option) =>
      (sourceId === "all" || option.sourceId === sourceId) &&
      `${option.name} ${option.description} ${option.plugin} ${option.kind} ${option.sourceName}`.toLowerCase().includes(needle),
    );
  }, [options, query, sourceId]);
  const groups = useMemo(() => groupModuleOptions(options), [options]);
  const visibleKeys = filtered.map((option) => option.key);
  const allVisibleDirectSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selected.includes(key));
  const toggleOne = (option: ModulePickerOption) => onChange(toggleExplicitModule(selected, option.sourceId, option.id));
  const toggleVisible = () => {
    if (allVisibleDirectSelected) onChange(selected.filter((key) => !visibleKeys.includes(key)));
    else onChange([...new Set([...selected, ...visibleKeys])]);
  };
  const selectedGroupSelectors = selected.filter((value) => value.includes(":plugin:") || value.endsWith(":source:*"));
  const selectedDirectOptions = options.filter((option) => selected.includes(option.key));
  const sourceOptions = sources.map((source) => ({
    source,
    options: filtered.filter((option) => option.sourceId === source.id),
    total: options.filter((option) => option.sourceId === source.id).length,
  })).filter(({ source }) => sourceId === "all" || source.id === sourceId);

  const visiblePluginKeys = useMemo(() => {
    const keys: string[] = [];
    for (const { source, options: sourceVisible } of sourceOptions) {
      for (const group of groups.filter((item) => item.sourceId === source.id)) {
        const visible = group.options.filter((option) => sourceVisible.some((item) => item.key === option.key));
        if (visible.length > 0 || !query.trim()) keys.push(group.selector);
      }
    }
    return keys;
  }, [groups, query, sourceOptions]);

  const expandAllVisible = () => {
    setExpandOverrides((current) => {
      const next = new Map(current);
      for (const key of visiblePluginKeys) next.set(key, true);
      return next;
    });
  };
  const collapseAll = () => setExpandOverrides(new Map(visiblePluginKeys.map((key) => [key, false])));

  return <div className="module-picker">
    <div className="module-toolbar">
      <div className="selector-search flex-1"><MagnifyingGlass size={14} weight="light" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill、Command、插件或说明" /></div>
      <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} aria-label="模块来源"><option value="all">全部模块源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
    </div>
    <div className="module-summary">
      <span><strong>{selected.length}</strong> 个选择器已选 · 当前显示 {filtered.length} 个模块 · 插件默认折叠</span>
      <div>
        <button type="button" onClick={expandAllVisible} disabled={visiblePluginKeys.length === 0}>展开插件</button>
        <button type="button" onClick={collapseAll} disabled={visiblePluginKeys.length === 0}>全部折叠</button>
        <button type="button" onClick={toggleVisible} disabled={visibleKeys.length === 0}>{allVisibleDirectSelected ? "取消当前结果" : "全选当前结果"}</button>
        {selected.length > 0 && <button type="button" onClick={() => onChange([])}>全部清空</button>}
      </div>
    </div>
    {selectedGroupSelectors.length > 0 && <div className="selected-modules">{selectedGroupSelectors.map((selector) => <button type="button" key={selector} onClick={() => onChange(toggleSelector(selected, selector))} title="取消整组选择"><span>{selector.endsWith(":source:*") ? "整源" : `插件 · ${selector.split(":plugin:")[1] ?? selector}`}</span><X size={11} /></button>)}</div>}
    {selectedDirectOptions.length > 0 && <div className="selected-modules">{selectedDirectOptions.map((option) => <button type="button" key={option.key} onClick={() => toggleOne(option)} title="移除单个模块"><span>{option.name}</span><X size={11} /></button>)}</div>}
    <div className="module-results">
      {sourceOptions.map(({ source, options: sourceVisible, total }) => {
        const sourceSelector = sourceSelectorFor(source.id);
        const sourceActive = selectorIsActive(selected, sourceSelector);
        const sourceGroups = groups
          .filter((group) => group.sourceId === source.id)
          .map((group) => ({
            ...group,
            options: group.options.filter((option) => sourceVisible.some((item) => item.key === option.key)),
          }))
          .filter((group) => group.options.length > 0 || !query.trim());
        return <div key={source.id} className="module-source-group">
          <div className="module-group-heading">
            <span>
              <strong>{source.name}</strong>
              <small>
                {total > 0 ? `${total} 个目录项 · ${sourceGroups.length} 个插件` : "目录为空，请先同步"}
                {source.trust_status !== "trusted" ? ` · ${source.trust_status === "quarantined" ? "待审批" : "未启用"}` : ""}
              </small>
            </span>
            <button type="button" disabled={total === 0} className={sourceActive ? "is-selected" : ""} onClick={() => onChange(toggleSelector(selected, sourceSelector))}>{sourceActive ? "取消整源" : "挂载整源"}</button>
          </div>
          {sourceGroups.map((group) => {
            const pluginExplicit = selectorIsActive(selected, pluginSelectorFor(group.sourceId, group.plugin));
            const pluginActive = pluginExplicit || sourceActive;
            const included = countIncludedModules(group.options, selected);
            const expanded = isPluginGroupExpanded({
              groupKey: group.selector,
              query,
              overrides: expandOverrides,
              hasVisibleModules: group.options.length > 0,
            });
            return <div key={group.selector} className={`module-plugin-group${expanded ? " is-expanded" : " is-collapsed"}`}>
              <div className="module-group-heading module-plugin-heading">
                <button
                  type="button"
                  className="module-plugin-toggle"
                  aria-expanded={expanded}
                  onClick={() => setExpandOverrides((current) => togglePluginGroupExpanded(current, group.selector, expanded))}
                >
                  <CaretDown size={12} className={`module-plugin-caret ${expanded ? "is-open" : ""}`} />
                  <span>
                    <strong>{group.plugin}</strong>
                    <small>
                      {group.options.length} 个模块
                      {included > 0 ? ` · ${included} 已选` : ""}
                      {sourceActive ? " · 随整源包含" : pluginExplicit ? " · 整插件挂载" : " · 点开可单选"}
                    </small>
                  </span>
                </button>
                <button type="button" disabled={sourceActive} className={pluginActive ? "is-selected" : ""} onClick={() => onChange(toggleSelector(selected, group.selector))}>{sourceActive ? "随整源" : pluginExplicit ? "取消插件" : "挂载插件"}</button>
              </div>
              {expanded && group.options.map((option) => {
                const checked = moduleIsIncluded(option, selected);
                const inherited = checked && !selected.includes(option.key);
                return <label key={option.key} className={checked ? "is-selected" : ""}>
                  <input type="checkbox" checked={checked} disabled={inherited} onChange={() => toggleOne(option)} />
                  <span className="module-check">{checked && <Check size={12} weight="bold" />}</span>
                  <span className="min-w-0 flex-1">
                    <strong>{option.name}</strong>
                    <small>{option.description || `${option.plugin} 中的 ${option.kind}`}{inherited ? " · 随组包含" : ""}</small>
                  </span>
                  <span className="module-meta"><em>{option.kind}</em><small>{option.sourceName} / {option.plugin}</small></span>
                </label>;
              })}
            </div>;
          })}
        </div>;
      })}
      {sources.length === 0 && <div className="selector-empty">尚未添加模块源，请先到「模块源」登记并同步仓库。</div>}
      {sources.length > 0 && filtered.length === 0 && <div className="selector-empty">没有匹配的模块；空目录请先同步，插件/整源选择会在下一 Job 按当前 catalog 展开。</div>}
    </div>
  </div>;
}

export function RoleConfigEditor({
  title,
  roleName,
  roleKind,
  projectId,
  initial,
  credentials,
  sources,
  sourceDetails,
  busy,
  onSave,
  onCancel,
}: {
  /** 表单标题（如「全局缺省配置 · explore」「项目覆盖 · verify」） */
  title: string;
  roleName: string;
  roleKind: "role" | "hub" | "system";
  projectId?: string;
  /** 预填配置：项目覆盖时传全局配置做底，全局编辑时传现有全局配置 */
  initial: RoleConfigView | null | undefined;
  /** 可选 Credential（调用方已按项目边界过滤：全局=null 或本项目） */
  credentials: ProviderCredential[];
  /** Git 模块源（模块勾选列表用） */
  sources: SkillSource[];
  sourceDetails: Record<string, SkillSourceDetail>;
  busy: boolean;
  onSave: (body: RoleConfigInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ConfigForm>(() => formOf(initial));
  const [error, setError] = useState<string | null>(null);
  void credentials; // 仍由父组件传入以兼容签名；CLI/凭据/模型改由 Provider 页绑定
  const availablePlatformTools = allowedPlatformTools(roleName, roleKind);
  const requiredPlatformToolSet = new Set(requiredPlatformTools(roleKind));

  const submit = () => {
    try {
      // Provider 页管理 CLI、模型、凭据与 settings；这里编辑上下文预算覆盖并原样保留其余字段。
      const body: RoleConfigInput = {
        agent_cli: form.agent_cli as RoleConfigInput["agent_cli"],
        model: form.model.trim() || null,
        reasoning: form.reasoning || null,
        context_window_tokens: contextWindowTokensFromForm(form.context_window_tokens),
        env_keys: form.env_keys,
        env_vars: form.env_vars,
        modules: form.modules,
        skills: parseJsonArray(form.skills),
        commands: parseJsonArray(form.commands),
        mcps: parseJsonArray(form.mcps),
        subagents: parseJsonArray(form.subagents),
        platform_tools: form.platform_tools,
        instructions_markdown: form.instructions_markdown.trim() || null,
        runtime_image_key: projectId ? null : form.runtime_image_key.trim() || null,
        sandbox_limits: sandboxLimitsFromForm(form),
        credentials: form.credential_id
          ? [{ credential_id: form.credential_id, purpose: "llm" }]
          : [],
        config_files: form.config_files,
      };
      setError(null);
      onSave(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="role-config-editor min-w-0">
      <div className="role-config-header flex-wrap">
        <div>
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-acc-400">{title}</span>
          <p>定义这个角色下一次运行时冻结的执行快照。</p>
        </div>
        <span className="role-config-snapshot">NEXT JOB SNAPSHOT</span>
        <button
          onClick={onCancel}
          aria-label="收起"
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-ink-800 hover:text-zinc-200"
        >
          <X size={14} />
        </button>
      </div>

      <div className="role-config-grid">
        <section className="role-config-section role-config-runtime">
          <div className="role-config-section-title">
            <span>01</span>
            <strong>
              指令与平台工具
              <HelpTip>
                Agent CLI、LLM 凭据、模型与 settings/env 请在「凭据 / Provider 账号」页配置与绑定；此处仅维护角色职责与平台工具。
                {form.agent_cli ? ` 当前 RoleConfig agent_cli=${form.agent_cli}（由 Provider 绑定流程维护）。` : ""}
                {form.credential_id ? " 已绑定 LLM 凭据。" : " 尚未绑定 LLM 凭据。"}
              </HelpTip>
            </strong>
          </div>
          <details className="role-config-instructions">
            <summary className="role-config-instructions-summary">
              <span className="role-config-instructions-title">
                Worker 长期指令
                <HelpTip>
                  平台会自动补充工作区、prompt 输入、runtime-manifest、动态 skill / command / MCP / sub-agent、环境变量名称、网络边界、不可用内部接口和增量结果工具；这里仅维护该角色长期稳定的职责与方法。
                </HelpTip>
              </span>
              <small>
                {form.instructions_markdown.trim()
                  ? `${form.instructions_markdown.trim().length} 字`
                  : "未填写"}
              </small>
              <CaretDown size={14} />
            </summary>
            <div className="role-config-instructions-body">
              <MarkdownView
                markdown={form.instructions_markdown}
                editable
                onChange={(value) => setForm({ ...form, instructions_markdown: value })}
                rows={12}
                placeholder="每个 Job 会冻结并生成 /workspace/AGENTS.md 与 /workspace/CLAUDE.md；不要在这里填写某一次任务内容。支持 Markdown。"
                className="rounded-xl border border-ink-700 bg-ink-850/50 p-2.5"
              />
            </div>
          </details>
          <div>
            <label className={labelCls}>
              平台工具
              <HelpTip>
                平台工具 list 对每个 Agent 全量可选，默认全部启用；仅 mark_job_done（正常完成）为终态必需且不可关闭。
                保存后从下一 Job 起生效并冻结到快照；关闭的工具不会注入 MCP，也不会出现在动态 AGENTS.md、CLAUDE.md 和运行清单的可用列表中。
              </HelpTip>
            </label>
            <div className="flex flex-col gap-1.5">
              {availablePlatformTools.map((tool) => {
                const required = requiredPlatformToolSet.has(tool);
                const enabled = required || form.platform_tools[tool] !== false;
                const meta = PLATFORM_TOOL_META[tool];
                return (
                  <label
                    key={tool}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md border border-ink-700 bg-ink-850/70 px-3 py-2.5 transition-colors hover:border-ink-600"
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={required}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        platform_tools: { ...current.platform_tools, [tool]: event.target.checked },
                      }))}
                      className="accent-acc-500"
                    />
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-200">
                      <code className="font-mono text-acc-300">{tool}</code>
                      <span className="inline-flex items-center">
                        {meta.title}
                        <HelpTip label={`${meta.title} 说明`}>{meta.description}</HelpTip>
                      </span>
                      {required && (
                        <em className="rounded bg-acc-500/10 px-1.5 py-0.5 font-mono text-[9px] not-italic text-acc-300">
                          终态必需
                        </em>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="mt-4 border-t border-ink-700/60 pt-4">
            <label className={labelCls}>
              CLI 客户端上下文预算（tokens）
              <HelpTip>
                可选的 RoleConfig 覆盖，留空继承 Provider 账号 settings_config_json 顶层值，再留空则使用 Provider / CLI 默认。
                这是 CLI 客户端预算，不会提升上游模型能力；Claude Code 仅冻结并展示该值，不伪造不受支持的绝对窗口设置。
              </HelpTip>
            </label>
            <input
              type="number"
              min={1024}
              max={10_000_000}
              step={1}
              value={form.context_window_tokens}
              onChange={(event) => setForm((current) => ({ ...current, context_window_tokens: event.target.value }))}
              placeholder="留空继承 Provider / CLI 默认"
              className={inputCls}
              aria-label="RoleConfig CLI 客户端上下文预算"
            />
            <span className="mt-1 block text-[11px] text-zinc-600">整数范围 1024–10000000；只影响下一 Job 的冻结客户端预算。</span>
          </div>
          <div className="mt-4 border-t border-ink-700/60 pt-4">
            <label className={labelCls}>
              Sandbox resources
              <HelpTip>
                Numeric overrides are available only for project RoleConfigs. Leave a field blank to inherit the server default.
                CPU is measured in cores; memory in MiB; PIDs is the process limit. Capability drop and no-new-privileges remain server-governed.
              </HelpTip>
            </label>
            <p className="mb-2 text-[11px] leading-5 text-zinc-500">
              {projectId
                ? "Project override · blank fields inherit server defaults"
                : "Global RoleConfig · server defaults only (project overrides can be set per project)"}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {SANDBOX_LIMIT_FIELDS.map((field) => (
                <label key={field.key} className="rounded-md border border-ink-700 bg-ink-850/70 px-2.5 py-2">
                  <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.1em] text-zinc-500">
                    {field.label} <span className="normal-case text-zinc-600">({field.unit})</span>
                  </span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={form.sandbox_limits[field.key]}
                    disabled={!projectId}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      sandbox_limits: { ...current.sandbox_limits, [field.key]: event.target.value },
                    }))}
                    placeholder={`${field.min}–${field.max}`}
                    className={inputCls}
                    aria-label={`${field.label} ${field.unit}`}
                  />
                  <span className="mt-1 block font-mono text-[10px] text-zinc-600">bounds {field.min}–{field.max}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <details className="role-config-section role-config-modules" open>
          <summary className="role-config-modules-summary">
            <div className="role-config-section-title">
              <span>02</span>
              <strong>
                Agent 模块目录
                <HelpTip>
                  目录由「模块源」同步生成。展开后列表内上下滚动；可挂载整插件/整源，selector 会跟随后续 sync 在下一 Job 纳入新增模块。
                </HelpTip>
              </strong>
            </div>
            <small>
              {form.modules.length > 0 ? `已选 ${form.modules.length} 个` : "未选模块"}
            </small>
            <CaretDown size={14} />
          </summary>
          <div className="role-config-modules-body">
            <ModulePicker sources={sources} sourceDetails={sourceDetails} selected={form.modules} onChange={(modules) => setForm({ ...form, modules })} />
          </div>
        </details>
      </div>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 font-mono text-[13px] text-red-300">
          {error}
        </div>
      )}

      <div className="role-config-actions">
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:opacity-50"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : "保存配置"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-ink-700 px-3 py-1.5 text-[14px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
        >
          取消
        </button>
        <span className="ml-auto self-center font-mono text-[12px] text-zinc-600">下一 job 生效</span>
      </div>
    </div>
  );
}
