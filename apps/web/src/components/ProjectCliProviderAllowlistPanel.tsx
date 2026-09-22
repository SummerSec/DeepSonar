import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type ProviderCredential } from "../api";
import {
  credentialCatalogHealthSummary,
  modelCatalogHealthLabel,
  modelDescriptorsForCredential,
} from "../model-catalog-health";
import { HelpTip } from "../ui";
import { showToast } from "../toast";

const AGENT_CLIS = ["claude-code", "pi", "dsh"] as const;
type AgentCli = (typeof AGENT_CLIS)[number];
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
  onSaved,
}: {
  projectId: string;
  credentials: ProviderCredential[];
  enabledAgentClis: AgentCli[];
  enabledCredentialIds: string[];
  onSaved: () => void;
}) {
  const [clis, setClis] = useState<AgentCli[]>(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
  const [credIds, setCredIds] = useState<string[]>(enabledCredentialIds);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [probeAction, setProbeAction] = useState<{ id: string; kind: "test" | "models" } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    setClis(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
    setCredIds(enabledCredentialIds);
  }, [enabledAgentClis, enabledCredentialIds]);

  const llmCredentials = useMemo(
    () => credentials.filter((c) => c.kind === "llm_provider" && (c.project_id == null || c.project_id === projectId)),
    [credentials, projectId],
  );

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
          setProbeError(`${credential.name || credential.provider}：上游模型目录为空（仅诊断）。选模请用账号已填写的模型 id；未填写时请先在 Provider 账号配置中补齐。`);
        } else {
          showToast(`${credential.name || credential.provider}：上游探测到 ${result.models.length} 个模型（仅诊断，非选模名单）`, "ok");
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
        return current.filter((item) => item !== cli);
      }
      return [...current, cli];
    });
  };

  const toggleCred = (id: string) => {
    setCredIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const save = async () => {
    if (clis.length === 0) {
      showToast("至少启用一种 Agent CLI", "error");
      return;
    }
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await api.patchSettings(projectId, {
        enabled_agent_clis: clis,
        enabled_credential_ids: credIds,
        // Soft defaults removed from project settings UI; clear so Hub / RoleConfig own selection.
        default_agent_cli: null,
        default_credential_id: null,
        default_model_ref: null,
        fallback_model_refs: [],
        allow_model_catalog_passthrough: false,
      });
      showToast("已保存，下一 Job 生效", "ok");
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
          <span>CLI / Provider 启用</span>
          <HelpTip>
            启用边界；Hub 从已启用项组合 CLI×Provider×镜像。模型 / CLI 选择由 Hub 与 RoleConfig 负责；并发在凭据页。
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
            <div className="mt-2 text-[12px] text-amber-400/90">请至少启用一种 CLI。</div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[12px] text-zinc-400">启用 Provider 账号</div>
          {filteredByCli.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
              暂无兼容的 LLM Provider，请先在「凭据」页配置。
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
            <div className="mt-2 text-[12px] text-amber-400/90">请至少启用一个 Provider。</div>
          )}
        </div>

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : saved ? "已保存" : failed ? "保存失败" : "保存"}
        </button>
      </div>
    </section>
  );
}
