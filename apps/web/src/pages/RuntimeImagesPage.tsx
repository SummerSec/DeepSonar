import { ArrowsClockwise, Cube, MagnifyingGlass, Plus, SealCheck, ShieldWarning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  type ProviderCredential,
  type RuntimeImageDetail,
  type RuntimeImageSummary,
  type RuntimeImageTrustStatus,
  type RuntimeImageVersion,
} from "../api";
import { EmptyState, PageHeader, PageSkeleton, formatTime } from "../ui";

const TRUST_STYLE: Record<RuntimeImageTrustStatus, string> = {
  trusted: "border-emerald-400/20 bg-emerald-400/[.08] text-emerald-300",
  quarantined: "border-amber-400/20 bg-amber-400/[.08] text-amber-300",
  scanning: "border-sky-400/20 bg-sky-400/[.08] text-sky-300",
  disabled: "border-zinc-400/20 bg-zinc-400/[.08] text-zinc-400",
  rejected: "border-red-400/20 bg-red-400/[.08] text-red-300",
  revoked: "border-red-400/30 bg-red-400/[.12] text-red-200",
};

function TrustBadge({ status }: { status: RuntimeImageTrustStatus | null }) {
  const value = status ?? "quarantined";
  return <span className={`rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[.12em] ${TRUST_STYLE[value]}`}>{value}</span>;
}

function shortDigest(value: string | null) {
  return value ? `${value.slice(0, 19)}…${value.slice(-8)}` : "digest pending";
}

