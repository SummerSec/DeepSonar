import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type ProviderCredential } from "../api";
import {
  credentialCatalogHealthSummary,
  modelCatalogHealthLabel,
  modelDescriptorsForCredential,
} from "../model-catalog-health";
import { SearchableMultiSelect, SearchableSelect } from "../SearchableSelect";
import { HelpTip } from "../ui";
import { showToast } from "../toast";

const AGENT_CLIS = ["claude-code", "pi", "dsh"] as const;
type AgentCli = (typeof AGENT_CLIS)[number];
const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const ADAPTER_CLIS: Record<string, AgentCli[]> = {
  anthropic: ["claude-code", "pi", "dsh"],
  openai: ["pi", "dsh"],
};

/** @deprecated Prefer modelCatalogHealthLabel from model-catalog-health. */
export function modelHealthLabel(status: string | null | undefined): string {
  return modelCatalogHealthLabel(status);
}

export { modelDescriptorsForCredential };

/**
 * Compatibility is an adapter/catalog capability.  `credential.agent_cli` is
 * only a profile hint and must never decide whether an account can be used by
 * a CLI (editing that hint must not mutate the capability matrix).
 */
export function compatibleAgentClisForCredential(credential: ProviderCredential): AgentCli[] {
  const descriptors = modelDescriptorsForCredential(credential);
  const descriptorClis = descriptors.flatMap((model) => model.compatible_agent_clis).filter(
    (cli): cli is AgentCli => AGENT_CLIS.includes(cli as AgentCli),
  );
  const adapterClis = credential.adapter?.compatible_agent_clis ?? ADAPTER_CLIS[credential.provider] ?? [];
  const candidates = descriptorClis.length > 0 ? descriptorClis : adapterClis;
  return [...new Set(candidates.filter((cli): cli is AgentCli => AGENT_CLIS.includes(cli as AgentCli)))];
}

export function credentialSupportsCli(credential: ProviderCredential, cli: AgentCli): boolean {
  return compatibleAgentClisForCredential(credential).includes(cli);
}

export function credentialCatalogState(credential: ProviderCredential): string {
  return credentialCatalogHealthSummary(credential);
}

export function credentialHealthMessage(credential: ProviderCredential): string {
  if (credential.provider_valid === false) return "Provider 映射待修复";
  if (credential.status !== "active") return `账号状态：${credential.status}`;
  if (credential.health?.status === "error") {
    const detail = credential.health.detail?.trim();
    return `连接 / 目录失败${credential.health.error_category ? `（${credential.health.error_category}）` : ""}${detail ? `：${detail}` : ""}`;
  }
  if (credential.health?.status === "ok") return "最近一次连接测试成功";
  return "尚未完成连接测试";
}

function concurrencySummary(credential: ProviderCredential): string {
  const meta = (credential.public_metadata_json ?? {}) as Record<string, unknown>;
  const max = typeof meta.max_concurrent === "number" ? meta.max_concurrent : null;
  const models = meta.model_concurrency && typeof meta.model_concurrency === "object" && !Array.isArray(meta.model_concurrency)
    ? Object.keys(meta.model_concurrency as Record<string, unknown>).length
    : 0;
  const parts: string[] = [];
  if (max !== null) parts.push(`账号并发 ${max}`);
  if (models > 0) parts.push(`模型并发 ${models} 项`);
  return parts.length > 0 ? parts.join(" · ") : "并发未单独限额（见凭据页）";
}

function compatibleClis(credential: ProviderCredential): string {
  const clis = compatibleAgentClisForCredential(credential);
  return clis.length > 0 ? clis.join(" / ") : "无已注册 CLI 兼容能力";
}

