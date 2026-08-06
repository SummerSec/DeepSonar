import { Archive, DownloadSimple, FileArrowUp, LockSimple, SpinnerGap } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, type SharedAsset, type SharedAssetPolicy } from "./api";
import { useAuth } from "./auth";
import { canAccessAnyScope } from "./permissions";

const PAGE_SIZE = 50;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function AssetRows({ assets, writable, onArchive }: { assets: SharedAsset[]; writable: boolean; onArchive: (asset: SharedAsset) => void }) {
  if (!assets.length) return <p className="py-8 text-center text-[12px] text-zinc-600">暂无共享资产</p>;
  return (
    <div className="divide-y divide-ink-800">
      {assets.map((asset) => (
        <div key={asset.id} className="grid min-w-0 gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <LockSimple size={13} className="shrink-0 text-zinc-600" />
              <span className="truncate font-mono text-[12px] text-zinc-200" title={asset.logical_key}>{asset.logical_key}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase text-zinc-600">v{asset.version}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-600">
              <span>{asset.scope_type}</span><span>{asset.origin}</span><span>{formatBytes(Number(asset.bytes))}</span>
              <span title={asset.content_sha256}>sha256:{asset.content_sha256.slice(0, 10)}</span>
              {asset.created_by_job_id && <span title={asset.created_by_job_id}>job:{asset.created_by_job_id.slice(0, 8)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" title="下载资产" aria-label={`下载 ${asset.logical_key}`} onClick={() => void api.downloadSharedAsset(asset)} className="rounded-md p-2 text-zinc-500 hover:bg-ink-800 hover:text-zinc-200"><DownloadSimple size={15} /></button>
            {writable && <button type="button" title="归档资产" aria-label={`归档 ${asset.logical_key}`} onClick={() => onArchive(asset)} className="rounded-md p-2 text-zinc-500 hover:bg-red-400/10 hover:text-red-300"><Archive size={15} /></button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SharedAssetsPanel({ projectId }: { projectId: string | null }) {
  const { me } = useAuth();
  const platform = projectId === null;
  const writable = canAccessAnyScope(me, [platform ? "assets:manage" : "assets:write"]);
  const [assets, setAssets] = useState<SharedAsset[]>([]);
  const [policy, setPolicy] = useState<SharedAssetPolicy | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    setError(null);
    try {
      const page = platform
        ? await api.platformSharedAssets({ limit: PAGE_SIZE, offset })
        : await api.projectSharedAssets(projectId, { limit: PAGE_SIZE, offset });
      setAssets((current) => replace ? page.items : [...current, ...page.items]);
      setHasMore(page.items.length === PAGE_SIZE);
      if (projectId && replace) setPolicy(await api.sharedAssetPolicy(projectId));
    } catch (e) { setError(String(e)); }
  }, [platform, projectId]);

  useEffect(() => { void loadPage(0, true); }, [loadPage]);

  const submit = async () => {
    if (!file || !key.trim()) return;
    setBusy(true); setError(null);
    try {
      if (platform) await api.uploadPlatformSharedAsset(file, key.trim());
      else await api.uploadProjectSharedAsset(projectId, file, key.trim());
      setFile(null); setKey(""); await loadPage(0, true);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-800 pb-4">
        <div><h2 className="text-[15px] font-semibold text-zinc-100">{platform ? "平台共享资产" : "项目共享资产"}</h2><p className="mt-1 text-[12px] text-zinc-500">内容寻址并按 Job 冻结，只读挂载到 Worker 沙箱。</p></div>
        {projectId && policy && (
          <label className="flex items-center gap-2 text-[12px] text-zinc-400">
            <input type="checkbox" checked={policy.platform_enabled} disabled={!writable || busy} onChange={async (event) => { setBusy(true); try { setPolicy(await api.updateSharedAssetPolicy(projectId, event.target.checked)); } catch (e) { setError(String(e)); } finally { setBusy(false); } }} />
            启用平台资产
          </label>
        )}
      </div>
      {error && <div role="alert" className="mt-4 border border-red-400/20 bg-red-400/[.05] px-3 py-2 text-[12px] text-red-200">{error}</div>}
      {writable && (
        <div className="grid gap-3 border-b border-ink-800 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="text-[11px] text-zinc-500">文件<input type="file" disabled={busy} onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected && !key) setKey(selected.name); }} className="mt-1 block w-full text-[12px] text-zinc-400 file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-2 file:text-zinc-300" /></label>
          <label className="text-[11px] text-zinc-500">逻辑路径<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="scripts/reproduce.sh" className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500" /></label>
          <button type="button" disabled={!file || !key.trim() || busy} onClick={() => void submit()} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-acc-500 px-3 text-[12px] font-medium text-white disabled:opacity-40">{busy ? <SpinnerGap size={15} className="animate-spin" /> : <FileArrowUp size={15} />}上传</button>
        </div>
      )}
      <AssetRows assets={assets} writable={writable} onArchive={async (asset) => { setBusy(true); try { await api.archiveSharedAsset(asset.id); await loadPage(0, true); } catch (e) { setError(String(e)); } finally { setBusy(false); } }} />
      {hasMore && <button type="button" disabled={busy} onClick={() => { setBusy(true); void loadPage(assets.length, false).finally(() => setBusy(false)); }} className="mt-3 inline-flex h-8 items-center gap-2 rounded-md border border-ink-700 px-3 text-[11px] text-zinc-400 hover:border-ink-600 hover:text-zinc-200 disabled:opacity-40">加载更多</button>}
    </div>
  );
}

export function FindingSharedAssets({ findingId }: { findingId: string }) {
  const [assets, setAssets] = useState<SharedAsset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadPage = useCallback(async (offset: number, replace: boolean, isLive: () => boolean = () => true) => {
    setBusy(true); setError(null);
    try {
      const page = await api.findingSharedAssets(findingId, { limit: PAGE_SIZE, offset });
      if (!isLive()) return;
      setAssets((current) => replace ? page.items : [...current, ...page.items]);
      setHasMore(page.items.length === PAGE_SIZE);
    } catch (e) { if (isLive()) setError(String(e)); } finally { if (isLive()) setBusy(false); }
  }, [findingId]);
  useEffect(() => { let live = true; void loadPage(0, true, () => live); return () => { live = false; }; }, [loadPage]);
  return <section className="mt-6" aria-label="Finding 共享资产"><div className="mb-2 flex items-center gap-2"><LockSimple size={14} className="text-zinc-500" /><h3 className="text-[13px] font-medium text-zinc-200">只读工作包</h3><span className="font-mono text-[10px] text-zinc-600">{assets.length}</span></div>{error ? <p role="alert" className="text-[11px] text-red-300">{error}</p> : <><AssetRows assets={assets} writable={false} onArchive={() => {}} />{hasMore && <button type="button" disabled={busy} onClick={() => void loadPage(assets.length, false)} className="mt-2 inline-flex h-8 items-center rounded-md border border-ink-700 px-3 text-[11px] text-zinc-400 disabled:opacity-40">{busy ? "加载中" : "加载更多"}</button>}</>}</section>;
}
