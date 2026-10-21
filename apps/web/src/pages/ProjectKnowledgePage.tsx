import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type Project } from "../api";
import { useAuth } from "../auth";
import { canAccessAnyScope } from "../permissions";
import { SearchableSelect } from "../SearchableSelect";
import { PageHeader } from "../ui";
import {
  projectKnowledgeApi,
  type KnowledgeDetail,
  type KnowledgeGrant,
  type KnowledgeItem,
  type KnowledgeVersion,
  type KnowledgeVersionDetail,
} from "../ProjectKnowledgeApi";

const field = "rounded-lg border border-white/10 bg-white/[.03] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-acc-400/50";
const button = "rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/[.06] disabled:cursor-not-allowed disabled:opacity-40";
const card = "rounded-xl border border-white/[.07] bg-white/[.025] p-4";
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const short = (value: string | null | undefined) => value ? `${value.slice(0, 8)}…` : "—";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/[.07] p-3 text-sm text-red-200">
    {message}<button type="button" onClick={onRetry} className="ml-3 underline">重试</button>
  </div>;
}

function VersionContent({ value }: { value: KnowledgeVersionDetail }) {
  return <section className={card}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium text-zinc-100">版本内容</h3>
      <span className="font-mono text-[10px] text-zinc-500">SHA-256 {short(value.content_sha256)}</span>
    </div>
    {value.candidate.kind === "memory"
      ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-zinc-300">{value.candidate.content}</pre>
      : Object.entries(value.candidate.files ?? {}).map(([path, content]) =>
        <details key={path} className="mb-2 rounded-lg border border-white/[.06] p-3">
          <summary className="cursor-pointer font-mono text-xs text-zinc-300">{path}</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-zinc-400">{content}</pre>
        </details>)}
    <div className="mt-4 border-t border-white/[.06] pt-3">
      <h4 className="mb-2 text-xs text-zinc-300">来源引用</h4>
      {value.sources_json?.length
        ? value.sources_json.map((source, index) => <div key={index} className="break-all font-mono text-[11px] text-zinc-500">
          {source.kind} · {source.ref} · {short(source.content_hash)}
        </div>)
        : <p className="text-xs text-zinc-600">没有来源引用</p>}
      <p className="mt-2 text-[11px] text-zinc-600">引用仅用于追溯；查看来源证据仍受原项目权限控制。</p>
    </div>
  </section>;
}

