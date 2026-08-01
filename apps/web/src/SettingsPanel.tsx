import { ArrowsClockwise, FloppyDisk, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  api,
  type AgentProfile,
  type EffectiveRules,
  type ProfileInput,
  type ProjectRole,
  type ProviderCredential,
  type ProjectSettings,
  type SkillSource,
  type SkillSourceDetail,
} from "./api";

import { TokensPanel } from "./TokensPanel";
import { CredentialsPanel } from "./CredentialsPanel";

/**
 * 设置面板（§8.1/§8.2/§8.3）：Agent 配置（profile CRUD + Git 模块勾选）+ 规则配置
 * + 角色（hub 可下发的 agent：启用勾选 + profile 绑定 + prompt 模板编辑）+ 模块源管理
 * 生效语义：下一 job 生效 —— job 创建时冻结快照，改配置不影响已建 job
 */

type Tab = "profiles" | "rules" | "roles" | "sources" | "plane" | "tokens" | "credentials";

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

function JsonField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        spellCheck={false}
        placeholder="[]"
        className={`${inputCls} resize-y`}
      />
      {hint && <div className="mt-0.5 text-[12px] text-zinc-600">{hint}</div>}
    </div>
  );
}

// ---------- profile 表单状态 ----------

interface ProfileForm {
  id: string | null;
  name: string;
  agent_cli: string;
  model: string;
  credential_id: string; // "" = 不绑定（退回 env_keys 过渡路径）
  env_keys: string; // 逗号分隔
  prompt_suffix: string;
  modules: string[]; // 勾选的 Git 模块（"<source_id>:<module_id>"）
  skills: string; // JSON 文本
  commands: string;
  mcps: string;
  subagents: string;
}

const EMPTY_FORM: ProfileForm = {
  id: null,
  name: "",
  agent_cli: "claude-code",
  model: "",
  credential_id: "",
  env_keys: "",
  prompt_suffix: "",
  modules: [],
  skills: "[]",
  commands: "[]",
  mcps: "[]",
  subagents: "[]",
};

function formOf(p: AgentProfile): ProfileForm {
  return {
    id: p.id,
    name: p.name,
    agent_cli: p.agent_cli,
    model: p.model ?? "",
    credential_id: p.credential_id ?? "",
    env_keys: p.env_keys.join(", "),
    prompt_suffix: p.prompt_suffix ?? "",
    modules: p.modules_json ?? [],
    skills: JSON.stringify(p.skills_json, null, 2),
    commands: JSON.stringify(p.commands_json, null, 2),
    mcps: JSON.stringify(p.mcps_json, null, 2),
    subagents: JSON.stringify(p.subagents_json, null, 2),
  };
}

function parseJsonArray(text: string): Record<string, unknown>[] {
  const v = JSON.parse(text || "[]") as unknown;
  if (!Array.isArray(v)) throw new Error("必须是 JSON 数组");
  return v as Record<string, unknown>[];
}

// ---------- 角色表单状态（§8.3） ----------

interface RoleForm {
  id: string | null;
  name: string;
  title: string;
  description: string;
  prompt_template: string;
  builtin: boolean;
}

const EMPTY_ROLE: RoleForm = {
  id: null,
  name: "",
  title: "",
  description: "",
  builtin: false,
  prompt_template: `你是{{role}} agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML，不要重复其中的事实）：
{{graph}}

要求：
1. 围绕意图工作，产出新事实写 /workspace/fact.json：{"title":"...","description":"..."}
2. 完成后写 /workspace/done.json：{"summary":"..."}
3. 文件必须是纯 JSON，不要用 markdown 代码围栏包裹`,
};

