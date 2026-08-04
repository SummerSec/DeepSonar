import { ArrowsClockwise, Cube, DownloadSimple, MagnifyingGlass, Plus, SealCheck, ShieldWarning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth";
import {
  api,
  type ProviderCredential,
  type RuntimeImageDetail,
  type RuntimeImageLocalCandidate,
  type RuntimeImageSummary,
  type RuntimeImageTrustStatus,
  type RuntimeImageVersion,
  type RuntimeImageRegistry,
  type RuntimeImagePullTask,
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
  return (
    <span className={`rounded-full border px-2 py-1 font-mono text-[9px] uppercase tracking-[.12em] ${TRUST_STYLE[value]}`}>
      {value}
    </span>
  );
}

function shortDigest(value: string | null) {
  return value ? `${value.slice(0, 19)}…${value.slice(-8)}` : "digest pending";
}

function sizeLabel(bytes: number | null) {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MiB` : "—";
}

function canApproveVersion(version: RuntimeImageVersion): { ok: boolean; reason: string } {
  const latestSucceeded = version.scans.some((scan) => scan.status === "succeeded");
  if (version.trust_status === "trusted") return { ok: false, reason: "已是可信版本" };
  if (version.trust_status === "revoked") return { ok: false, reason: "已撤销，不能再批准" };
  if (!latestSucceeded) return { ok: false, reason: "需先完成准入扫描（状态 succeeded）" };
  if (!version.digest || !version.resolved_ref) return { ok: false, reason: "尚未固定不可变 digest" };
  return { ok: true, reason: "" };
}

function localCheckLabel(value: boolean | null | undefined): string {
  return value === true ? "通过" : value === false ? "未通过" : "未知";
}

function localCheckStyle(value: boolean | null | undefined): string {
  return value === true
    ? "text-emerald-300 bg-emerald-400/[.08] ring-emerald-400/20"
    : value === false
      ? "text-red-300 bg-red-400/[.08] ring-red-400/20"
      : "text-zinc-400 bg-white/[.04] ring-white/[.08]";
}

function registrySourceLabel(registry: RuntimeImageRegistry): string {
  const source = registry.source;
  if (typeof source === "string") {
    if (source === "remote") return "remote（GitHub Release）";
    if (source === "bundled") return "bundled（内置回退）";
    if (source === "upload") return "手动更新市场";
    return source;
  }
  if (source && typeof source === "object") {
    return source.kind ?? source.url ?? "未说明";
  }
  const metadataSource = registry.metadata?.source;
  return typeof metadataSource === "string" ? metadataSource : "未说明";
}

function platformLabel(platforms: string[] | null | undefined): string {
  if (!platforms?.length) return "—";
  return platforms.join(" · ");
}

function versionMatchesPlatform(version: RuntimeImageVersion, platform: string | null): boolean {
  if (!platform) return true;
  const platforms = version.platforms_json ?? [];
  if (platforms.length === 0) return true;
  return platforms.includes(platform);
}

function imageMatchesPlatform(image: RuntimeImageSummary, platform: string | null): boolean {
  if (!platform) return true;
  const platforms = image.platforms_json ?? [];
  if (platforms.length === 0) return true;
  return platforms.includes(platform);
}

const PLATFORM_FILTERS = [
  { id: null as string | null, label: "全部平台" },
  { id: "linux/amd64", label: "linux/amd64" },
  { id: "linux/arm64", label: "linux/arm64" },
];

function LocalCandidatePanel({
  candidate,
  canAdopt,
  busy,
  onAdopt,
}: {
  candidate: RuntimeImageLocalCandidate;
  canAdopt: boolean;
  busy: boolean;
  onAdopt: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-white/[.07] bg-black/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-1 font-mono text-[9px] ring-1 ${localCheckStyle(candidate.exists)}`}>本地镜像 {localCheckLabel(candidate.exists)}</span>
        <span className={`rounded-full px-2 py-1 font-mono text-[9px] ring-1 ${localCheckStyle(candidate.contract_valid)}`}>contract {localCheckLabel(candidate.contract_valid)}</span>
        <span className={`rounded-full px-2 py-1 font-mono text-[9px] ring-1 ${localCheckStyle(candidate.product_match)}`}>product {localCheckLabel(candidate.product_match)}</span>
        <span className={`rounded-full px-2 py-1 font-mono text-[9px] ring-1 ${localCheckStyle(candidate.adoptable)}`}>adoptable {localCheckLabel(candidate.adoptable)}</span>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-[10px] sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-mono text-zinc-700">IMAGE REF</dt>
          <dd className="mt-0.5 break-all font-mono text-zinc-400">{candidate.image_ref || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-zinc-700">IMAGE ID（不可变）</dt>
          <dd className="mt-0.5 break-all font-mono text-zinc-400">{candidate.image_id || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-zinc-700">REPO DIGESTS</dt>
          <dd className="mt-0.5 break-all font-mono text-zinc-400">{candidate.repo_digests.length ? candidate.repo_digests.join(" · ") : "—"}</dd>
        </div>
        <div>
          <dt className="font-mono text-zinc-700">OS / ARCH</dt>
          <dd className="mt-0.5 font-mono text-zinc-400">{candidate.os || "—"} / {candidate.architecture || "—"}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="font-mono text-zinc-700">IMMUTABLE REF</dt>
          <dd className="mt-0.5 break-all font-mono text-zinc-400">{candidate.immutable_ref || "—"}</dd>
        </div>
      </dl>
      {candidate.reasons.length > 0 && (
        <div className="mt-3 rounded-lg bg-white/[.035] px-3 py-2">
          <div className="font-mono text-[9px] tracking-[.12em] text-zinc-600">CHECK REASONS</div>
          <ul className="mt-1 space-y-1 text-[11px] leading-5 text-zinc-400">
            {candidate.reasons.map((reason, index) => <li key={`${index}:${reason}`}>· {reason}</li>)}
          </ul>
        </div>
      )}
      {candidate.error && (
        <p className="mt-3 rounded-lg bg-red-400/[.06] px-3 py-2 text-[11px] leading-5 text-red-300">检测诊断：{candidate.error}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="primary-button"
          disabled={!candidate.adoptable || !candidate.image_id || !canAdopt || busy}
          title={!canAdopt ? "需要管理员角色或 images:approve 权限" : !candidate.adoptable ? "检测未通过，不能授权采用" : undefined}
          onClick={onAdopt}
        >
          {busy ? "授权中…" : "授权采用此候选"}
        </button>
        {!canAdopt && <span className="text-[11px] text-amber-300/80">当前账号无 images:approve；请让管理员复核并授权。</span>}
        {canAdopt && !candidate.adoptable && <span className="text-[11px] text-zinc-600">仅 adoptable 候选可授权，检测本身不会改变信任状态。</span>}
      </div>
    </div>
  );
}

export function RuntimeImagesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { me } = useAuth();
  const [rows, setRows] = useState<RuntimeImageSummary[]>([]);
  const [selected, setSelected] = useState<RuntimeImageDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [form, setForm] = useState({
    image_key: "",
    name: "",
    description: "",
    publisher: "",
    source_url: "",
    image_ref: "",
    version: "",
    registry_credential_id: "",
  });
  const [officialRef, setOfficialRef] = useState("");
  const [officialVersion, setOfficialVersion] = useState("");
  const [registry, setRegistry] = useState<RuntimeImageRegistry | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({ image_key: "", name: "", description: "", publisher: "", image_ref: "", version: "" });
  const [pullStatus, setPullStatus] = useState<RuntimeImagePullTask | null>(null);
  const [localPanel, setLocalPanel] = useState<string | null>(null);
  const [localRefs, setLocalRefs] = useState<Record<string, string>>({});
  const [localCandidates, setLocalCandidates] = useState<Record<string, RuntimeImageLocalCandidate | null>>({});
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [projectVersionPick, setProjectVersionPick] = useState<Record<string, string>>({});

  const canAdoptLocal = Boolean(me && (!me.auth_required || me.actor?.role === "admin" || me.actor?.scopes.includes("admin") || me.actor?.scopes.includes("images:approve")));
  const canManageCatalog = Boolean(me && (!me.auth_required || me.actor?.role === "admin" || me.actor?.scopes.includes("admin") || me.actor?.scopes.includes("images:manage") || me.actor?.scopes.includes("images:approve")));

  const reload = async (keepSelected = true) => {
    try {
      const list = await api.runtimeImages(projectId, search || undefined);
      setRows(list);
      if (keepSelected && selected) setSelected(await api.runtimeImage(selected.image.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload(false);
  }, [projectId, search]);
  useEffect(() => {
    api
      .credentials()
      .then((items) => setCredentials(items.filter((item) => item.kind === "oci_registry")))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!projectId) api.runtimeImagesRegistry().then(setRegistry).catch((cause) => setError(cause instanceof Error ? `获取市场清单失败：${cause.message}` : "获取市场清单失败"));
  }, [projectId]);
  useEffect(() => {
    if (projectId) return;
    void api.runtimeImagesPullStatus().then(setPullStatus).catch((cause) => setError(cause instanceof Error ? `获取拉取状态失败：${cause.message}` : "获取拉取状态失败"));
  }, [projectId]);
  useEffect(() => {
    if (projectId || !pullStatus || !["queued", "running"].includes(pullStatus.status)) return;
    const timer = window.setInterval(() => {
      void api.runtimeImagesPullStatus().then(setPullStatus).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [projectId, pullStatus?.status]);
  useEffect(() => {
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [projectId, search, selected?.image.id]);

  const open = async (id: string) => {
    setBusy(id);
    try {
      const detail = await api.runtimeImage(id);
      setSelected(detail);
      setOfficialRef("");
      setOfficialVersion("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
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
      setForm({
        image_key: "",
        name: "",
        description: "",
        publisher: "",
        source_url: "",
        image_ref: "",
        version: "",
        registry_credential_id: "",
      });
      setShowImport(false);
      await reload(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const actVersion = async (version: RuntimeImageVersion, status: "trusted" | "rejected" | "disabled" | "revoked") => {
    const reason = status === "rejected" || status === "revoked" ? window.prompt(`${status} 原因`)?.trim() : undefined;
    if ((status === "rejected" || status === "revoked") && !reason) return;
    setBusy(version.id);
    try {
      await api.setRuntimeImageVersionStatus(version.id, status, reason);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const registerOfficial = async () => {
    if (!selected) return;
    setBusy("official-digest");
    try {
      await api.registerOfficialRuntimeDigest(selected.image.id, {
        image_ref: officialRef.trim(),
        ...(officialVersion.trim() ? { version: officialVersion.trim() } : {}),
      });
      setOfficialRef("");
      setOfficialVersion("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const exportRegistry = () => {
    if (!registry) return;
    const blob = new Blob([JSON.stringify(registry, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "runtime-image-registry.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const syncRegistry = async () => {
    setBusy("registry-sync");
    try {
      const result = await api.syncRuntimeImagesRegistry();
      setRegistry(result.registry);
      setNotice(`市场同步完成：${result.product_count} 个产品，${result.version_count} 个版本`);
      setError(null);
      await reload(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** 手动更新市场：选择本地 runtime-image-registry.json 上传并写入 DB */
  const applyRegistryFile = async (file: File | null) => {
    if (!file) return;
    setBusy("registry-apply");
    setError(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("文件不是合法 JSON");
      }
      if (!parsed || typeof parsed !== "object" || (parsed as { schema?: string }).schema !== "deepsonar.registry/v1") {
        throw new Error("请选择 runtime-image-registry.json（schema 须为 deepsonar.registry/v1）");
      }
      const result = await api.applyRuntimeImagesRegistry(parsed as RuntimeImageRegistry);
      setRegistry(result.registry);
      setNotice(`手动更新市场完成：${result.product_count} 个产品，${result.version_count} 个版本（已写入数据库）`);
      await reload(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const pullRegistry = async () => {
    setBusy("registry-pull");
    try {
      const result = await api.pullRuntimeImagesRegistry();
      setPullStatus(result.task);
      setNotice(`已启动异步拉取：${result.task.total} 个远程不可变版本`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const registerManual = async () => {
    setBusy("manual-digest");
    try {
      await api.registerManualRuntimeDigest({ ...manualForm, description: manualForm.description || undefined, version: manualForm.version || undefined });
      setManualForm({ image_key: "", name: "", description: "", publisher: "", image_ref: "", version: "" });
      setShowManual(false);
      await reload(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const bind = async (image: RuntimeImageSummary, enabled: boolean, versionId?: string | null) => {
    if (!projectId) return;
    setBusy(image.id);
    try {
      await api.bindProjectRuntimeImage(projectId, image.id, enabled, versionId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const detectLocal = async (image: RuntimeImageSummary) => {
    const imageRef = (localRefs[image.id] ?? "").trim();
    if (!imageRef) {
      setError("请输入本地镜像 tag 或引用，例如 deepsonar-base:local");
      return;
    }
    setBusy(`detect-local:${image.id}`);
    setError(null);
    setLocalCandidates((current) => ({ ...current, [image.id]: null }));
    try {
      const candidate = await api.detectLocalRuntimeImage(image.id, imageRef);
      setLocalCandidates((current) => ({ ...current, [image.id]: candidate }));
      setNotice(candidate.adoptable ? `${image.name} 检测到可供管理员复核的本地候选；检测不会自动授权采用` : `${image.name} 本地候选未通过采用条件，请查看原因`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/401|403|unauthori[sz]ed|forbidden|权限|鉴权/i.test(message) ? "没有检测本地镜像的权限（需要 images:read）" : `检测本地镜像失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  const adoptLocal = async (image: RuntimeImageSummary, candidate: RuntimeImageLocalCandidate) => {
    if (!candidate.adoptable || !candidate.image_id) return;
    if (!canAdoptLocal) {
      setError("授权采用需要管理员角色或 images:approve 权限");
      return;
    }
    const expectedImageId = candidate.image_id;
    const confirmed = window.confirm(
      `确认授权采用 ${image.name} 的本地镜像？\n\nimage_ref: ${candidate.image_ref}\nimage_id: ${expectedImageId}\n\n这会把当前 image_id 绑定为本机 local-docker trusted 版本；确认前请核对不可变引用。`,
    );
    if (!confirmed) return;
    setBusy(`adopt-local:${image.id}`);
    setError(null);
    try {
      await api.adoptLocalRuntimeImage(image.id, {
        image_ref: candidate.image_ref,
        expected_image_id: expectedImageId,
      });
      setNotice(`${image.name} 已授权采用本地 trusted 版本（image_id ${expectedImageId.slice(0, 19)}…）`);
      setLocalCandidates((current) => ({ ...current, [image.id]: null }));
      await reload(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/401|403|unauthori[sz]ed|forbidden|权限|鉴权/i.test(message) ? "没有授权采用权限（需要管理员角色或 images:approve）" : `授权采用失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <PageSkeleton rows={6} />;

  return (
    <div className="page-scroll">
      <PageHeader
        title={projectId ? "项目运行镜像" : "镜像市场"}
        eyebrow="TRUSTED RUNTIME CATALOG"
        subtitle={
          projectId
            ? "为项目启用已准入镜像，并固定角色可选择的可信版本。任务表单仍不暴露镜像参数。"
            : "官方与第三方运行时共用不可变 digest、准入扫描、审批、撤销和证据链。「同步市场」拉 GitHub Release；不可达时用「手动更新市场」选择本机 runtime-image-registry.json 上传入库。一平台一版本，项目可固定平台 digest。"
        }
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <label className="selector-search min-w-0 flex-1 sm:min-w-[220px]">
              <MagnifyingGlass size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索镜像、发布者、key" />
            </label>
            {!projectId && (
              <>
                <button className="secondary-button" disabled={busy !== null} onClick={syncRegistry} title="从 GitHub Release 自动拉取官方清单（失败则用内置回退）">
                  <ArrowsClockwise size={14} /> 同步市场
                </button>
                <label
                  className={`secondary-button cursor-pointer ${busy !== null || !canManageCatalog ? "pointer-events-none opacity-50" : ""}`}
                  title="手动更新市场：选择本机 runtime-image-registry.json 上传并登记到数据库"
                >
                  <DownloadSimple size={14} className="rotate-180" />
                  {busy === "registry-apply" ? "更新中…" : "手动更新市场"}
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    disabled={busy !== null || !canManageCatalog}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = "";
                      void applyRegistryFile(file);
                    }}
                  />
                </label>
                <button className="secondary-button" disabled={busy !== null || pullStatus?.status === "running" || pullStatus?.status === "queued"} onClick={pullRegistry}>
                  <Cube size={14} /> 异步拉取
                </button>
                <button className="secondary-button" disabled={!registry} onClick={exportRegistry}>
                  <DownloadSimple size={14} /> 导出清单
                </button>
                <button className="secondary-button" onClick={() => setShowManual((value) => !value)}>手动信任登记</button>
                <button className="primary-button" onClick={() => setShowImport((value) => !value)}><Plus size={14} /> 导入镜像</button>
              </>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tracking-[.14em] text-zinc-600">PLATFORM</span>
        {PLATFORM_FILTERS.map((item) => (
          <button
            key={item.label}
            type="button"
            className={platformFilter === item.id ? "primary-button !py-1 !text-[11px]" : "secondary-button !py-1 !text-[11px]"}
            onClick={() => setPlatformFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-1 text-[11px] text-zinc-600">
          一平台一版本；项目可固定某个平台 digest
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/[.07] px-4 py-3 text-sm text-red-300">{error}</div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[.07] px-4 py-3 text-sm text-emerald-300">{notice}</div>
      )}

      {!projectId && registry && (
        <section className="surface-shell mb-5">
          <div className="surface-core flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
            <div>
              <div className="font-mono text-[10px] tracking-[.16em] text-zinc-600">CATALOG PROVENANCE</div>
              <div className="mt-1 text-sm text-zinc-200">来源：{registrySourceLabel(registry)}</div>
            </div>
            <div className="text-xs text-zinc-500">
              {registry.fallback ? <span className="text-amber-300">当前为内置回退清单</span> : <span className="text-emerald-300">当前为受信目录</span>}
              {registry.error && <span className="ml-2 text-amber-200/80">诊断：{registry.error}</span>}
            </div>
            {(registry.checked_at || (registry.metadata && typeof registry.metadata.fetched_at === "string" && registry.metadata.fetched_at)) && (
              <span className="font-mono text-[10px] text-zinc-700">checked {registry.checked_at ?? String(registry.metadata?.fetched_at)}</span>
            )}
          </div>
        </section>
      )}

      {!projectId && pullStatus && pullStatus.status !== "idle" && (
        <section className="surface-shell mb-5">
          <div className="surface-core p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[.16em] text-zinc-500">REGISTRY PULL</div>
                <div className="mt-1 text-sm text-zinc-200">
                  {pullStatus.status === "succeeded" ? "拉取完成" : pullStatus.status === "failed" ? "拉取完成，但有失败项" : `拉取进度 ${pullStatus.completed}/${pullStatus.total}`}
                </div>
              </div>
              <span className="font-mono text-xs text-zinc-400">{pullStatus.completed}/{pullStatus.total}</span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-zinc-400">
              {pullStatus.items.map((item) => (
                <div key={`${item.image_key}:${item.image_ref}`} className="flex items-center justify-between gap-3">
                  <span className="truncate">{item.image_key} · {item.image_ref}</span>
                  <span className={`max-w-[58%] break-words text-right ${item.status === "failed" ? "text-red-300" : item.status === "succeeded" ? "text-emerald-300" : "text-zinc-500"}`}>
                    {item.status === "failed" ? (item.error || "失败：Scheduler 未返回具体原因") : item.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {showManual && !projectId && (
        <section className="surface-shell mb-5 border-amber-400/20">
          <div className="surface-core grid gap-3 p-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <span className="font-mono text-[10px] tracking-[.16em] text-amber-300">MANUAL TRUST</span>
              <h2 className="mt-1 text-lg text-zinc-100">手动信任登记</h2>
              <p className="mt-1 text-xs leading-5 text-amber-200/70">仅管理员可用。此操作绕过镜像准入扫描，请仅登记已由你独立核验的不可变 digest；官方产品不能通过此入口登记。</p>
            </div>
            {Object.entries({ image_key: "镜像 key", name: "显示名称", publisher: "发布者", image_ref: "OCI digest（必须含 @sha256:64hex）", version: "版本（可选）", description: "说明（可选）" }).map(([key, label]) => (
              <label key={key} className={key === "image_ref" || key === "description" ? "md:col-span-2" : ""}>
                <span className="mb-1 block font-mono text-[10px] tracking-[.12em] text-zinc-600">{label}</span>
                <input className="field-input w-full font-mono text-[12px]" value={manualForm[key as keyof typeof manualForm]} onChange={(event) => setManualForm({ ...manualForm, [key]: event.target.value })} />
              </label>
            ))}
            <div className="md:col-span-2 flex justify-end">
              <button className="primary-button" disabled={busy === "manual-digest" || !manualForm.image_ref.includes("@sha256:")} onClick={() => void registerManual()}>{busy === "manual-digest" ? "登记中…" : "直接登记为 trusted"}</button>
            </div>
          </div>
        </section>
      )}

      {showImport && (
        <section className="surface-shell mb-5">
          <div className="surface-core grid gap-3 p-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <span className="font-mono text-[10px] tracking-[.16em] text-acc-300">QUARANTINE IMPORT</span>
              <h2 className="mt-1 text-lg text-zinc-100">第三方镜像导入</h2>
              <p className="mt-1 text-xs text-zinc-600">
                导入只进入隔离区；独立 Worker 固定 digest、验签、生成 SBOM、扫描漏洞与凭据并完成断网自检后，仍需管理员审批。官方镜像请点开卡片用「登记官方 digest」。
              </p>
            </div>
            {Object.entries({
              image_key: "镜像 key",
              name: "显示名称",
              publisher: "发布者",
              image_ref: "OCI tag 或 digest",
              version: "版本（可选）",
              source_url: "源码 URL（可选）",
            }).map(([key, label]) => (
              <label key={key} className={key === "image_ref" ? "md:col-span-2" : ""}>
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">{label}</span>
                <input
                  className="field-input w-full"
                  value={form[key as keyof typeof form]}
                  onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                />
              </label>
            ))}
            <label>
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">Registry Credential</span>
              <select
                className="field-input w-full"
                value={form.registry_credential_id}
                onChange={(event) => setForm({ ...form, registry_credential_id: event.target.value })}
              >
                <option value="">公开 registry</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name} · {credential.provider}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">说明</span>
              <input
                className="field-input w-full"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="md:col-span-2 flex justify-end gap-2">
              <button className="secondary-button" onClick={() => setShowImport(false)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy === "import" || !form.image_key || !form.name || !form.publisher || !form.image_ref}
                onClick={importImage}
              >
                {busy === "import" ? "导入中…" : "进入隔离区"}
              </button>
            </div>
          </div>
        </section>
      )}

      {rows.filter((image) => imageMatchesPlatform(image, platformFilter)).length === 0 ? (
        <EmptyState title="没有匹配的运行镜像" hint={platformFilter ? `当前平台筛选：${platformFilter}` : "第三方镜像必须先导入隔离区并完成准入"} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.filter((image) => imageMatchesPlatform(image, platformFilter)).map((image) => (
            <article key={image.id} className="surface-shell">
              <div className="surface-core flex h-full flex-col p-4">
                <div className="flex items-start gap-3">
                  <span className="rounded-xl bg-white/[.035] p-2.5 text-acc-300 ring-1 ring-white/[.06]">
                    <Cube size={20} weight="light" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-medium text-zinc-100">{image.name}</h2>
                      {image.official && (
                        <span className="rounded-full bg-acc-400/[.1] px-2 py-1 font-mono text-[8px] tracking-[.12em] text-acc-300">
                          OFFICIAL
                        </span>
                      )}
                      {image.project_opt_in && (
                        <span className="rounded-full bg-amber-400/[.1] px-2 py-1 font-mono text-[8px] tracking-[.12em] text-amber-300">
                          PROJECT OPT-IN
                        </span>
                      )}
                      <TrustBadge status={image.trust_status} />
                    </div>
                    <p className="mt-1 font-mono text-[9px] text-zinc-600">{image.image_key}</p>
                  </div>
                </div>
                <p className="mt-3 min-h-8 line-clamp-2 text-[11px] leading-4 text-zinc-500">{image.description || "暂无描述"}</p>
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-y border-white/[.045] py-2 text-[10px] sm:grid-cols-3">
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">AUTHOR</span>
                    <strong className="min-w-0 truncate font-normal text-zinc-400">{image.publisher}</strong>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">VERSION</span>
                    <strong className="min-w-0 truncate font-mono font-normal text-zinc-400">{image.latest_version ?? "—"}</strong>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">SIZE</span>
                    <strong className="min-w-0 truncate font-mono font-normal text-zinc-400">{sizeLabel(image.size_bytes)}</strong>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">DIGEST</span>
                    <strong className="min-w-0 truncate font-mono font-normal text-zinc-400" title={image.digest ?? undefined}>
                      {shortDigest(image.digest)}
                    </strong>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">PLATFORMS</span>
                    <strong className="min-w-0 truncate font-normal text-zinc-400">{platformLabel(image.platforms_json)}</strong>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 font-mono text-zinc-700">TOOLS</span>
                    <strong className="min-w-0 truncate font-normal text-zinc-400">{image.tools_json?.length ?? 0} 项</strong>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button className="secondary-button" disabled={busy === image.id} onClick={() => open(image.id)}>
                    版本与证据
                  </button>
                  {!projectId && image.official && (
                    <button
                      className="secondary-button"
                      disabled={busy === `detect-local:${image.id}` || busy === `adopt-local:${image.id}`}
                      onClick={() => setLocalPanel((current) => (current === image.id ? null : image.id))}
                    >
                      <MagnifyingGlass size={12} />
                      {localPanel === image.id ? "收起本地检测" : "检测本地镜像"}
                    </button>
                  )}
                  {projectId && image.trust_status === "trusted" && (
                    <>
                      <button
                        className={image.project_enabled ? "secondary-button" : "primary-button"}
                        disabled={busy === image.id}
                        onClick={() => bind(
                          image,
                          !image.project_enabled,
                          image.project_enabled
                            ? image.selected_version_id
                            : (projectVersionPick[image.id] || image.selected_version_id || image.latest_version_id),
                        )}
                      >
                        {image.project_enabled ? "停用" : "启用"}
                      </button>
                      {image.project_enabled && (
                        <span className="font-mono text-[9px] text-zinc-500">
                          固定：{image.selected_version_id ? "已选版本" : "自动（按平台）"}
                        </span>
                      )}
                    </>
                  )}
                  {!image.latest_version && (
                    <span className="font-mono text-[9px] text-amber-400/90">无版本 · 不可选</span>
                  )}
                  <span className="ml-auto font-mono text-[8px] text-zinc-700">SCAN {formatTime(image.scanned_at)}</span>
                </div>
                {!projectId && image.official && localPanel === image.id && (
                  <section className="mt-4 rounded-2xl border border-acc-400/20 bg-acc-400/[.04] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-[9px] tracking-[.14em] text-acc-300">LOCAL IMAGE GATE</span>
                        <h3 className="mt-1 text-sm font-medium text-zinc-100">只检测，不自动信任</h3>
                      </div>
                      <span className="rounded-full bg-white/[.04] px-2 py-1 font-mono text-[9px] text-zinc-500">transport ≠ trust</span>
                    </div>
                    <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                      先在本机 docker pull / build / load，再输入本地 tag 或引用。服务端会重新读取 image ID、RepoDigest、契约和产品匹配；只有候选明确可采用时，管理员才可二次确认授权。
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        className="field-input min-w-0 flex-1 font-mono text-[12px]"
                        value={localRefs[image.id] ?? ""}
                        onChange={(event) => {
                          setLocalRefs((current) => ({ ...current, [image.id]: event.target.value }));
                          setLocalCandidates((current) => ({ ...current, [image.id]: null }));
                        }}
                        placeholder={`${image.image_key}:local 或 name@sha256:…`}
                        spellCheck={false}
                      />
                      <button
                        className="primary-button shrink-0"
                        disabled={busy === `detect-local:${image.id}` || !(localRefs[image.id] ?? "").trim()}
                        onClick={() => void detectLocal(image)}
                      >
                        {busy === `detect-local:${image.id}` ? "检测中…" : "开始检测"}
                      </button>
                    </div>
                    {localCandidates[image.id] && (
                      <LocalCandidatePanel
                        candidate={localCandidates[image.id]!}
                        canAdopt={canAdoptLocal}
                        busy={busy === `adopt-local:${image.id}`}
                        onAdopt={() => void adoptLocal(image, localCandidates[image.id]!)}
                      />
                    )}
                  </section>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/55"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <aside className="h-full w-full max-w-[620px] overflow-y-auto border-l border-white/[.07] bg-[#0e1214] p-4 shadow-2xl sm:p-6">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[9px] tracking-[.16em] text-acc-300">RUNTIME EVIDENCE</span>
                <h2 className="mt-2 text-xl text-zinc-100">{selected.image.name}</h2>
                <p className="mt-1 font-mono text-[10px] text-zinc-600">{selected.image.image_key}</p>
              </div>
              <button className="secondary-button" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>

            {/* 官方无版本：登记 digest（这才是「让 Kali 可选」的入口，不是第三方批准） */}
            {!projectId && selected.image.official && (
              <section className="mt-6 rounded-2xl border border-acc-400/20 bg-acc-400/[.05] p-4">
                <div className="flex items-center gap-2">
                  <SealCheck size={16} className="text-acc-300" />
                  <strong className="text-[13px] font-medium text-zinc-100">登记官方 digest</strong>
                </div>
                <p className="mt-2 text-[12px] leading-5 text-zinc-500">
                  官方镜像<strong className="text-zinc-400">不会出现「导入 → 扫描 → 批准」按钮</strong>：catalog 只是占位。
                  需要配置 <code className="text-zinc-400">DEEPSONAR_OFFICIAL_*_IMAGE=@sha256:…</code> 并重启，或在此粘贴不可变引用直接登记为
                  trusted。可移动 tag 会被拒绝。
                </p>
                <label className="mt-3 block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">
                    image_ref（必须含 @sha256:）
                  </span>
                  <input
                    className="field-input w-full font-mono text-[12px]"
                    value={officialRef}
                    onChange={(e) => setOfficialRef(e.target.value)}
                    placeholder="registry/deepsonar-kali-minimal@sha256:…"
                    spellCheck={false}
                  />
                </label>
                <label className="mt-2 block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">
                    版本名（可选）
                  </span>
                  <input
                    className="field-input w-full font-mono text-[12px]"
                    value={officialVersion}
                    onChange={(e) => setOfficialVersion(e.target.value)}
                    placeholder="configured-…"
                  />
                </label>
                <button
                  className="primary-button mt-3"
                  disabled={busy === "official-digest" || !officialRef.includes("@sha256:")}
                  onClick={() => void registerOfficial()}
                >
                  {busy === "official-digest" ? "登记中…" : "登记为可信版本"}
                </button>
            </section>
            )}

            <div className="mt-6 space-y-4">
              {selected.versions.some((version) => version.trust_status === "trusted") && selected.versions.some((version) => version.trust_status === "disabled") && (
                <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[.04] px-3 py-2 text-[11px] leading-5 text-zinc-400">
                  <span className="text-emerald-300">可信版本优先：</span>disabled 版本的扫描/停用诊断仍保留在下方，不会遮蔽当前可用的 trusted 版本。
                </div>
              )}
              {projectId && selected.versions.some((v) => v.trust_status === "trusted") && (
                <div className="rounded-xl border border-acc-400/20 bg-acc-400/[.05] p-3">
                  <div className="font-mono text-[9px] tracking-[.14em] text-acc-300">PIN PLATFORM VERSION</div>
                  <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                    为项目固定某一平台的可信 digest。不固定时，调度器按宿主 arch 自动选择。
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <select
                      className="field-input min-w-0 flex-1 font-mono text-[12px]"
                      value={projectVersionPick[selected.image.id] ?? selected.image.selected_version_id ?? ""}
                      onChange={(event) => setProjectVersionPick((current) => ({
                        ...current,
                        [selected.image.id]: event.target.value,
                      }))}
                    >
                      <option value="">自动（按平台匹配）</option>
                      {selected.versions
                        .filter((v) => v.trust_status === "trusted" && versionMatchesPlatform(v, platformFilter))
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.version} · {platformLabel(v.platforms_json)} · {shortDigest(v.digest)}
                          </option>
                        ))}
                    </select>
                    <button
                      className="primary-button shrink-0"
                      disabled={busy === selected.image.id}
                      onClick={() => {
                        const picked = projectVersionPick[selected.image.id] || selected.image.selected_version_id || null;
                        void bind(selected.image, true, picked || null);
                      }}
                    >
                      固定到项目
                    </button>
                  </div>
                </div>
              )}
              {selected.versions.filter((version) => versionMatchesPlatform(version, platformFilter)).length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/[.1] bg-white/[.02] px-4 py-8 text-center">
                  <p className="text-[13px] text-zinc-300">
                    {selected.versions.length === 0 ? "还没有任何版本" : `没有匹配 ${platformFilter} 的版本`}
                  </p>
                  <p className="mt-2 text-[12px] leading-5 text-zinc-600">
                    {selected.versions.length === 0
                      ? (selected.image.official
                        ? "所以看不到「批准」——批准作用在具体 version 上。请先用上方「登记官方 digest」，或配置环境变量后重启调度器。"
                        : "请先「导入镜像」进入隔离区，等准入 Worker 扫描成功后，才会出现「批准 / 提升」。")
                      : "切换顶部 PLATFORM 筛选，或清除筛选查看全部平台版本。"}
                  </p>
                </div>
              ) : (
                [...selected.versions]
                  .filter((version) => versionMatchesPlatform(version, platformFilter))
                  .sort((left, right) => Number(right.trust_status === "trusted") - Number(left.trust_status === "trusted") || Number(right.promoted_at !== null) - Number(left.promoted_at !== null))
                  .map((version) => {
                  const approve = canApproveVersion(version);
                  const isPinned = projectId && selected.image.selected_version_id === version.id;
                  return (
                    <section key={version.id} className={`rounded-2xl border p-4 ${isPinned ? "border-acc-400/35 bg-acc-400/[.06]" : "border-white/[.065] bg-white/[.025]"}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="font-mono text-sm font-normal text-zinc-200">{version.version}</strong>
                        <TrustBadge status={version.trust_status} />
                        {version.platforms_json?.map((platform) => (
                          <span key={platform} className="rounded-full bg-sky-400/[.1] px-2 py-0.5 font-mono text-[8px] tracking-[.08em] text-sky-300">
                            {platform}
                          </span>
                        ))}
                        {version.promoted_at && (
                          <span className="font-mono text-[8px] text-acc-400">PROMOTED</span>
                        )}
                        {isPinned && (
                          <span className="font-mono text-[8px] text-acc-300">PROJECT PIN</span>
                        )}
                      </div>
                      <p className="mt-3 break-all font-mono text-[9px] leading-4 text-zinc-600">
                        {version.resolved_ref ?? version.image_ref}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {version.tools_json.map((tool) => (
                          <span
                            key={tool.name}
                            className="rounded-full bg-white/[.04] px-2 py-1 font-mono text-[8px] text-zinc-500"
                          >
                            {tool.name} {tool.version}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                        <span>平台 {platformLabel(version.platforms_json)}</span>
                        <span>签名 {version.signature_json ? "已验证" : "—"}</span>
                        <span>SBOM {version.sbom_json ? "已生成" : "—"}</span>
                        <span>扫描 {formatTime(version.scanned_at)}</span>
                        <span>大小 {version.size_bytes ? `${Math.round(version.size_bytes / 1024 / 1024)} MiB` : "—"}</span>
                      </div>
                      {version.status_reason && (
                        <p className="mt-3 rounded-lg bg-red-400/[.06] px-3 py-2 text-xs text-red-300">
                          {version.status_reason}
                        </p>
                      )}

                      <div className="mt-4 flex flex-wrap gap-2">
                        {!projectId && (
                          <>
                            <button
                              className="secondary-button"
                              disabled={busy === version.id}
                              onClick={() =>
                                api
                                  .rescanRuntimeImageVersion(version.id)
                                  .then(() => reload())
                                  .catch((cause) => setError(String(cause)))
                              }
                            >
                              <ArrowsClockwise size={12} />
                              重扫
                            </button>
                            <button
                              className="primary-button"
                              disabled={busy === version.id || !approve.ok}
                              title={approve.ok ? "批准为可信版本" : approve.reason}
                              onClick={() => actVersion(version, "trusted")}
                            >
                              <SealCheck size={12} />
                              批准 / 提升
                            </button>
                            <button
                              className="secondary-button"
                              disabled={busy === version.id}
                              onClick={() => actVersion(version, "disabled")}
                            >
                              禁用
                            </button>
                            <button
                              className="secondary-button text-red-300"
                              disabled={busy === version.id}
                              onClick={() => actVersion(version, "revoked")}
                            >
                              <ShieldWarning size={12} />
                              撤销
                            </button>
                          </>
                        )}
                        {projectId && version.trust_status === "trusted" && (
                          <button
                            className={isPinned ? "secondary-button" : "primary-button"}
                            disabled={busy === selected.image.id}
                            onClick={() => bind(selected.image, true, version.id)}
                          >
                            {isPinned ? "已固定此平台版本" : "项目使用此平台版本"}
                          </button>
                        )}
                      </div>
                      {!projectId && !approve.ok && version.trust_status !== "trusted" && (
                        <p className="mt-2 text-[11px] leading-5 text-zinc-600">
                          「批准 / 提升」不可用：{approve.reason}
                          {selected.image.official && "。官方镜像更推荐上方「登记官方 digest」。"}
                        </p>
                      )}

                      {version.scans.map((scan) => (
                        <div
                          key={scan.id}
                          className="mt-3 border-t border-white/[.045] pt-3 font-mono text-[9px] text-zinc-600"
                        >
                          scan {scan.id.slice(0, 8)} · {scan.status}
                          {scan.error ? ` · ${scan.error}` : ""}
                        </div>
                      ))}
                    </section>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
