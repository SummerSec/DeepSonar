import { Books, DownloadSimple, SealCheck, UploadSimple, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SettingsPanel } from "../SettingsPanel";
import { AGENT_PACK_MAX_BYTES, OFFICIAL_AGENT_PACKS, canInstallAgentPack, parseAgentPack, type AgentPack } from "../agent-marketplace";
import { api, type AgentRole } from "../api";
import { useAuth } from "../auth";
import { PageHeader, PageSkeleton } from "../ui";

type MarketTab = "catalog" | "modules";

export function AgentMarketplacePage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: MarketTab = params.get("tab") === "modules" ? "modules" : "catalog";
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingPack, setPendingPack] = useState<AgentPack | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canInstall = canInstallAgentPack(me);

  const reload = async () => {
    try {
      setRoles(await api.agentRoles());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const install = async (pack: AgentPack) => {
    if (!canInstall) {
      setError("安装 Agent 配置需要 agents:write 权限");
      return;
    }
    setBusy(pack.name);
    setError(null);
    setNotice(null);
    let createdRoleId: string | null = null;
    try {
      let role = roles.find((item) => item.name === pack.name);
      if (!role) {
        role = await api.createRole({ name: pack.name, title: pack.title, description: pack.description });
        createdRoleId = role.id;
        setRoles((current) => current.some((item) => item.id === role!.id) ? current : [...current, role!]);
      }
      const current = (await api.globalRoleConfigs()).find((item) => item.role_id === role.id);
      await api.putGlobalRoleConfig(role.id, current ? {
        ...pack.config,
        credentials: current.credentials.map((item) => ({ credential_id: item.credential_id, purpose: item.purpose })),
        config_files: current.config_files.map((item) => ({ path: item.path, content: item.content })),
        pi_extensions: pack.config.pi_extensions?.length
          ? pack.config.pi_extensions
          : (current.pi_extensions_json ?? []),
      } : pack.config);
      setNotice(`${pack.title} ${pack.version} 已安装为全局缺省；既有本机凭据与 Provider 配置文件保持不变`);
      setPendingPack(null);
      await reload();
    } catch (cause) {
      let detail = cause instanceof Error ? cause.message : String(cause);
      if (createdRoleId) {
        try {
          await api.deleteRole(createdRoleId);
          setRoles((current) => current.filter((item) => item.id !== createdRoleId));
        } catch (rollbackCause) {
          detail += `；回滚新角色失败: ${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`;
        }
      }
      setError(detail);
    } finally {
      setBusy(null);
    }
  };

  const readPack = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      if (file.size > AGENT_PACK_MAX_BYTES) throw new Error("Agent 配置包超过 256 KiB");
      setPendingPack(parseAgentPack(await file.text()));
    } catch (cause) {
      setPendingPack(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (loading) return <PageSkeleton />;

  return (
    <div className="page-scroll">
      <PageHeader
        title="Agent 市场"
        eyebrow="CAPABILITY REGISTRY"
        subtitle="采用受治理的角色配置模板；安装只写角色与运行配置，不导入长期密钥。"
        actions={tab === "catalog" ? (
          <label className={`secondary-button ${!canInstall ? "pointer-events-none opacity-50" : ""}`} title="上传 deepsonar.agentpack/v1 JSON">
            <UploadSimple size={14} /> 上传配置包
            <input ref={fileRef} type="file" accept="application/json,.json,.agentpack,.deepsonar-agentpack" className="sr-only" disabled={!canInstall} onChange={(event) => void readPack(event.target.files?.[0] ?? null)} />
          </label>
        ) : undefined}
      />

      <div className="mb-5 flex gap-1 border-b border-white/[.055]">
        {([[
          "catalog", "官方与本地包",
        ], ["modules", "模块源"]] as const).map(([key, label]) => (
          <button key={key} className={`px-3 py-2 text-[11px] ${tab === key ? "border-b border-acc-400 text-zinc-100" : "text-zinc-600 hover:text-zinc-300"}`} onClick={() => setParams(key === "catalog" ? {} : { tab: key })}>{label}</button>
        ))}
      </div>

      {error && <div role="alert" className="mb-4 border border-red-400/20 bg-red-400/[.06] px-4 py-3 text-[12px] text-red-200">{error}</div>}
      {notice && <div className="mb-4 border border-emerald-400/20 bg-emerald-400/[.06] px-4 py-3 text-[12px] text-emerald-200">{notice}</div>}

      {tab === "modules" ? (
        <div className="-mx-5 sm:-mx-9">
          <SettingsPanel projectId={null} variant="page" globalSection="modules" />
        </div>
      ) : (
        <>
          {pendingPack && (
            <section className="mb-5 grid gap-4 border border-amber-300/20 bg-amber-300/[.05] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] text-amber-200"><Warning size={14} /> 本地未验证包</div>
                <h2 className="mt-2 text-[15px] text-zinc-100">{pendingPack.title} <span className="font-mono text-[10px] text-zinc-600">{pendingPack.version}</span></h2>
                <p className="mt-1 text-[12px] leading-5 text-zinc-500">{pendingPack.description}</p>
                <p className="mt-2 font-mono text-[10px] text-zinc-700">{pendingPack.publisher} / {pendingPack.name}</p>
              </div>
              <button className="primary-button" disabled={busy !== null || !canInstall} onClick={() => void install(pendingPack)}><DownloadSimple size={14} /> {busy === pendingPack.name ? "安装中…" : "安装本地包"}</button>
            </section>
          )}

          <div className="mb-3 flex items-center gap-2 text-[11px] text-zinc-500"><Books size={15} /> 官方目录</div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {OFFICIAL_AGENT_PACKS.map((pack) => {
              const installed = roles.some((role) => role.name === pack.name);
              return (
                <article key={pack.name} className="surface-shell">
                  <div className="surface-core flex min-h-[210px] flex-col p-5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[.12em] text-emerald-300"><SealCheck size={13} weight="fill" /> Official</span>
                      <span className="font-mono text-[9px] text-zinc-700">v{pack.version}</span>
                    </div>
                    <h2 className="mt-5 text-[17px] font-medium text-zinc-100">{pack.title}</h2>
                    <p className="mt-2 text-[12px] leading-6 text-zinc-500">{pack.description}</p>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                      <span className="font-mono text-[10px] text-zinc-700">{pack.name} · {pack.config.agent_cli}</span>
                      <button className={installed ? "secondary-button" : "primary-button"} disabled={busy !== null || !canInstall} onClick={() => void install(pack)}><DownloadSimple size={14} /> {busy === pack.name ? "安装中…" : installed ? "重新采用" : "采用"}</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          {!canInstall && <p className="mt-4 text-[11px] text-amber-300/80">当前账号可浏览目录；安装需要 agents:write 权限。</p>}
        </>
      )}
    </div>
  );
}
