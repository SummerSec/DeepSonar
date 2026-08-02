import { CaretDown, Check, FloppyDisk, Key, MagnifyingGlass, Plus, Trash, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ProviderCredential,
  type RoleConfigInput,
  type RoleConfigView,
  type SkillSource,
  type SkillSourceDetail,
} from "./api";

/**
 * 角色配置编辑器（§4.2 角色即配置）：全局缺省与项目覆盖共用同一表单。
 * 全量声明式保存 —— 每次保存整体替换 Credential 绑定与 Provider 配置文件。
 * 生效语义：下一 job 生效（job 创建时冻结快照）。
 */

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

/** 各 CLI 的 Provider 配置文件固定路径（首期白名单，与后端 core.ts CONFIG_FILE_PATHS 一致） */
const CONFIG_FILE_PATHS: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  codex: ".codex/config.toml",
  "open-code": ".opencode/config.json",
};

// ---------- 表单状态 ----------

interface EnvPair {
  key: string;
  value: string;
}

type ReasoningForm = "" | "low" | "medium" | "high" | "xhigh";

interface ConfigForm {
  agent_cli: string;
  model: string;
  reasoning: ReasoningForm;
  credential_id: string; // "" = 不绑定（退回 env_keys 过渡路径）
  env_keys: string; // 逗号分隔
  env_pairs: EnvPair[]; // 非敏感环境变量键值对
  instructions_markdown: string;
  runtime_image_key: string;
  modules: string[]; // 勾选的 Git 模块（"<source_id>:<module_id>"）
  skills: string; // JSON 文本
  commands: string;
  mcps: string;
  subagents: string;
  config_content: string; // Provider 配置文件内容（路径按 agent_cli 固定）
}

const EMPTY: ConfigForm = {
  agent_cli: "claude-code",
  model: "",
  reasoning: "",
  credential_id: "",
  env_keys: "",
  env_pairs: [],
  instructions_markdown: "",
  runtime_image_key: "",
  modules: [],
  skills: "[]",
  commands: "[]",
  mcps: "[]",
  subagents: "[]",
  config_content: "",
};

/** 从已有 RoleConfig 视图预填表单（无配置时给缺省值） */
function formOf(cfg: RoleConfigView | null | undefined): ConfigForm {
  if (!cfg) return EMPTY;
  return {
    agent_cli: cfg.agent_cli,
    model: cfg.model ?? "",
    reasoning: (cfg.reasoning as ReasoningForm | null) ?? "",
    // 首期 UI 只暴露单条 purpose=llm 绑定（多用途绑定后端已支持）
    credential_id: cfg.credentials.find((c) => c.purpose === "llm")?.credential_id ?? "",
    env_keys: (cfg.env_keys ?? []).join(", "),
    env_pairs: Object.entries(cfg.env_vars_json ?? {}).map(([key, value]) => ({ key, value })),
    instructions_markdown: cfg.instructions_markdown ?? "",
    runtime_image_key: cfg.runtime_image_key ?? "",
    modules: cfg.modules_json ?? [],
    skills: JSON.stringify(cfg.skills_json ?? [], null, 2),
    commands: JSON.stringify(cfg.commands_json ?? [], null, 2),
    mcps: JSON.stringify(cfg.mcps_json ?? [], null, 2),
    subagents: JSON.stringify(cfg.subagents_json ?? [], null, 2),
    config_content: cfg.config_files[0]?.content ?? "",
  };
}

function parseJsonArray(text: string): Record<string, unknown>[] {
  const v = JSON.parse(text || "[]") as unknown;
  if (!Array.isArray(v)) throw new Error("必须是 JSON 数组");
  return v as Record<string, unknown>[];
}