export function SettingsPanel({
  projectId,
  onClose,
  variant = "drawer",
}: {
  /** null = 全局 Agent 管理模式（无项目级绑定/规则/角色启用） */
  projectId: string | null;
  onClose?: () => void;
  /** drawer=浮层侧栏；page=独立设置页 */
  variant?: "drawer" | "page";
}) {
  const [tab, setTab] = useState<Tab>("profiles");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [rules, setRules] = useState<EffectiveRules | null>(null);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [sourceDetails, setSourceDetails] = useState<Record<string, SkillSourceDetail>>({});
  const [newSource, setNewSource] = useState({ name: "", repo_url: "", branch: "main" });
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [roleForm, setRoleForm] = useState<RoleForm>(EMPTY_ROLE);
  const [planeBind, setPlaneBind] = useState<string | null>(null);
  const [planeInput, setPlaneInput] = useState("");
  const [planeBusy, setPlaneBusy] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () => {
    api.agentProfiles().then(setProfiles).catch(() => {});
    if (projectId) {
      // 项目模式：角色带启用态 + profile 绑定
      api.projectRoles(projectId).then(setRoles).catch(() => {});
      api
        .projects()
        .then((list) => setPlaneBind(list.find((p) => p.id === projectId)?.plane_project_id ?? null))
        .catch(() => {});
      api
        .settings(projectId)
        .then((s) => {
          setSettings(s);
          setRules(s.effective_rules);
          setBindings(s.profiles);
        })
        .catch(() => {});
    } else {
      // 全局模式：纯角色注册表（无启用态/绑定）+ 全局规则默认值
      api
        .agentRoles()
        .then((list) =>
          setRoles(
            list.map((r) => ({ ...r, enabled: false, default_enabled: false, profile_id: null })),
          ),
        )
        .catch(() => {});
      api
        .globalSettings()
        .then((g) => setRules(g.effective_rules))
        .catch(() => {});
    }
    api
      .credentials()
      .then(setCredentials)
      .catch(() => {});
    api
      .skillSources()
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
  useEffect(reload, [projectId]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const saveProfile = async () => {
    try {
      const body: ProfileInput = {
        name: form.name.trim(),
        agent_cli: form.agent_cli,
        model: form.model.trim() || null,
        credential_id: form.credential_id || null,
        env_keys: form.env_keys.split(",").map((s) => s.trim()).filter(Boolean),
        prompt_suffix: form.prompt_suffix.trim() || null,
        modules: form.modules,
        skills: parseJsonArray(form.skills),
        commands: parseJsonArray(form.commands),
        mcps: parseJsonArray(form.mcps),
        subagents: parseJsonArray(form.subagents),
      };
      if (!body.name) return flash("名称必填");
      if (form.id) await api.updateProfile(form.id, body);
      else await api.createProfile(body);
      flash(form.id ? "已保存（下一 job 生效）" : "已创建");
      setForm(EMPTY_FORM);
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const saveRules = async () => {
    if (!rules) return;
    const ruleBody = {
      autoVerifySeverities: rules.autoVerifySeverities,
      maxFollowupsPerJob: rules.maxFollowupsPerJob,
      maxFollowupDepth: rules.maxFollowupDepth,
      maxAutoRetries: rules.maxAutoRetries,
      auditTimeoutSec: rules.auditTimeoutSec,
      verifyTimeoutSec: rules.verifyTimeoutSec,
      hubEnabled: rules.hubEnabled,
      maxHubRounds: rules.maxHubRounds,
      maxIntentsPerDecision: rules.maxIntentsPerDecision,
    };
    try {
      if (projectId) {
        await api.patchSettings(projectId, {
          profiles: {
            audit_module: bindings.audit_module || null,
            verify_finding: bindings.verify_finding || null,
            hub_reason: bindings.hub_reason || null,
            default: bindings.default || null,
          },
          rules: ruleBody,
        });
      } else {
        // 全局模式：写入 global_settings（项目未覆盖时的默认值）
        await api.patchGlobalSettings({ rules: ruleBody });
      }
      flash("规则已保存（下一 job 生效）");
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  // ---------- 角色（hub 可下发清单 + 模板编辑） ----------

  /** 勾选启用：立即保存整个 enabled 清单（首次勾选后从默认模式转为显式清单） */
  const toggleRole = async (role: ProjectRole) => {
    if (!projectId) return;
    const next = roles.filter((r) => (r.name === role.name ? !r.enabled : r.enabled)).filter((r) => r.enabled);
    try {
      await api.patchSettings(projectId, { roles: { enabled: next.map((r) => r.name) } });
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  /** 角色绑定 profile：立即保存（null = 解绑，回落 default 绑定） */
  const bindRoleProfile = async (roleName: string, profileId: string) => {
    if (!projectId) return;
    try {
      await api.patchSettings(projectId, { profiles: { [roleName]: profileId || null } });
      flash("已绑定（下一 job 生效）");
      reload();
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const saveRole = async () => {
    try {
      const body = {
        title: roleForm.title.trim(),
        description: roleForm.description.trim(),
        prompt_template: roleForm.prompt_template,
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

  const bindSelect = (key: string, label: string) => (
    <div key={key}>
      <label className={labelCls}>{label}</label>
      <select
        value={bindings[key] ?? ""}
        onChange={(e) => setBindings((b) => ({ ...b, [key]: e.target.value }))}
        className={inputCls}
      >
        <option value="">（不绑定）</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );

  const toggleModule = (moduleKey: string) =>
    setForm((f) => ({
      ...f,
      modules: f.modules.includes(moduleKey)
        ? f.modules.filter((m) => m !== moduleKey)
        : [...f.modules, moduleKey],
    }));

  /** 模块勾选列表：按源 → 插件分组 */
  const modulePicker = (
    <div>
      <label className={labelCls}>Git 模块（勾选下发到 agent；在「模块源」tab 管理仓库）</label>
      {sources.length === 0 && (
        <div className="font-mono text-[13px] text-zinc-600">暂无模块源 —— 先到「模块源」tab 添加 Git 仓库并同步</div>
      )}
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border border-ink-800 bg-ink-900/60 p-2">
        {sources.map((s) => {
          const detail = sourceDetails[s.id];
          const mods = detail?.catalog_json ?? [];
          if (mods.length === 0) return null;
          const byPlugin = new Map<string, typeof mods>();
          for (const m of mods) {
            const list = byPlugin.get(m.plugin) ?? [];
            list.push(m);
            byPlugin.set(m.plugin, list);
          }
          return (
            <div key={s.id}>
              <div className="mb-1 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                {s.name}
              </div>
              {[...byPlugin.entries()].map(([plugin, list]) => (
                <div key={plugin} className="mb-1.5">
                  <div className="font-mono text-[12px] text-zinc-600">{plugin}</div>
                  {list.map((m) => {
                    const key = `${s.id}:${m.id}`;
                    const checked = form.modules.includes(key);
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-ink-850"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleModule(key)}
                          className="accent-emerald-500"
                        />
                        <span className="text-[14px] text-zinc-200">{m.name}</span>
                        <span className={`font-mono text-[11px] uppercase ${m.kind === "skill" ? "text-acc-400" : "text-run-400"}`}>
                          {m.kind}
                        </span>
                        {m.description && (
                          <span className="truncate text-[12px] text-zinc-600">{m.description}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {form.modules.length > 0 && (
        <div className="mt-0.5 font-mono text-[12px] text-acc-400">已勾选 {form.modules.length} 个模块</div>
      )}
    </div>
  );

  const numField = (key: keyof EffectiveRules, label: string) => (
    <div key={key}>
      <label className={labelCls}>{label}</label>
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

  const shellCls =
    variant === "page"
      ? "flex h-full w-full flex-col bg-ink-950"
      : "dfh-sidebar absolute inset-y-0 right-0 z-30 flex w-[440px] flex-col border-l border-ink-700 bg-ink-900/95 backdrop-blur";

  // 全局模式：profiles / 角色注册表 / 模块源 / 全局规则；项目模式：规则（绑定+覆盖）/ 角色启用 / Plane 集成
  const tabList: { key: Tab; label: string }[] = projectId
    ? [
        { key: "rules", label: "规则配置" },
        { key: "roles", label: "角色启用" },
        { key: "plane", label: "Plane 集成" },
      ]
    : [
        { key: "profiles", label: "Agent 配置" },
        { key: "roles", label: "角色注册表" },
        { key: "sources", label: "模块源" },
        { key: "rules", label: "全局规则" },
        { key: "credentials", label: "凭据" },
        { key: "tokens", label: "API Token" },
      ];
  const activeTab = tabList.some((t) => t.key === tab) ? tab : tabList[0].key;

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

      <div className={`flex gap-1 border-b border-ink-800 py-1.5 ${variant === "page" ? "px-6" : "px-3"}`}>
        {tabList.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-2.5 py-1 text-[14px] transition-colors ${
              activeTab === t.key ? "bg-ink-800 text-zinc-100" : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
        {msg && <span className="ml-auto self-center font-mono text-[12px] text-acc-400">{msg}</span>}
      </div>

      <div className={`flex-1 overflow-y-auto py-3 ${variant === "page" ? "px-6 max-w-3xl" : "px-4"}`}>
        {activeTab === "profiles" && (
          <>
            {/* 已有 profile 列表 */}
            <div className="mb-3 flex flex-col gap-1">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setForm(formOf(p))}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    form.id === p.id
                      ? "border-acc-500/70 bg-ink-850"
                      : "border-ink-700 bg-ink-850/60 hover:border-ink-600"
                  }`}
                >
                  <span className="text-[14px] font-medium text-zinc-100">{p.name}</span>
                  <span className="font-mono text-[12px] text-zinc-500">
                    {p.agent_cli}
                    {p.model ? ` · ${p.model}` : ""}
                  </span>
                  <span className="ml-auto font-mono text-[12px] text-zinc-600">
                    模块×{(p.modules_json ?? []).length} env×{p.env_keys.length} skill×{p.skills_json.length} mcp×{p.mcps_json.length}
                  </span>
                </button>
              ))}
              {profiles.length === 0 && (
                <div className="py-2 font-mono text-[13px] text-zinc-600">
                  暂无 profile —— 未绑定时所有 job 用 env 全局配置
                </div>
              )}
            </div>

            {/* 编辑表单 */}
            <div className="flex flex-col gap-2.5 border-t border-ink-800 pt-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  {form.id ? `编辑 ${form.name}` : "新建 profile"}
                </span>
                <button
                  onClick={() => setForm(EMPTY_FORM)}
                  className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 hover:border-ink-600 hover:text-zinc-200"
                >
                  <Plus size={11} /> 新建
                </button>
              </div>
              <div>
                <label className={labelCls}>名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="audit-kimi" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Agent CLI</label>
                  <select value={form.agent_cli} onChange={(e) => setForm({ ...form, agent_cli: e.target.value })} className={inputCls}>
                    <option value="claude-code">claude-code</option>
                    <option value="open-code">open-code</option>
                    <option value="codex">codex</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>模型（空=默认）</label>
                  <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputCls} placeholder="k3" />
                </div>
              </div>
              <div>
                <label className={labelCls}>Provider Credential（§6.2 推荐：加密登记的上游密钥）</label>
                <select
                  value={form.credential_id}
                  onChange={(e) => setForm({ ...form, credential_id: e.target.value })}
                  className={inputCls}
                >
                  <option value="">不绑定（退回 env 引用过渡路径）</option>
                  {credentials
                    .filter((c) => c.status === "active")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（{c.provider} …{c.last4}）
                      </option>
                    ))}
                </select>
              </div>
              {form.credential_id === "" && (
                <div>
                  <label className={labelCls}>env 引用（过渡路径，逗号分隔变量名，值取调度器环境）</label>
                  <input value={form.env_keys} onChange={(e) => setForm({ ...form, env_keys: e.target.value })} className={inputCls} />
                </div>
              )}
              <div>
                <label className={labelCls}>提示词后缀（追加到任务 prompt）</label>
                <textarea value={form.prompt_suffix} onChange={(e) => setForm({ ...form, prompt_suffix: e.target.value })} rows={2} className={`${inputCls} resize-y`} placeholder="例如：重点关注认证绕过与注入类漏洞" />
              </div>
              {modulePicker}
              <JsonField label="skills（手写 JSON，高级；模块勾选优先用上面）" value={form.skills} onChange={(v) => setForm({ ...form, skills: v })} hint='[{"name":"x","repo":"https://…"}] 或 {"source":"embedded","name":"x","files":{…}}' />
              <JsonField label="commands（JSON slash 命令）" value={form.commands} onChange={(v) => setForm({ ...form, commands: v })} />
              <JsonField label="mcps（JSON MCP server）" value={form.mcps} onChange={(v) => setForm({ ...form, mcps: v })} hint='[{"name":"fs","type":"local","command":"npx","args":[…]}]' />
              <JsonField label="subagents（JSON 子 agent）" value={form.subagents} onChange={(v) => setForm({ ...form, subagents: v })} />
              <div className="mt-1 flex gap-2">
                <button
                  onClick={saveProfile}
                  className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
                >
                  <FloppyDisk size={13} /> {form.id ? "保存" : "创建"}
                </button>
                {form.id && (
                  <button
                    onClick={async () => {
                      await api.deleteProfile(form.id!).catch(() => {});
                      setForm(EMPTY_FORM);
                      flash("已删除");
                      reload();
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-red-900/60 px-3 py-1.5 text-[14px] text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash size={13} /> 删除
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === "rules" && rules && (!projectId || settings) && (
          <div className="flex flex-col gap-4">
            {projectId && (
              <section>
                <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  profile 绑定（job 类型 → agent 配置）
                </div>
                <div className="flex flex-col gap-2">
                  {bindSelect("audit_module", "audit_module（审计）")}
                  {bindSelect("verify_finding", "verify_finding（验证）")}
                  {bindSelect("hub_reason", "hub_reason（决策中枢）")}
                  {bindSelect("default", "default（兜底）")}
                </div>
              </section>
            )}

            <section className={projectId ? "border-t border-ink-800 pt-3" : ""}>
              <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                hub 循环（图语义自驱，§8.3）
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rules.hubEnabled}
                  onChange={(e) => setRules({ ...rules, hubEnabled: e.target.checked })}
                  className="accent-emerald-500"
                />
                <span className="text-[14px] text-zinc-200">启用 hub 自驱循环（job 完成 → hub 读图决策 → 派发角色）</span>
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {numField("maxHubRounds", "hub 轮次上限")}
                {numField("maxIntentsPerDecision", "单次派发意图上限")}
              </div>
              <div className="mt-1 text-[12px] text-zinc-600">
                {projectId
                  ? "hub 可下发哪些角色、各角色用什么 agent 配置 → 「角色启用」tab；未覆盖的规则继承全局默认值"
                  : "全局默认值：项目规则未覆盖时生效（项目设置在项目页改）"}
              </div>
            </section>

            <section className="border-t border-ink-800 pt-3">
              <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                派生与重试规则
              </div>
              <div>
                <label className={labelCls}>自动验证 severity（逗号分隔）</label>
                <input
                  value={rules.autoVerifySeverities.join(",")}
                  onChange={(e) =>
                    setRules({ ...rules, autoVerifySeverities: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                  }
                  className={inputCls}
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {numField("maxFollowupsPerJob", "每 job followup 上限")}
                {numField("maxFollowupDepth", "followup 最大深度")}
                {numField("maxAutoRetries", "失败自动重试上限")}
                <div />
                {numField("auditTimeoutSec", "审计超时（秒）")}
                {numField("verifyTimeoutSec", "验证超时（秒）")}
              </div>
            </section>

            <button
              onClick={saveRules}
              className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
            >
              <FloppyDisk size={13} /> 保存规则
            </button>
          </div>
        )}

        {activeTab === "roles" && (
          <div className="flex flex-col gap-3">
            <div className="text-[13px] leading-relaxed text-zinc-500">
              {projectId ? (
                <>
                  角色 = hub 可下发的 agent 类型（job 完成 → hub 读图 → 按角色派发意图）。
                  这里只决定<strong className="text-zinc-300">本项目启用哪些角色、各角色绑定哪个 agent 配置</strong>；
                  角色与 prompt 模板的新建/编辑在全局「Agent 管理」页。
                </>
              ) : (
                <>
                  角色与 prompt 模板全局维护：kind=role 的角色注册后，各项目在「项目设置 → 角色启用」里勾选；
                  kind=system 的是调度内核 prompt（hub 决策 / 审计 / 验证）。点名称编辑模板。
                </>
              )}
            </div>

            {/* 全局模式：系统 prompt 模板区（hub_reason/audit_module/verify_finding） */}
            {!projectId && roles.some((r) => r.kind === "system") && (
              <>
                <div className="mt-1 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  系统 prompt 模板（调度内核）
                </div>
                <div className="flex flex-col gap-1.5">
                  {roles.filter((r) => r.kind === "system").map((r) => (
                    <div
                      key={r.id}
                      className={`rounded-lg border px-3 py-2.5 transition-colors ${
                        roleForm.id === r.id ? "border-acc-500/70 bg-ink-850" : "border-ink-700 bg-ink-850/60"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            setRoleForm({
                              id: r.id,
                              name: r.name,
                              title: r.title,
                              description: r.description,
                              prompt_template: r.prompt_template,
                              builtin: r.builtin,
                            })
                          }
                          className="flex items-center gap-1.5 text-left"
                        >
                          <span className="font-mono text-[14px] font-medium text-zinc-100">{r.name}</span>
                          <span className="text-[13px] text-zinc-500">{r.title}</span>
                          <PencilSimple size={12} className="text-zinc-600" />
                        </button>
                        <span className="rounded border border-ink-700 px-1 font-mono text-[11px] text-zinc-500">系统</span>
                      </div>
                      {r.description && (
                        <div className="mt-1 text-[12px] leading-relaxed text-zinc-600">{r.description}</div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* 角色清单：全局=注册表；项目=启用勾选 + profile 绑定 */}
            {!projectId && (
              <div className="mt-1 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                角色注册表（hub 可下发）
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {roles.filter((r) => (projectId ? true : r.kind !== "system")).map((r) => (
                <div
                  key={r.id}
                  className={`rounded-lg border px-3 py-2.5 transition-colors ${
                    roleForm.id === r.id ? "border-acc-500/70 bg-ink-850" : "border-ink-700 bg-ink-850/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {projectId && (
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={() => toggleRole(r)}
                        className="accent-emerald-500"
                        title="启用后 hub 可下发此角色"
                      />
                    )}
                    {projectId ? (
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[14px] font-medium text-zinc-100">{r.name}</span>
                        <span className="text-[13px] text-zinc-500">{r.title}</span>
                      </span>
                    ) : (
                      <button
                        onClick={() =>
                          setRoleForm({
                            id: r.id,
                            name: r.name,
                            title: r.title,
                            description: r.description,
                            prompt_template: r.prompt_template,
                            builtin: r.builtin,
                          })
                        }
                        className="flex items-center gap-1.5 text-left"
                      >
                        <span className="font-mono text-[14px] font-medium text-zinc-100">{r.name}</span>
                        <span className="text-[13px] text-zinc-500">{r.title}</span>
                        <PencilSimple size={12} className="text-zinc-600" />
                      </button>
                    )}
                    {r.builtin && (
                      <span className="rounded border border-ink-700 px-1 font-mono text-[11px] text-zinc-500">内置</span>
                    )}
                    {projectId && (
                      <select
                        value={r.profile_id ?? ""}
                        onChange={(e) => bindRoleProfile(r.name, e.target.value)}
                        className="ml-auto rounded-md border border-ink-700 bg-ink-850 px-2 py-1 font-mono text-[12px] text-zinc-300 outline-none focus:border-acc-500"
                        title="该角色 job 使用的 agent 配置（空 = 用 default 绑定）"
                      >
                        <option value="">（default 兜底）</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {r.description && (
                    <div className={`mt-1 text-[12px] leading-relaxed text-zinc-600 ${projectId ? "pl-6" : ""}`}>{r.description}</div>
                  )}
                </div>
              ))}
              {roles.filter((r) => (projectId ? true : r.kind !== "system")).length === 0 && (
                <div className="py-2 font-mono text-[13px] text-zinc-600">暂无角色 —— 重启调度器应用迁移 0006 后出现内置五角色</div>
              )}
            </div>

            {/* 角色/模板编辑表单：仅全局模式（项目设置只负责启用与绑定） */}
            {!projectId && (
            <div className="flex flex-col gap-2.5 border-t border-ink-800 pt-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  {roleForm.id ? `编辑 ${roleForm.name}` : "新建自定义角色"}
                </span>
                <button
                  onClick={() => setRoleForm(EMPTY_ROLE)}
                  className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 hover:border-ink-600 hover:text-zinc-200"
                >
                  <Plus size={11} /> 新建
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
                    className={inputCls}
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
              <div>
                <label className={labelCls}>
                  prompt 模板（占位符：
                  {roleForm.name === "hub_reason"
                    ? "{{graph}} 整图 / {{roles}} 角色清单 / {{max_intents}} 意图上限"
                    : roleForm.name === "audit_module"
                      ? "{{module_path}} 审计模块"
                      : roleForm.name === "verify_finding"
                        ? "{{finding_title}} / {{finding_location}} / {{finding_summary}}"
                        : "{{graph}} 整图 / {{intent}} 意图 / {{role}} 角色名"}
                  ）
                </label>
                <textarea
                  value={roleForm.prompt_template}
                  onChange={(e) => setRoleForm({ ...roleForm, prompt_template: e.target.value })}
                  rows={10}
                  spellCheck={false}
                  className={`${inputCls} resize-y leading-relaxed`}
                />
              </div>
              <div className="mt-1 flex gap-2">
                <button
                  onClick={saveRole}
                  className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
                >
                  <FloppyDisk size={13} /> {roleForm.id ? "保存" : "创建"}
                </button>
                {roleForm.id && !roleForm.builtin && (
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
            </div>
            )}
          </div>
        )}

        {activeTab === "plane" && projectId && (
          <div className="flex flex-col gap-3">
            <div className="text-[13px] leading-relaxed text-zinc-500">
              Plane 是可选的协作镜像：绑定后 Ready 状态的 issue（描述含 type= 标记）会被自动认领为任务；
              本地库才是唯一状态真相，Plane 故障不影响本地任务。解绑只停止后续同步，不删除已导入的任务。
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
            <div className="text-[13px] leading-relaxed text-zinc-500">
              Agent 的插件 / skill 集中托管在 Git 仓库（如{" "}
              <span className="font-mono text-zinc-400">SumSec-Skills</span>
              ）。同步后扫描出全部模块，在「Agent 配置」里按 profile 勾选下发；内容随同步缓存，跑任务不再访问 Git。
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
                placeholder="名称（如 sumsec-skills）"
              />
              <input
                value={newSource.repo_url}
                onChange={(e) => setNewSource({ ...newSource, repo_url: e.target.value })}
                className={inputCls}
                placeholder="https://github.com/SummerSec/SumSec-Skills"
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
                <Plus size={13} /> 添加
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