export function ProjectKnowledgePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const { me } = useAuth();
  const canRead = canAccessAnyScope(me, ["projects:read"]);
  const canWrite = canAccessAnyScope(me, ["projects:write"]) && me?.actor?.role !== "viewer";
  const selectedId = params.get("item");
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [nextVersionOffset, setNextVersionOffset] = useState<number | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [version, setVersion] = useState<KnowledgeVersionDetail | null>(null);
  const [grants, setGrants] = useState<KnowledgeGrant[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [granteeId, setGranteeId] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Array<{ id: string; operation: string; result_json: Record<string, unknown>; created_at: string }>>([]);
  const [receiptJobId, setReceiptJobId] = useState("");
  const [receiptError, setReceiptError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !canRead) return;
    let active = true;
    setListError(null);
    setListLoading(true);
    projectKnowledgeApi.list(projectId, { kind: kind || undefined, status: status || undefined, query: query || undefined, offset })
      .then((result) => { if (active) { setItems(result.items); setNextOffset(result.next_offset); setListLoading(false); } })
      .catch((error) => { if (active) { setListError(error instanceof Error ? error.message : String(error)); setListLoading(false); } });
    return () => { active = false; };
  }, [projectId, canRead, kind, status, query, offset, refresh]);

  useEffect(() => {
    if (!projectId || !selectedId || !canRead) { setDetail(null); return; }
    let active = true;
    setDetailError(null);
    setDetailLoading(true);
    setVersionId(null);
    setVersion(null);
    setVersions([]);
    projectKnowledgeApi.detail(projectId, selectedId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setVersions(result.versions);
        setNextVersionOffset(result.versions_next_offset);
        setVersionId(result.active_version_id ?? result.versions[0]?.id ?? null);
        setDetailLoading(false);
      })
      .catch((error) => { if (active) { setDetail(null); setDetailError(error instanceof Error ? error.message : String(error)); setDetailLoading(false); } });
    return () => { active = false; };
  }, [projectId, selectedId, canRead, refresh]);

  useEffect(() => {
    if (!projectId || !selectedId || !versionId || !canRead) { setVersion(null); setGrants([]); return; }
    let active = true;
    setDetailError(null);
    Promise.all([
      projectKnowledgeApi.version(projectId, selectedId, versionId),
      projectKnowledgeApi.grants(projectId, selectedId, versionId),
    ]).then(([detailVersion, versionGrants]) => {
      if (active) { setVersion(detailVersion); setGrants(versionGrants); }
    }).catch((error) => { if (active) setDetailError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [projectId, selectedId, versionId, canRead, refresh]);

  useEffect(() => {
    if (!canWrite) return;
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, [canWrite]);

  const granteeOptions = useMemo(() => projects.filter((p) => p.id !== projectId)
    .map((p) => ({ value: p.id, label: p.name, hint: p.id })), [projects, projectId]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try { await action(); setRefresh((value) => value + 1); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function loadReceipts() {
    if (!projectId || !receiptJobId) return;
    setReceiptError(null);
    try { setReceipts((await projectKnowledgeApi.receipts(projectId, receiptJobId)).items); }
    catch (error) { setReceiptError(error instanceof Error ? error.message : String(error)); }
  }

  async function loadMoreVersions() {
    if (!projectId || !selectedId || nextVersionOffset === null) return;
    try {
      const page = await projectKnowledgeApi.versions(projectId, selectedId, nextVersionOffset);
      setVersions((current) => [...current, ...page.items.filter((item) => !current.some((prior) => prior.id === item.id))]);
      setNextVersionOffset(page.next_offset);
    } catch (error) { setDetailError(error instanceof Error ? error.message : String(error)); }
  }

  if (!projectId) return null;
  if (!canRead) return <div className="p-8 text-sm text-zinc-400">没有项目知识读取权限。</div>;
  return <div className="h-full overflow-y-auto px-5 pb-10 pt-7 sm:px-9 sm:pt-9">
    <PageHeader title="项目知识" eyebrow="PROJECT KNOWLEDGE" />
    <p className="mb-6 text-sm text-zinc-500">只读查看 Agent 沉淀的记忆与 Skill。版本晋升由受治理的评测和审查流程完成。</p>
    <div className="grid gap-5 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <section className="space-y-3" aria-label="知识目录">
        <div className={card + " space-y-3"}>
          <input aria-label="搜索知识" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }}
            placeholder="搜索标题或逻辑键" className={field + " w-full"} />
          <div className="grid grid-cols-2 gap-2">
            <SearchableSelect ariaLabel="知识类型" value={kind} onChange={(value) => { setKind(value); setOffset(0); }}
              placeholder="全部类型" options={[{ value: "memory", label: "记忆" }, { value: "skill", label: "Skill" }]} />
            <SearchableSelect ariaLabel="知识状态" value={status} onChange={(value) => { setStatus(value); setOffset(0); }}
              placeholder="全部状态" options={["draft", "active", "stale", "retired", "revoked"]
                .map((value) => ({ value, label: value }))} />
          </div>
          <button type="button" className={button} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
        </div>
        {listError && <ErrorBox message={listError} onRetry={() => setRefresh((value) => value + 1)} />}
        {listLoading && <p className={card + " text-sm text-zinc-500"}>正在加载知识目录…</p>}
        {!listLoading && !listError && items.length === 0 && <p className={card + " text-sm text-zinc-500"}>当前筛选条件下没有项目知识。</p>}
        {items.map((item) => <button key={item.id} type="button"
          onClick={() => setParams((current) => { const next = new URLSearchParams(current); next.set("item", item.id); return next; })}
          className={card + " w-full text-left transition hover:border-acc-400/30 " + (selectedId === item.id ? "border-acc-400/40" : "")}>
          <div className="flex items-start justify-between gap-3">
            <strong className="text-sm font-medium text-zinc-200">{item.title}</strong>
            <span className="rounded bg-white/[.05] px-2 py-1 font-mono text-[10px] text-zinc-400">{item.status}</span>
          </div>
          <div className="mt-2 break-all font-mono text-[11px] text-zinc-600">{item.kind} · {item.logical_key}</div>
          <div className="mt-2 text-[11px] text-zinc-600">v{item.version ?? "—"} · {date(item.updated_at)}</div>
        </button>)}
        <div className="flex justify-between gap-2">
          <button type="button" className={button} disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button>
          <button type="button" className={button} disabled={nextOffset === null}
            onClick={() => setOffset(nextOffset ?? offset)}>下一页</button>
        </div>
      </section>
      <section aria-label="知识详情" className="min-w-0 space-y-4">
        {!selectedId && <div className={card + " text-sm text-zinc-500"}>选择左侧知识查看版本、来源、评测和反馈。</div>}
        {selectedId && detailLoading && <div className={card + " text-sm text-zinc-500"}>正在加载知识详情…</div>}
        {detailError && <ErrorBox message={detailError} onRetry={() => setRefresh((value) => value + 1)} />}
        {detail && <><div className={card}>
          <h2 className="text-lg font-medium text-zinc-100">{detail.title}</h2>
          <p className="mt-1 break-all font-mono text-xs text-zinc-500">{detail.logical_key}</p>
          <p className="mt-3 text-xs text-zinc-500">状态 {detail.status} · 世代 {detail.generation} · {detail.kind === "memory" ? "项目私有记忆" : "版本化 Skill"}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {versions.map((entry) => <button key={entry.id} type="button"
              onClick={() => setVersionId(entry.id)}
              className={button + " " + (versionId === entry.id ? "border-acc-400/50 text-acc-300" : "")}>
              v{entry.version}{entry.revoked_at ? " · 已撤销" : ""}
            </button>)}
            {nextVersionOffset !== null && <button type="button" className={button} onClick={loadMoreVersions}>加载更多版本</button>}
          </div>
        </div>
          {version && <VersionContent value={version} />}
          <div className="grid gap-4 lg:grid-cols-2">
            <section className={card}><h3 className="mb-3 text-sm text-zinc-200">提案与审查</h3>
              {detail.proposals.length === 0 && <p className="text-xs text-zinc-600">暂无提案记录</p>}
              {detail.proposals.map((entry) => <div key={entry.id} className="mb-3 border-b border-white/[.06] pb-3 text-xs text-zinc-400">
                <div>{entry.action} · {entry.state} · 第 {entry.revision} 轮</div>
                <div className="mt-1 text-zinc-500">{entry.reason}</div>
                <div className="mt-1 text-zinc-600">{date(entry.created_at)}</div>
              </div>)}
              {detail.evaluations.map((entry) => <div key={entry.id} className="mb-3 border-b border-white/[.06] pb-3 text-xs text-zinc-400">
                <div>评测 / 审查 · {entry.kind} · {date(entry.created_at)}</div>
                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-zinc-500">{JSON.stringify(entry.result_json, null, 2)}</pre>
              </div>)}
            </section>
            <section className={card}><h3 className="mb-3 text-sm text-zinc-200">使用反馈</h3>
              {detail.usages.length === 0 && <p className="text-xs text-zinc-600">暂无使用记录</p>}
              {detail.usages.map((entry) => <div key={entry.id} className="mb-3 border-b border-white/[.06] pb-3 text-xs text-zinc-400">
                <div>{entry.selector} · Job {short(entry.job_id)}</div>
                <div className="mt-1 text-zinc-500">{entry.feedback_json
                  ? JSON.stringify(entry.feedback_json) : "尚无反馈"}</div>
                <div className="mt-1 text-zinc-600">{date(entry.created_at)}</div>
              </div>)}
            </section>
          </div>
          {version && detail.kind === "skill" && <section className={card}>
            <h3 className="mb-3 text-sm text-zinc-200">精确版本授权</h3>
            {grants.length === 0 && <p className="text-xs text-zinc-600">此版本没有跨项目授权；默认仅来源项目可见。</p>}
            {grants.map((entry) => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.06] py-2 text-xs text-zinc-400">
              <span className="break-all">{entry.grantee_project_id} · {entry.revoked_at ? "已撤销" : "有效"}</span>
              {canWrite && !entry.revoked_at && <button type="button" disabled={busy} className={button}
                onClick={() => act(() => projectKnowledgeApi.revokeGrant(projectId, entry.id))}>撤销授权</button>}
            </div>)}
            {canWrite && !version.revoked_at && <div className="mt-4 flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1"><SearchableSelect ariaLabel="授权项目" value={granteeId}
                onChange={setGranteeId} placeholder="选择受权项目" options={granteeOptions} />
                <input aria-label="受权项目 UUID" value={granteeId} onChange={(event) => setGranteeId(event.target.value.trim())}
                  placeholder="或输入受权项目 UUID" className={field + " mt-2 w-full"} />
              </div>
              <button type="button" disabled={busy || !uuid.test(granteeId)} className={button}
                onClick={() => act(() => projectKnowledgeApi.grant(projectId, detail.id, version.id, granteeId))}>授权此版本</button>
            </div>}
            {canWrite && !version.revoked_at && <div className="mt-5 flex flex-wrap gap-2 border-t border-white/[.06] pt-4">
              <input aria-label="版本撤销原因" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)}
                placeholder="撤销此版本的原因" className={field + " min-w-56 flex-1"} />
              <button type="button" disabled={busy || !revokeReason.trim()} className={button}
                onClick={() => act(() => projectKnowledgeApi.revokeVersion(projectId, detail.id, version.id, revokeReason.trim()))}>撤销版本</button>
            </div>}
            {actionError && <p role="alert" className="mt-3 text-xs text-red-300">{actionError}</p>}
          </section>}
        </>}
        <section className={card}>
          <h3 className="mb-2 text-sm text-zinc-200">历史操作回执</h3>
          <p className="mb-3 text-xs text-zinc-600">仅查询此项目 Job 的持久回执；不恢复执行令牌。</p>
          <div className="flex flex-wrap gap-2">
            <input aria-label="回执 Job ID" value={receiptJobId} onChange={(event) => setReceiptJobId(event.target.value)}
              placeholder="输入 Job UUID" className={field + " min-w-60 flex-1"} />
            <button type="button" className={button} disabled={!receiptJobId} onClick={loadReceipts}>查询</button>
          </div>
          {receiptError && <p role="alert" className="mt-3 text-xs text-red-300">{receiptError}</p>}
          {receipts.map((entry) => <div key={entry.id} className="mt-3 border-t border-white/[.06] pt-3 text-xs text-zinc-400">
            <div>{entry.operation} · {date(entry.created_at)}</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-zinc-500">{JSON.stringify(entry.result_json, null, 2)}</pre>
          </div>)}
        </section>
      </section>
    </div>
  </div>;
}