function CredentialPicker({ credentials, value, onChange }: { credentials: ProviderCredential[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const available = credentials.filter((credential) => credential.status === "active");
  const selected = available.find((credential) => credential.id === value) ?? null;
  const filtered = available.filter((credential) => `${credential.name} ${credential.provider} ${credential.kind} ${credential.last4}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div ref={rootRef} className="relative"><button type="button" onClick={() => setOpen((current) => !current)} className={`selector-trigger ${open ? "is-open" : ""}`} aria-haspopup="listbox" aria-expanded={open}><span className="selector-icon"><Key size={15} weight="light" /></span><span className="min-w-0 flex-1 text-left">{selected ? <><strong>{selected.name}</strong><small>{selected.provider} · 尾号 {selected.last4}{selected.project_id ? " · 项目凭据" : " · 全局凭据"}</small></> : <><strong>不绑定凭据</strong><small>使用调度器环境变量过渡路径</small></>}</span><CaretDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} /></button>{open && <div className="selector-popover"><div className="selector-search"><MagnifyingGlass size={14} weight="light" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称、Provider 或尾号搜索" /></div><div className="selector-options" role="listbox"><button type="button" className={!value ? "is-selected" : ""} onClick={() => { onChange(""); setOpen(false); }}><span><strong>不绑定凭据</strong><small>退回 env 引用</small></span>{!value && <Check size={14} />}</button>{filtered.map((credential) => <button type="button" key={credential.id} className={value === credential.id ? "is-selected" : ""} onClick={() => { onChange(credential.id); setOpen(false); }}><span><strong>{credential.name}</strong><small>{credential.provider} · {credential.kind} · …{credential.last4}</small></span><em>{credential.project_id ? "项目" : "全局"}</em>{value === credential.id && <Check size={14} />}</button>)}{filtered.length === 0 && <div className="selector-empty">没有匹配的可用凭据</div>}</div></div>}</div>;
}

function ModulePicker({ sources, sourceDetails, selected, onChange }: { sources: SkillSource[]; sourceDetails: Record<string, SkillSourceDetail>; selected: string[]; onChange: (values: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("all");
  const options = useMemo(() => sources.flatMap((source) => (sourceDetails[source.id]?.catalog_json ?? []).map((module) => ({ ...module, key: `${source.id}:${module.id}`, sourceId: source.id, sourceName: source.name }))), [sources, sourceDetails]);
  const filtered = options.filter((option) => (sourceId === "all" || option.sourceId === sourceId) && `${option.name} ${option.description} ${option.plugin} ${option.kind} ${option.sourceName}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedOptions = options.filter((option) => selected.includes(option.key));
  const visibleKeys = filtered.map((option) => option.key);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((key) => selected.includes(key));
  const toggleOne = (key: string) => onChange(selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key]);
  const toggleVisible = () => onChange(allVisibleSelected ? selected.filter((key) => !visibleKeys.includes(key)) : [...new Set([...selected, ...visibleKeys])]);
  return <div className="module-picker"><div className="module-toolbar"><div className="selector-search flex-1"><MagnifyingGlass size={14} weight="light" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill、Command、插件或说明" /></div><select value={sourceId} onChange={(event) => setSourceId(event.target.value)} aria-label="模块来源"><option value="all">全部模块源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div><div className="module-summary"><span><strong>{selected.length}</strong> 个模块已选 · 当前显示 {filtered.length}</span><div><button type="button" onClick={toggleVisible} disabled={visibleKeys.length === 0}>{allVisibleSelected ? "取消当前结果" : "全选当前结果"}</button>{selected.length > 0 && <button type="button" onClick={() => onChange([])}>全部清空</button>}</div></div>{selectedOptions.length > 0 && <div className="selected-modules">{selectedOptions.map((option) => <button type="button" key={option.key} onClick={() => toggleOne(option.key)} title="移除"><span>{option.name}</span><X size={11} /></button>)}</div>}<div className="module-results">{filtered.map((option) => { const checked = selected.includes(option.key); return <label key={option.key} className={checked ? "is-selected" : ""}><input type="checkbox" checked={checked} onChange={() => toggleOne(option.key)} /><span className="module-check">{checked && <Check size={12} weight="bold" />}</span><span className="min-w-0 flex-1"><strong>{option.name}</strong><small>{option.description || `${option.plugin} 中的 ${option.kind}`}</small></span><span className="module-meta"><em>{option.kind}</em><small>{option.sourceName} / {option.plugin}</small></span></label>; })}{sources.length === 0 && <div className="selector-empty">尚未添加模块源，请先到「模块源」登记并同步仓库。</div>}{sources.length > 0 && filtered.length === 0 && <div className="selector-empty">没有匹配的模块</div>}</div></div>;
}

export function RoleConfigEditor({
  title,
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

  const setPair = (i: number, patch: Partial<EnvPair>) =>
    setForm((f) => ({
      ...f,
      env_pairs: f.env_pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    }));

  const submit = () => {
    try {
      const env_vars: Record<string, string> = {};
      for (const p of form.env_pairs) {
        const k = p.key.trim();
        if (!k && !p.value) continue; // 跳过完全空的行
        if (!k) throw new Error("环境变量名不能为空");
        if (env_vars[k] !== undefined) throw new Error(`环境变量名重复：${k}`);
        env_vars[k] = p.value;
      }
      const configPath = CONFIG_FILE_PATHS[form.agent_cli] ?? CONFIG_FILE_PATHS["claude-code"];
      const body: RoleConfigInput = {
        agent_cli: form.agent_cli as RoleConfigInput["agent_cli"],
        model: form.model.trim() || null,
        reasoning: form.reasoning || null,
        env_keys: form.env_keys.split(",").map((s) => s.trim()).filter(Boolean),
        env_vars,
        modules: form.modules,
        skills: parseJsonArray(form.skills),
        commands: parseJsonArray(form.commands),
        mcps: parseJsonArray(form.mcps),
        subagents: parseJsonArray(form.subagents),
        instructions_markdown: form.instructions_markdown.trim() || null,
        runtime_image_key: form.runtime_image_key.trim() || null,
        credentials: form.credential_id
          ? [{ credential_id: form.credential_id, purpose: "llm" }]
          : [],
        config_files: form.config_content.trim()
          ? [{ path: configPath, content: form.config_content }]
          : [],
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
      <label className={labelCls}>{label}</label>
      <textarea
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        rows={2}
        spellCheck={false}
        placeholder="[]"
        className={`${inputCls} resize-y`}
      />
      {hint && <div className="mt-0.5 text-[12px] text-zinc-600">{hint}</div>}
    </div>
  );

  return (
    <div className="role-config-editor">
      <div className="role-config-header">
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
          <div className="role-config-section-title"><span>01</span><strong>执行与凭据</strong></div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Agent CLI</label>
              <select value={form.agent_cli} onChange={(e) => setForm({ ...form, agent_cli: e.target.value })} className={inputCls}>
                <option value="claude-code">claude-code</option><option value="open-code">open-code</option><option value="codex">codex</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>模型 ID（空=默认）</label>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className={inputCls}
                placeholder="如 claude-sonnet-4-5 / gpt-5 / k3"
                spellCheck={false}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>思考强度（reasoning effort）</label>
            <select
              value={form.reasoning}
              onChange={(e) => setForm({ ...form, reasoning: e.target.value as ReasoningForm })}
              className={inputCls}
            >
              <option value="">默认（由模型/CLI 决定）</option>
              <option value="low">low — 轻量，省 token</option>
              <option value="medium">medium — 均衡</option>
              <option value="high">high — 深入推理</option>
              <option value="xhigh">xhigh — 最强（慢/贵）</option>
            </select>
            <p className="mt-1 text-[10px] leading-5 text-zinc-600">
              写入 job 快照后下一任务生效；部分模型/中转可能忽略该参数。
            </p>
          </div>
          <div>
            <label className={labelCls}>LLM Credential</label>
            <CredentialPicker credentials={credentials} value={form.credential_id} onChange={(credential_id) => setForm({ ...form, credential_id })} />
            <p className="mt-1.5 text-[10px] leading-5 text-zinc-600">单次运行绑定一个 LLM 凭据；可按名称、Provider 或尾号搜索。</p>
          </div>
          {form.credential_id === "" && <div><label className={labelCls}>调度器环境变量引用</label><input value={form.env_keys} onChange={(e) => setForm({ ...form, env_keys: e.target.value })} className={inputCls} placeholder="逗号分隔变量名，值取调度器环境" /></div>}
          <div>
            <label className={labelCls}>非敏感环境变量</label>
            <div className="flex flex-col gap-1.5">
              {form.env_pairs.map((p, i) => <div key={i} className="flex items-center gap-1.5"><input value={p.key} onChange={(e) => setPair(i, { key: e.target.value })} className={`${inputCls} flex-1`} placeholder="变量名（如 LOG_LEVEL）" spellCheck={false} /><input value={p.value} onChange={(e) => setPair(i, { value: e.target.value })} className={`${inputCls} flex-[1.4]`} placeholder="值" spellCheck={false} /><button onClick={() => setForm((f) => ({ ...f, env_pairs: f.env_pairs.filter((_, idx) => idx !== i) }))} aria-label="删除该行" className="shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-950/40 hover:text-red-300"><Trash size={13} /></button></div>)}
              <button onClick={() => setForm((f) => ({ ...f, env_pairs: [...f.env_pairs, { key: "", value: "" }] }))} className="flex w-fit items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 hover:border-ink-600 hover:text-zinc-200"><Plus size={11} /> 添加变量</button>
            </div>
            <div className="mt-1 text-[11px] leading-5 text-zinc-600">敏感值必须使用 Credential，疑似密钥名会被后端拒绝。</div>
          </div>
          <div>
            <label className={labelCls}>Worker 长期指令</label>
            <textarea value={form.instructions_markdown} onChange={(e) => setForm({ ...form, instructions_markdown: e.target.value })} rows={10} className={`${inputCls} resize-y`} placeholder="每个 Job 会冻结并生成 /workspace/AGENTS.md 与 /workspace/CLAUDE.md；不要在这里填写某一次任务内容。" />
            <p className="mt-1 text-[10px] leading-5 text-zinc-600">
              平台会自动补充工作区、prompt 输入、runtime-manifest、动态 skill / command / MCP / sub-agent、环境变量名称、网络边界、不可用内部接口和增量结果工具；这里仅维护该角色长期稳定的职责与方法。
            </p>
          </div>
        </section>

        <section className="role-config-section role-config-modules">
          <div className="role-config-section-title"><span>02</span><strong>Agent 模块目录</strong></div>
          <ModulePicker sources={sources} sourceDetails={sourceDetails} selected={form.modules} onChange={(modules) => setForm({ ...form, modules })} />
          <p className="text-[11px] leading-5 text-zinc-600">目录由「模块源」同步生成。支持跨源搜索、来源过滤、批量勾选和已选项快速移除。</p>
        </section>
      </div>

      <details className="role-config-advanced">
        <summary><span><strong>高级运行声明</strong><small>JSON 模块、MCP、子 Agent、运行镜像与 Provider 配置</small></span><CaretDown size={14} /></summary>
        <div className="role-config-advanced-grid">
          {jsonField("skills（模块勾选优先）", "skills", '[{"name":"x","repo":"https://…"}] 或 embedded source')}
          {jsonField("commands（slash 命令）", "commands")}
          {jsonField("mcps（MCP server）", "mcps", '[{"name":"fs","type":"local","command":"npx","args":[…]}]')}
          {jsonField("subagents（子 Agent）", "subagents")}
          <div><label className={labelCls}>可信运行镜像 key</label><input value={form.runtime_image_key} onChange={(e) => setForm({ ...form, runtime_image_key: e.target.value })} className={inputCls} placeholder="留空使用默认可信镜像" spellCheck={false} /></div>
          <div className="role-config-provider"><label className={labelCls}>Provider 配置文件（<span className="text-zinc-300">{CONFIG_FILE_PATHS[form.agent_cli]}</span>）</label><textarea value={form.config_content} onChange={(e) => setForm({ ...form, config_content: e.target.value })} rows={4} spellCheck={false} className={`${inputCls} resize-y leading-relaxed`} placeholder={form.agent_cli === "codex" ? "# TOML 配置内容" : "{ …JSON 配置内容… }"} /><div className="mt-1 text-[11px] leading-5 text-zinc-600">配置命中密钥特征会被拒绝，请改用 Credential。</div></div>
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