function modelSummary(credential: ProviderCredential): string {
  const models = modelDescriptorsForCredential(credential);
  if (models.length === 0) return "模型目录未探测";
  const names = models.slice(0, 3).map((model) => model.display_name || model.model_id).join("、");
  const passthrough = models.some((model) => model.health_status === "passthrough_allowed") ? " · 应急透传" : "";
  const toolCount = models.filter((model) => model.supports_tools).length;
  const streamCount = models.filter((model) => model.supports_streaming).length;
  const structuredCount = models.filter((model) => model.supports_structured_output).length;
  return `模型 ${names}${models.length > 3 ? ` 等 ${models.length} 个` : ""} · 能力 tools ${toolCount}/${models.length} · stream ${streamCount}/${models.length} · structured ${structuredCount}/${models.length}${passthrough}`;
}

export function ProjectCliProviderAllowlistPanel({
  projectId,
  credentials,
  enabledAgentClis,
  enabledCredentialIds,
  defaultAgentCli,
  defaultCredentialId,
  defaultModelRef,
  fallbackModelRefs,
  allowModelCatalogPassthrough,
  onSaved,
}: {
  projectId: string;
  credentials: ProviderCredential[];
  enabledAgentClis: AgentCli[];
  enabledCredentialIds: string[];
  defaultAgentCli: AgentCli | null;
  defaultCredentialId: string | null;
  defaultModelRef: string | null;
  fallbackModelRefs: string[];
  allowModelCatalogPassthrough: boolean;
  onSaved: () => void;
}) {
  const [clis, setClis] = useState<AgentCli[]>(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
  const [credIds, setCredIds] = useState<string[]>(enabledCredentialIds);
  const [defaultCli, setDefaultCli] = useState<AgentCli | "">(defaultAgentCli ?? "");
  const [defaultCred, setDefaultCred] = useState<string>(defaultCredentialId ?? "");
  const [defaultModel, setDefaultModel] = useState<string>(defaultModelRef ?? "");
  const [fallbackModels, setFallbackModels] = useState<string[]>(fallbackModelRefs);
  const [allowPassthrough, setAllowPassthrough] = useState(allowModelCatalogPassthrough);
  const [fallbackDraft, setFallbackDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [probeAction, setProbeAction] = useState<{ id: string; kind: "test" | "models" } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    setClis(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
    setCredIds(enabledCredentialIds);
    setDefaultCli(defaultAgentCli ?? "");
    setDefaultCred(defaultCredentialId ?? "");
    setDefaultModel(defaultModelRef ?? "");
    setFallbackModels(fallbackModelRefs);
    setAllowPassthrough(allowModelCatalogPassthrough);
  }, [
    enabledAgentClis,
    enabledCredentialIds,
    defaultAgentCli,
    defaultCredentialId,
    defaultModelRef,
    fallbackModelRefs,
    allowModelCatalogPassthrough,
  ]);

  const llmCredentials = useMemo(
    () => credentials.filter((c) => c.kind === "llm_provider" && (c.project_id == null || c.project_id === projectId)),
    [credentials, projectId],
  );

  const selectedDefaultCredential = useMemo(
    () => llmCredentials.find((credential) => credential.id === defaultCred) ?? null,
    [llmCredentials, defaultCred],
  );

  const fallbackModelOptions = useMemo(() => {
    const descriptors = modelDescriptorsForCredential(selectedDefaultCredential);
    const catalogOptions = descriptors.map((model) => ({
      value: model.model_id,
      label: `${model.display_name} · ${model.model_id}`,
      hint: `${modelHealthLabel(model.health_status)} · CLI ${model.compatible_agent_clis.join(" / ") || "按 adapter"}`,
    }));
    const known = new Set(catalogOptions.map((option) => option.value));
    return [
      ...catalogOptions,
      ...fallbackModels
        .filter((model) => !known.has(model))
        .map((model) => ({ value: model, label: model, hint: "当前不在已验证目录；需开启项目直通" })),
    ];
  }, [selectedDefaultCredential, fallbackModels]);

  const filteredByCli = useMemo(() => {
    if (clis.length === 0) return [];
    return llmCredentials.filter((credential) => clis.some((cli) => credentialSupportsCli(credential, cli)));
  }, [llmCredentials, clis]);

  const probeCredential = async (credential: ProviderCredential, kind: "test" | "models") => {
    setProbeAction({ id: credential.id, kind });
    setProbeError(null);
    try {
      if (kind === "test") {
        const result = await api.testCredential(credential.id);
        if (!result.ok) {
          setProbeError(`${credential.name || credential.provider}：连接测试失败${result.category ? `（${result.category}）` : ""}${result.detail ? `：${result.detail}` : ""}`);
        } else {
          showToast(`${credential.name || credential.provider}：连接测试成功`, "ok");
        }
      } else {
        const result = await api.credentialModels(credential.id);
        if (result.models.length === 0) {
          setProbeError(`${credential.name || credential.provider}：模型目录为空。可继续使用 RoleConfig / alias，但目录内模型会 fail-closed。`);
        } else {
          showToast(`${credential.name || credential.provider}：已发现 ${result.models.length} 个模型`, "ok");
        }
      }
      onSaved();
    } catch (error) {
      setProbeError(`${credential.name || credential.provider}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProbeAction(null);
    }
  };

  const toggleCli = (cli: AgentCli) => {
    setClis((current) => {
      if (current.includes(cli)) {
        if (current.length === 1) return current;
        const next = current.filter((item) => item !== cli);
        if (defaultCli === cli) setDefaultCli("");
        return next;
      }
      return [...current, cli];
    });
  };

  const toggleCred = (id: string) => {
    setCredIds((current) => {
      if (current.includes(id)) {
        const next = current.filter((item) => item !== id);
        if (defaultCred === id) {
          setDefaultCred("");
          setDefaultModel("");
          setFallbackModels([]);
        }
        return next;
      }
      return [...current, id];
    });
  };

  const save = async () => {
    if (clis.length === 0) {
      showToast("至少启用一种 Agent CLI", "error");
      return;
    }
    if (defaultCli && !clis.includes(defaultCli)) {
      showToast("缺省 CLI 必须属于已启用白名单", "error");
      return;
    }
    if (defaultCred && !credIds.includes(defaultCred)) {
      showToast("缺省 Provider 必须属于已启用白名单", "error");
      return;
    }
    const selectedCredential = selectedDefaultCredential;
    if (defaultModel && !selectedCredential) {
      showToast("缺省模型必须随缺省 Provider 一起选择", "error");
      return;
    }
    if (fallbackModels.length > 0 && !selectedCredential) {
      showToast("fallback 模型必须随缺省 Provider 一起选择", "error");
      return;
    }
    if (defaultCli && selectedCredential && !credentialSupportsCli(selectedCredential, defaultCli)) {
      showToast("缺省 Provider 没有该 Agent CLI 的模型 / adapter 兼容能力", "error");
      return;
    }
    const modelIds = new Set(modelDescriptorsForCredential(selectedCredential).map((model) => model.model_id));
    if (defaultModel && !allowPassthrough && !modelIds.has(defaultModel)) {
      showToast("缺省模型必须来自所选 Provider 的模型目录", "error");
      return;
    }
    const unknownFallback = fallbackModels.find((model) => !modelIds.has(model));
    if (unknownFallback && !allowPassthrough) {
      showToast(`fallback 模型 ${unknownFallback} 不在目录中；请先开启项目模型直通`, "error");
      return;
    }
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await api.patchSettings(projectId, {
        enabled_agent_clis: clis,
        enabled_credential_ids: credIds,
        default_agent_cli: defaultCli || null,
        default_credential_id: defaultCred || null,
        default_model_ref: defaultModel || null,
        fallback_model_refs: fallbackModels,
        allow_model_catalog_passthrough: allowPassthrough,
      });
      showToast("CLI / Provider 启用与缺省已保存（下一 job 生效）", "ok");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (error) {
      setFailed(true);
      showToast(`保存失败：${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>CLI / Provider 启用与缺省</span>
          <HelpTip>
            平台只划定启用边界与配额；Hub 运行时从已启用且就绪的目录中自由组合 CLI×Provider×镜像。
            此处缺省是软回退（Hub 省略时使用），不是按角色锁死身份。并发表在 Provider / 凭据上配置。
          </HelpTip>
        </div>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div>
          <div className="mb-2 text-[12px] text-zinc-400">启用 Agent 类型</div>
          <div className="flex flex-wrap gap-2">
            {AGENT_CLIS.map((cli) => {
              const on = clis.includes(cli);
              return (
                <label
                  key={cli}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${
                    on ? "border-acc-400/50 bg-acc-400/[.06] text-zinc-100" : "border-ink-700 text-zinc-400"
                  }`}
                >
                  <input type="checkbox" checked={on} onChange={() => toggleCli(cli)} className="accent-emerald-500" />
                  <span className="font-mono">{cli}</span>
                </label>
              );
            })}
          </div>
          {clis.length === 0 && (
            <div className="mt-2 text-[12px] text-amber-400/90">未启用任何 CLI 时无法派发；请至少勾选一种。</div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[12px] text-zinc-400">启用 Provider 账号</div>
          {filteredByCli.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
              暂无与已启用 CLI 兼容的 LLM Provider。请先在「凭据」页创建或修复账号，再回到此处启用。
            </div>
          ) : (
            <div className="space-y-2">
              {filteredByCli.map((credential) => {
                const on = credIds.includes(credential.id);
                const action = probeAction?.id === credential.id ? probeAction.kind : null;
                return (
                  <div
                    key={credential.id}
                    className={`rounded-md border px-3 py-2 ${
                      on ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                        <input type="checkbox" checked={on} onChange={() => toggleCred(credential.id)} className="mt-1 accent-emerald-500" />
                        <span className="min-w-0 flex-1">
                          <strong className="block text-[13px] text-zinc-200">
                            {credential.name || "未命名"} · {credential.provider}
                          </strong>
                          <small className="block font-mono text-[11px] leading-5 text-zinc-500">
                            #{credential.id.slice(0, 8)} · 兼容 {compatibleClis(credential)} · {concurrencySummary(credential)}
                            {` · ${modelSummary(credential)}`}
                            {credential.status !== "active" ? ` · 状态 ${credential.status}` : ""}
                          </small>
                          <small className="mt-0.5 block text-[11px] leading-5 text-zinc-500">{credentialCatalogState(credential)} · {credentialHealthMessage(credential)}</small>
                        </span>
                      </label>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          className="rounded border border-ink-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-acc-400/40 hover:text-acc-300 disabled:opacity-50"
                          disabled={probeAction !== null || busy}
                          onClick={() => void probeCredential(credential, "test")}
                        >
                          {action === "test" ? "测试中…" : "测试"}
                        </button>
                        <button
                          type="button"
                          className="rounded border border-ink-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-acc-400/40 hover:text-acc-300 disabled:opacity-50"
                          disabled={probeAction !== null || busy}
                          onClick={() => void probeCredential(credential, "models")}
                        >
                          {action === "models" ? "刷新中…" : "目录"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {probeError && <div role="alert" className="mt-2 rounded-md border border-red-400/20 bg-red-400/[.06] px-3 py-2 text-[11px] leading-5 text-red-200">{probeError}</div>}
          {credIds.length === 0 && (
            <div className="mt-2 text-[12px] text-amber-400/90">
              未启用任何 Provider 时 Hub 无法提案账号；非 Hub 路径仍可回退 RoleConfig 绑定（若已在白名单）。
            </div>
          )}
          <div className="mt-2 rounded-md border border-ink-700/80 bg-ink-900/30 px-3 py-2 text-[11px] leading-5 text-zinc-500">
            模型目录直通（alias）同时受项目与角色 opt-in 控制；本页展示 Provider 的目录健康与
            <code className="mx-1 text-zinc-400">passthrough_allowed</code> 状态，不会通过修改 Credential CLI 提示来绕过能力校验。
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">缺省 Agent CLI（软回退）</div>
            <SearchableSelect
              value={defaultCli}
              onChange={(next) => setDefaultCli((next as AgentCli | "") || "")}
              options={[
                { value: "", label: "不设缺省（回退 RoleConfig）" },
                ...clis.map((cli) => ({ value: cli, label: cli })),
              ]}
              placeholder="选择缺省 CLI"
              ariaLabel="缺省 Agent CLI"
              className="searchable-select-wrap"
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">缺省 Provider（软回退）</div>
            <SearchableSelect
              value={defaultCred}
              onChange={(next) => {
                setDefaultCred(next || "");
                if (next !== defaultCred) {
                  setDefaultModel("");
                  setFallbackModels([]);
                }
              }}
              options={[
                { value: "", label: "不设缺省（回退 RoleConfig）" },
                ...llmCredentials
                  .filter((c) => credIds.includes(c.id))
                  .map((c) => ({
                    value: c.id,
                    label: `${c.name || "未命名"} · ${c.provider} #${c.id.slice(0, 8)}`,
                  })),
              ]}
              placeholder="选择缺省 Provider"
              ariaLabel="缺省 Provider"
              className="searchable-select-wrap"
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">缺省模型（随 Provider 冻结）</div>
            <SearchableSelect
              value={defaultModel}
              onChange={(next) => setDefaultModel(next || "")}
              options={[
                { value: "", label: "不设缺省（由 RoleConfig / Hub 选择）" },
                ...modelDescriptorsForCredential(llmCredentials.find((credential) => credential.id === defaultCred)).map((model) => ({
                  value: model.model_id,
                  label: `${model.display_name} · ${model.model_id}`,
                  hint: `${modelHealthLabel(model.health_status)} · CLI ${model.compatible_agent_clis.join(" / ") || "按 adapter"}`,
                })),
              ]}
              placeholder="选择缺省模型"
              ariaLabel="缺省模型"
              className="searchable-select-wrap"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">项目级 fallback 模型顺序</div>
            <SearchableMultiSelect
              value={fallbackModels}
              onChange={setFallbackModels}
              options={fallbackModelOptions}
              placeholder="选择目录中的 fallback 模型"
              ariaLabel="项目级 fallback 模型"
              className="block [&>button]:w-full"
              emptyText="请先选择缺省 Provider 或刷新模型目录"
            />
            <div className="mt-1 text-[11px] leading-5 text-zinc-600">仅在 Hub 未显式指定模型、或冻结模型不可用时按顺序尝试；fallback 与缺省模型使用同一 Provider。</div>
            <div className="mt-2 flex gap-2">
              <input
                value={fallbackDraft}
                onChange={(event) => setFallbackDraft(event.target.value)}
                placeholder="添加 alias / 自定义模型引用"
                aria-label="添加 fallback 模型引用"
                className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-acc-400/40"
              />
              <button
                type="button"
                className="rounded-md border border-ink-700 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:border-acc-400/40 hover:text-acc-300"
                onClick={() => {
                  const ref = fallbackDraft.trim();
                  if (!MODEL_REF_PATTERN.test(ref)) {
                    showToast("fallback 模型引用格式非法", "error");
                    return;
                  }
                  setFallbackModels((current) => current.includes(ref) ? current : [...current, ref]);
                  setFallbackDraft("");
                }}
              >
                添加
              </button>
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink-700/80 bg-ink-900/30 px-3 py-3 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5 accent-emerald-500"
              checked={allowPassthrough}
              onChange={(event) => setAllowPassthrough(event.target.checked)}
              aria-label="项目允许模型目录直通"
            />
            <span>
              项目允许模型目录直通（应急 alias，默认关闭）
              <span className="mt-0.5 block text-[11px] leading-5 text-zinc-500">
                默认关闭：缺省 / fallback 必须是 Provider 目录内的 catalog model_id（#632 SSOT）。
                仅 alias 网关应急时开启；关闭时模型选择 fail-closed，失败返回结构化 RepairFeedback。
              </span>
            </span>
          </label>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : saved ? "已保存" : failed ? "保存失败" : "保存启用与缺省"}
        </button>
        <div className="font-mono text-[10px] leading-5 text-zinc-600">
          解析顺序：Hub 提案 → 项目缺省 CLI / Provider / 模型（推荐）→ RoleConfig.credentials（已弃用，仍兼容）→ Provider / CLI 内置默认；修改仅影响下一 Job。
        </div>
      </div>
    </section>
  );
}
