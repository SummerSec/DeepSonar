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
 * 角色配置编辑器：指令 / 平台工具 / 模块。
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
};

// ---------- 表单状态 ----------

type ReasoningForm = "" | "low" | "medium" | "high" | "xhigh";

interface ConfigForm {
  /** Provider 闭环字段：UI 不编辑，保存时原样回传。 */
  agent_cli: string;
  model: string;
  reasoning: ReasoningForm;
  credential_id: string;
  env_keys: string[];
  env_vars: Record<string, string>;
  config_files: Array<{ path: string; content: string }>;
  instructions_markdown: string;
  runtime_image_key: string;
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
  credential_id: "",
  env_keys: [],
  env_vars: {},
  config_files: [],
  instructions_markdown: "",
  runtime_image_key: "",
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
    credential_id: cfg.credentials.find((c) => c.purpose === "llm")?.credential_id ?? "",
    env_keys: cfg.env_keys ?? [],
    env_vars: cfg.env_vars_json ?? {},
    config_files: (cfg.config_files ?? []).map((file) => ({ path: file.path, content: file.content })),
    instructions_markdown: cfg.instructions_markdown ?? "",
    runtime_image_key: cfg.runtime_image_key ?? "",
    modules: cfg.modules_json ?? [],
    skills: JSON.stringify(cfg.skills_json ?? [], null, 2),
    commands: JSON.stringify(cfg.commands_json ?? [], null, 2),
    mcps: JSON.stringify(cfg.mcps_json ?? [], null, 2),
    subagents: JSON.stringify(cfg.subagents_json ?? [], null, 2),
    platform_tools: cfg.platform_tools_json ?? {},
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
  void projectId;
  const availablePlatformTools = allowedPlatformTools(roleName, roleKind);
  const requiredPlatformToolSet = new Set(requiredPlatformTools(roleKind));

  const submit = () => {
    try {
      // agent_cli / 模型 / 凭据 / env / settings 由 Provider 页管理，原样回传。
      const body: RoleConfigInput = {
        agent_cli: form.agent_cli as RoleConfigInput["agent_cli"],
        model: form.model.trim() || null,
        reasoning: form.reasoning || null,
        env_keys: form.env_keys,
        env_vars: form.env_vars,
        modules: form.modules,
        skills: parseJsonArray(form.skills),
        commands: parseJsonArray(form.commands),
        mcps: parseJsonArray(form.mcps),
        subagents: parseJsonArray(form.subagents),
        platform_tools: form.platform_tools,
        instructions_markdown: form.instructions_markdown.trim() || null,
        runtime_image_key: form.runtime_image_key.trim() || null,
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

  const jsonField = (
    label: string,
    key: "skills" | "commands" | "mcps" | "subagents",
    hint?: string,
  ) => (
    <div key={key}>
      <label className={labelCls}>
        {label}
        {hint ? <HelpTip>{hint}</HelpTip> : null}
      </label>
      <textarea
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        rows={2}
        spellCheck={false}
        placeholder="[]"
        className={`${inputCls} resize-y`}
      />
    </div>
  );

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
          <div>
            <label className={labelCls}>
              Worker 长期指令
              <HelpTip>
                平台会自动补充工作区、prompt 输入、runtime-manifest、动态 skill / command / MCP / sub-agent、环境变量名称、网络边界、不可用内部接口和增量结果工具；这里仅维护该角色长期稳定的职责与方法。
              </HelpTip>
            </label>
            <textarea value={form.instructions_markdown} onChange={(e) => setForm({ ...form, instructions_markdown: e.target.value })} rows={10} className={`${inputCls} resize-y`} placeholder="每个 Job 会冻结并生成 /workspace/AGENTS.md 与 /workspace/CLAUDE.md；不要在这里填写某一次任务内容。" />
            {form.instructions_markdown.trim() && <details className="mt-2 rounded-xl bg-black/20 ring-1 ring-white/[.06]"><summary className="cursor-pointer px-3 py-2 font-mono text-[10px] text-zinc-500">Markdown 预览 / 原文 / 复制</summary><div className="border-t border-white/[.05] p-3"><MarkdownView markdown={form.instructions_markdown} /></div></details>}
          </div>
          <div>
            <label className={labelCls}>
              平台工具
              <HelpTip>
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
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border border-ink-700 bg-ink-850/70 px-3 py-2.5 transition-colors hover:border-ink-600"
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={required}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        platform_tools: { ...current.platform_tools, [tool]: event.target.checked },
                      }))}
                      className="mt-1 accent-acc-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[13px] text-zinc-200">
                        <code className="font-mono text-acc-300">{tool}</code>
                        <span>{meta.title}</span>
                        {required && <em className="rounded bg-acc-500/10 px-1.5 py-0.5 font-mono text-[9px] not-italic text-acc-300">终态必需</em>}
                      </span>
                      <small className="mt-0.5 block text-[11px] leading-5 text-zinc-600">{meta.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </section>

        <details className="role-config-section role-config-modules">
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
              {" · 默认收起"}
            </small>
            <CaretDown size={14} />
          </summary>
          <div className="role-config-modules-body">
            <ModulePicker sources={sources} sourceDetails={sourceDetails} selected={form.modules} onChange={(modules) => setForm({ ...form, modules })} />
          </div>
        </details>
      </div>

      <details className="role-config-advanced">
        <summary><span><strong>高级运行声明</strong><small>JSON 模块、MCP、子 Agent</small></span><CaretDown size={14} /></summary>
        <div className="role-config-advanced-grid">
          {jsonField("skills（模块勾选优先）", "skills", '[{"name":"x","repo":"https://…"}] 或 embedded source')}
          {jsonField("commands（slash 命令）", "commands")}
          {jsonField("mcps（MCP server）", "mcps", '[{"name":"fs","type":"local","command":"npx","args":[…]}]')}
          {jsonField("subagents（子 Agent）", "subagents")}
        </div>
      </details>

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
