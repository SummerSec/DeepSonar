import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type ProviderCredential } from "../api";
import { SearchableSelect } from "../SearchableSelect";
import { HelpTip } from "../ui";
import { showToast } from "../toast";

const AGENT_CLIS = ["claude-code", "pi", "dsh"] as const;
type AgentCli = (typeof AGENT_CLIS)[number];

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
  return credential.agent_cli ? String(credential.agent_cli) : "多 CLI";
}

export function ProjectCliProviderAllowlistPanel({
  projectId,
  credentials,
  enabledAgentClis,
  enabledCredentialIds,
  defaultAgentCli,
  defaultCredentialId,
  onSaved,
}: {
  projectId: string;
  credentials: ProviderCredential[];
  enabledAgentClis: AgentCli[];
  enabledCredentialIds: string[];
  defaultAgentCli: AgentCli | null;
  defaultCredentialId: string | null;
  onSaved: () => void;
}) {
  const [clis, setClis] = useState<AgentCli[]>(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
  const [credIds, setCredIds] = useState<string[]>(enabledCredentialIds);
  const [defaultCli, setDefaultCli] = useState<AgentCli | "">(defaultAgentCli ?? "");
  const [defaultCred, setDefaultCred] = useState<string>(defaultCredentialId ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setClis(enabledAgentClis.length ? enabledAgentClis : ["claude-code"]);
    setCredIds(enabledCredentialIds);
    setDefaultCli(defaultAgentCli ?? "");
    setDefaultCred(defaultCredentialId ?? "");
  }, [enabledAgentClis, enabledCredentialIds, defaultAgentCli, defaultCredentialId]);

  const llmCredentials = useMemo(
    () => credentials.filter((c) => c.kind === "llm_provider" && (c.project_id == null || c.project_id === projectId)),
    [credentials, projectId],
  );

  const filteredByCli = useMemo(() => {
    if (clis.length === 0) return [];
    return llmCredentials.filter((c) => {
      if (!c.agent_cli) return true;
      return clis.includes(c.agent_cli as AgentCli);
    });
  }, [llmCredentials, clis]);

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
        if (defaultCred === id) setDefaultCred("");
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
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await api.patchSettings(projectId, {
        enabled_agent_clis: clis,
        enabled_credential_ids: credIds,
        default_agent_cli: defaultCli || null,
        default_credential_id: defaultCred || null,
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
                return (
                  <label
                    key={credential.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
                      on ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"
                    }`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleCred(credential.id)} className="mt-1 accent-emerald-500" />
                    <span className="min-w-0 flex-1">
                      <strong className="block text-[13px] text-zinc-200">
                        {credential.name || "未命名"} · {credential.provider}
                      </strong>
                      <small className="block font-mono text-[11px] leading-5 text-zinc-500">
                        #{credential.id.slice(0, 8)} · 兼容 {compatibleClis(credential)} · {concurrencySummary(credential)}
                        {credential.status !== "active" ? ` · 状态 ${credential.status}` : ""}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {credIds.length === 0 && (
            <div className="mt-2 text-[12px] text-amber-400/90">
              未启用任何 Provider 时 Hub 无法提案账号；非 Hub 路径仍可回退 RoleConfig 绑定（若已在白名单）。
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
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
              onChange={(next) => setDefaultCred(next || "")}
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
        </div>

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : saved ? "已保存" : failed ? "保存失败" : "保存启用与缺省"}
        </button>
      </div>
    </section>
  );
}