function sizeLabel(bytes: number | null) {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MiB` : "—";
}

export function RuntimeImagesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [rows, setRows] = useState<RuntimeImageSummary[]>([]);
  const [selected, setSelected] = useState<RuntimeImageDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [form, setForm] = useState({ image_key: "", name: "", description: "", publisher: "", source_url: "", image_ref: "", version: "", registry_credential_id: "" });

  const reload = async (keepSelected = true) => {
    try {
      const list = await api.runtimeImages(projectId, search || undefined);
      setRows(list);
      if (keepSelected && selected) setSelected(await api.runtimeImage(selected.image.id));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void reload(false); }, [projectId, search]);
  useEffect(() => { api.credentials().then((items) => setCredentials(items.filter((item) => item.kind === "oci_registry"))).catch(() => {}); }, []);
  useEffect(() => {
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [projectId, search, selected?.image.id]);

  const open = async (id: string) => {
    setBusy(id);
    try { setSelected(await api.runtimeImage(id)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const importImage = async () => {
    setBusy("import");
    try {
      await api.importRuntimeImage({
        ...form,
        description: form.description || undefined,
        source_url: form.source_url || undefined,
        version: form.version || undefined,
        registry_credential_id: form.registry_credential_id || undefined,
      });
      setForm({ image_key: "", name: "", description: "", publisher: "", source_url: "", image_ref: "", version: "", registry_credential_id: "" });
      setShowImport(false);
      await reload(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const actVersion = async (version: RuntimeImageVersion, status: "trusted" | "rejected" | "disabled" | "revoked") => {
    const reason = status === "rejected" || status === "revoked" ? window.prompt(`${status} 原因`)?.trim() : undefined;
    if ((status === "rejected" || status === "revoked") && !reason) return;
    setBusy(version.id);
    try { await api.setRuntimeImageVersionStatus(version.id, status, reason); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const bind = async (image: RuntimeImageSummary, enabled: boolean, versionId?: string | null) => {
    if (!projectId) return;
    setBusy(image.id);
    try { await api.bindProjectRuntimeImage(projectId, image.id, enabled, versionId); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  if (loading) return <PageSkeleton rows={6} />;
  return <div className="page-scroll">
    <PageHeader title={projectId ? "项目运行镜像" : "镜像市场"} eyebrow="TRUSTED RUNTIME CATALOG" subtitle={projectId ? "为项目启用已准入镜像，并固定角色可选择的可信版本。任务表单仍不暴露镜像参数。" : "官方与第三方运行时共用不可变 digest、准入扫描、审批、撤销和证据链。"} actions={<div className="flex gap-2"><label className="selector-search min-w-[220px]"><MagnifyingGlass size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索镜像、发布者、key" /></label>{!projectId && <button className="primary-button" onClick={() => setShowImport((value) => !value)}><Plus size={14} />导入镜像</button>}</div>} />
    {error && <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/[.07] px-4 py-3 text-sm text-red-300">{error}</div>}
    {showImport && <section className="surface-shell mb-5"><div className="surface-core grid gap-3 p-5 md:grid-cols-2"><div className="md:col-span-2"><span className="font-mono text-[10px] tracking-[.16em] text-acc-300">QUARANTINE IMPORT</span><h2 className="mt-1 text-lg text-zinc-100">第三方镜像导入</h2><p className="mt-1 text-xs text-zinc-600">导入只进入隔离区；独立 Worker 固定 digest、验签、生成 SBOM、扫描漏洞与凭据并完成断网自检后，仍需管理员审批。</p></div>{Object.entries({ image_key: "镜像 key", name: "显示名称", publisher: "发布者", image_ref: "OCI tag 或 digest", version: "版本（可选）", source_url: "源码 URL（可选）" }).map(([key, label]) => <label key={key} className={key === "image_ref" ? "md:col-span-2" : ""}><span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">{label}</span><input className="field-input w-full" value={form[key as keyof typeof form]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}<label><span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">Registry Credential</span><select className="field-input w-full" value={form.registry_credential_id} onChange={(event) => setForm({ ...form, registry_credential_id: event.target.value })}><option value="">公开 registry</option>{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.provider}</option>)}</select></label><label><span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">说明</span><input className="field-input w-full" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><div className="md:col-span-2 flex justify-end gap-2"><button className="secondary-button" onClick={() => setShowImport(false)}>取消</button><button className="primary-button" disabled={busy === "import" || !form.image_key || !form.name || !form.publisher || !form.image_ref} onClick={importImage}>{busy === "import" ? "导入中…" : "进入隔离区"}</button></div></div></section>}
    {rows.length === 0 ? <EmptyState title="没有匹配的运行镜像" hint="第三方镜像必须先导入隔离区并完成准入" /> : <div className="grid gap-4 xl:grid-cols-2">{rows.map((image) => <article key={image.id} className="surface-shell"><div className="surface-core flex h-full flex-col p-5"><div className="flex items-start gap-4"><span className="rounded-2xl bg-white/[.035] p-3 text-acc-300 ring-1 ring-white/[.06]"><Cube size={22} weight="light" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-medium text-zinc-100">{image.name}</h2>{image.official && <span className="rounded-full bg-acc-400/[.1] px-2 py-1 font-mono text-[8px] tracking-[.12em] text-acc-300">OFFICIAL</span>}{image.project_opt_in && <span className="rounded-full bg-amber-400/[.1] px-2 py-1 font-mono text-[8px] tracking-[.12em] text-amber-300">PROJECT OPT-IN</span>}<TrustBadge status={image.trust_status} /></div><p className="mt-1 font-mono text-[9px] text-zinc-600">{image.image_key}</p></div></div><p className="mt-4 min-h-10 text-xs leading-5 text-zinc-500">{image.description || "暂无描述"}</p><div className="mt-4 grid grid-cols-2 gap-2 border-y border-white/[.045] py-3 text-[10px] sm:grid-cols-3"><div><span className="block font-mono text-zinc-700">AUTHOR</span><strong className="mt-1 block font-normal text-zinc-400">{image.publisher}</strong></div><div><span className="block font-mono text-zinc-700">VERSION</span><strong className="mt-1 block font-mono font-normal text-zinc-400">{image.latest_version ?? "—"}</strong></div><div><span className="block font-mono text-zinc-700">SIZE</span><strong className="mt-1 block font-mono font-normal text-zinc-400">{sizeLabel(image.size_bytes)}</strong></div><div><span className="block font-mono text-zinc-700">DIGEST</span><strong className="mt-1 block font-mono font-normal text-zinc-400" title={image.digest ?? undefined}>{shortDigest(image.digest)}</strong></div><div><span className="block font-mono text-zinc-700">PLATFORMS</span><strong className="mt-1 block font-normal text-zinc-400">{image.platforms_json?.join(" · ") || "—"}</strong></div><div><span className="block font-mono text-zinc-700">TOOLS</span><strong className="mt-1 block font-normal text-zinc-400">{image.tools_json?.length ?? 0} 项</strong></div></div><div className="mt-4 flex items-center gap-2"><button className="secondary-button" disabled={busy === image.id} onClick={() => open(image.id)}>版本与证据</button>{projectId && image.trust_status === "trusted" && <button className={image.project_enabled ? "secondary-button" : "primary-button"} disabled={busy === image.id} onClick={() => bind(image, !image.project_enabled, image.selected_version_id)}>{image.project_enabled ? "停用" : "启用"}</button>}<span className="ml-auto font-mono text-[8px] text-zinc-700">SCAN {formatTime(image.scanned_at)}</span></div></div></article>)}</div>}
    {selected && <div className="fixed inset-0 z-40 flex justify-end bg-black/55" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><aside className="h-full w-full max-w-[620px] overflow-y-auto border-l border-white/[.07] bg-[#0e1214] p-6 shadow-2xl"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><span className="font-mono text-[9px] tracking-[.16em] text-acc-300">RUNTIME EVIDENCE</span><h2 className="mt-2 text-xl text-zinc-100">{selected.image.name}</h2><p className="mt-1 font-mono text-[10px] text-zinc-600">{selected.image.image_key}</p></div><button className="secondary-button" onClick={() => setSelected(null)}>关闭</button></div><div className="mt-6 space-y-4">{selected.versions.map((version) => <section key={version.id} className="rounded-2xl border border-white/[.065] bg-white/[.025] p-4"><div className="flex flex-wrap items-center gap-2"><strong className="font-mono text-sm font-normal text-zinc-200">{version.version}</strong><TrustBadge status={version.trust_status} />{version.promoted_at && <span className="font-mono text-[8px] text-acc-400">PROMOTED</span>}</div><p className="mt-3 break-all font-mono text-[9px] leading-4 text-zinc-600">{version.resolved_ref ?? version.image_ref}</p><div className="mt-3 flex flex-wrap gap-1.5">{version.tools_json.map((tool) => <span key={tool.name} className="rounded-full bg-white/[.04] px-2 py-1 font-mono text-[8px] text-zinc-500">{tool.name} {tool.version}</span>)}</div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-zinc-500"><span>签名 {version.signature_json ? "已验证" : "—"}</span><span>SBOM {version.sbom_json ? "已生成" : "—"}</span><span>扫描 {formatTime(version.scanned_at)}</span><span>大小 {version.size_bytes ? `${Math.round(version.size_bytes / 1024 / 1024)} MiB` : "—"}</span></div>{version.status_reason && <p className="mt-3 rounded-lg bg-red-400/[.06] px-3 py-2 text-xs text-red-300">{version.status_reason}</p>}<div className="mt-4 flex flex-wrap gap-2">{!projectId && <><button className="secondary-button" disabled={busy === version.id} onClick={() => api.rescanRuntimeImageVersion(version.id).then(() => reload()).catch((cause) => setError(String(cause)))}><ArrowsClockwise size={12} />重扫</button>{version.scans.some((scan) => scan.status === "succeeded") && <button className="primary-button" disabled={busy === version.id} onClick={() => actVersion(version, "trusted")}><SealCheck size={12} />批准 / 提升</button>}<button className="secondary-button" disabled={busy === version.id} onClick={() => actVersion(version, "disabled")}>禁用</button><button className="secondary-button text-red-300" disabled={busy === version.id} onClick={() => actVersion(version, "revoked")}><ShieldWarning size={12} />撤销</button></>}{projectId && version.trust_status === "trusted" && <button className="primary-button" onClick={() => bind(selected.image, true, version.id)}>项目使用此版本</button>}</div>{version.scans.map((scan) => <div key={scan.id} className="mt-3 border-t border-white/[.045] pt-3 font-mono text-[9px] text-zinc-600">scan {scan.id.slice(0, 8)} · {scan.status}{scan.error ? ` · ${scan.error}` : ""}</div>)}</section>)}</div></aside></div>}
  </div>;
}
