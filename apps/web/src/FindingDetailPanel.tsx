import {
  ArrowSquareOut,
  ChatCircle,
  Link as LinkIcon,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type FindingComment,
  type FindingDetail,
  type FindingDisposition,
  type FindingLink,
} from "./api";
import { MarkdownView } from "./MarkdownView";
import { DISPOSITION_OPTIONS, SeverityBadge, StatusBadge, formatTime } from "./ui";

const LINK_TYPES: { value: FindingLink["link_type"]; label: string }[] = [
  { value: "related", label: "相关" },
  { value: "ticket", label: "工单" },
  { value: "pr", label: "PR" },
  { value: "doc", label: "文档" },
  { value: "evidence", label: "证据" },
];

const LINK_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  LINK_TYPES.map((t) => [t.value, t.label]),
);

function shortId(id: string) {
  return id.slice(0, 8);
}

function SidebarField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="theme-divider border-b py-3 last:border-0">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">{label}</div>
      <div className="text-[13px] leading-5 text-zinc-300">{children}</div>
    </div>
  );
}

export function FindingDetailPanel({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [linkType, setLinkType] = useState<FindingLink["link_type"]>("related");
  const [showLinkForm, setShowLinkForm] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    return api
      .finding(findingId)
      .then((value) => {
        setDetail(value);
        setNote(value.finding.disposition_note ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [findingId]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    api
      .finding(findingId)
      .then((value) => {
        if (!alive) return;
        setDetail(value);
        setNote(value.finding.disposition_note ?? "");
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [findingId]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2800);
  };

  const f = detail?.finding;
  const comments: FindingComment[] = detail?.comments ?? [];
  const links: FindingLink[] = detail?.links ?? [];
  const isConfirmed =
    f?.verify_status === "confirmed" || f?.disposition === "confirmed_vuln";

  const setDisposition = async (disposition: FindingDisposition) => {
    setBusy(true);
    try {
      await api.setFindingDisposition(findingId, {
        disposition,
        note: note.trim() || undefined,
      });
      flash("状态已更新");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      const r = await api.addFindingComment(findingId, comment.trim(), true);
      setComment("");
      if (r.hub?.hub_queued) {
        flash("评论已发布，已唤醒 Hub");
      } else if (isConfirmed && r.hub?.reason === "hub_paused") {
        flash("评论已发布；画布已暂停，Hub 未启动");
      } else if (isConfirmed) {
        flash(`评论已发布；Hub 未入队（${r.hub?.reason ?? "unknown"}）`);
      } else {
        flash("评论已发布");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitLink = async () => {
    if (!linkUrl.trim()) return;
    setBusy(true);
    try {
      await api.addFindingLink(findingId, {
        url: linkUrl.trim(),
        title: linkTitle.trim() || undefined,
        link_type: linkType,
      });
      setLinkUrl("");
      setLinkTitle("");
      setShowLinkForm(false);
      flash("链接已关联");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Finding 详情"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="theme-drawer flex h-full min-h-0 w-full max-w-[1040px] flex-col border-l">
        {/* Issue header */}
        <header className="theme-drawer-header theme-divider shrink-0 border-b px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
                <span className="text-zinc-600">Finding</span>
                <span className="text-zinc-400">#{shortId(findingId)}</span>
                {f && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <SeverityBadge severity={f.severity} />
                    <StatusBadge status={f.verify_status} />
                    <StatusBadge status={f.disposition ?? "open"} />
                  </>
                )}
              </div>
              <h1 className="mt-2 text-[20px] font-semibold leading-7 tracking-tight text-zinc-50">
                {f?.title ?? "加载中…"}
              </h1>
              {f && (
                <p className="mt-1.5 font-mono text-[11px] text-zinc-600">
                  开于 {formatTime(f.created_at)}
                  {f.disposition_by
                    ? ` · 状态由 ${f.disposition_by}${f.disposition_at ? ` 于 ${formatTime(f.disposition_at)}` : ""} 更新`
                    : ""}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="theme-surface flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-400"
            >
              <X size={16} />
            </button>
          </div>
          {msg && <div className="mt-3 font-mono text-[12px] text-acc-400">{msg}</div>}
          {error && (
            <div className="mt-3 rounded-xl bg-red-950/30 px-4 py-2.5 text-sm text-red-300 ring-1 ring-red-400/20">
              {error}
            </div>
          )}
        </header>

        {!error && !f && (
          <div className="p-8 font-mono text-sm text-zinc-600">正在读取 Finding…</div>
        )}

        {f && detail && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
              {/* ── Main: body + activity ── */}
              <div className="theme-divider min-w-0 px-5 py-5 sm:px-6 lg:border-r">
                {/* Description */}
                <section className="theme-surface rounded-xl ring-1">
                  <div className="theme-divider flex items-center gap-2 border-b px-4 py-2.5">
                    <span className="theme-chip flex size-7 items-center justify-center rounded-full font-mono text-[10px] text-zinc-400">
                      AI
                    </span>
                    <span className="text-[13px] text-zinc-300">描述</span>
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">
                      {formatTime(f.created_at)}
                    </span>
                  </div>
                  <div className="px-4 py-4">
                    {f.summary ? (
                      <MarkdownView markdown={f.summary} />
                    ) : (
                      <p className="text-[13px] text-zinc-600">无描述内容。</p>
                    )}
                    {f.location && (
                      <div className="theme-input-surface mt-4 rounded-lg border px-3 py-2 font-mono text-[11px] text-zinc-400">
                        <span className="text-zinc-600">location </span>
                        {f.location}
                      </div>
                    )}
                  </div>
                </section>

                {/* Activity / comments timeline */}
                <section className="mt-6">
                  <div className="mb-3 flex items-center gap-2">
                    <ChatCircle size={15} className="text-zinc-500" />
                    <h2 className="text-[14px] font-medium text-zinc-200">
                      活动
                      <span className="ml-1.5 font-mono text-[12px] font-normal text-zinc-600">
                        {comments.length}
                      </span>
                    </h2>
                  </div>

                  {isConfirmed && (
                    <p className="mb-3 rounded-lg bg-acc-500/[.06] px-3 py-2 text-[11px] leading-5 text-zinc-500 ring-1 ring-acc-400/15">
                      已确认 Finding 的评论会写入画布并尝试唤醒 Hub（complete / 新 intent）。
                    </p>
                  )}

                  <div className="relative space-y-0">
                    {comments.length === 0 && (
                      <p className="rounded-xl border border-dashed border-white/[.08] px-4 py-6 text-center text-[12px] text-zinc-600">
                        还没有评论。像 GitHub Issue 一样在下方讨论处置与后续动作。
                      </p>
                    )}
                    {comments.map((c, i) => (
                      <div key={c.id} className="relative flex gap-3 pb-4">
                        {i < comments.length - 1 && (
                          <span
                            className="absolute left-[13px] top-8 bottom-0 w-px bg-white/[.06]"
                            aria-hidden
                          />
                        )}
                        <span className="relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[.07] font-mono text-[10px] uppercase text-zinc-400 ring-1 ring-white/[.06]">
                          {(c.author_name || "?").slice(0, 1)}
                        </span>
                        <div className="theme-surface min-w-0 flex-1 rounded-xl ring-1">
                          <div className="theme-divider theme-surface flex flex-wrap items-center gap-2 border-b px-3 py-2">
                            <span className="text-[13px] font-medium text-zinc-200">
                              {c.author_name || "anonymous"}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-600">
                              commented {formatTime(c.created_at)}
                            </span>
                            <button
                              type="button"
                              className="ml-auto rounded p-1 text-zinc-600 hover:text-red-300"
                              disabled={busy}
                              title="删除评论"
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await api.deleteFindingComment(findingId, c.id);
                                  await reload();
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <Trash size={12} />
                            </button>
                          </div>
                          <div className="px-3 py-3">
                            <MarkdownView markdown={c.body} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* New comment */}
                  <div className="mt-2 flex gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-acc-500/15 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20">
                      me
                    </span>
                    <div className="theme-surface min-w-0 flex-1 rounded-xl ring-1">
                      <div className="theme-divider border-b px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">
                        写评论
                      </div>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="讨论处置、复现、修复方案… 支持 Markdown"
                        rows={4}
                        className="w-full resize-y bg-transparent px-3 py-3 text-[13px] leading-6 text-zinc-200 outline-none placeholder:text-zinc-600"
                      />
                      <div className="theme-divider flex items-center justify-end gap-2 border-t px-3 py-2">
                        <button
                          type="button"
                          disabled={busy || !comment.trim()}
                          onClick={submitComment}
                          className="rounded-lg bg-acc-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40"
                        >
                          发表评论
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Collapsed technical */}
                <details className="theme-surface mt-8 rounded-xl ring-1">
                  <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] text-zinc-500 hover:text-zinc-300">
                    技术细节 · 验证运行 ({detail.verification_jobs.length}) · 原始 JSON · 语义事件 (
                    {detail.source_events.length})
                  </summary>
                  <div className="theme-divider space-y-4 border-t px-4 py-4">
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        验证运行
                      </div>
                      {detail.verification_jobs.length ? (
                        <div className="space-y-2">
                          {detail.verification_jobs.map((job) => (
                            <div
                              key={job.id}
                              className="theme-input-surface flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
                            >
                              <StatusBadge status={job.status} />
                              <span className="font-mono text-[11px] text-zinc-400">{job.type}</span>
                              <span className="ml-auto font-mono text-[10px] text-zinc-600">
                                {formatTime(job.started_at ?? job.created_at)}
                              </span>
                              {job.error && (
                                <MarkdownView markdown={job.error} className="w-full text-red-300" />
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[12px] text-zinc-600">尚未派生验证运行。</p>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        原始 Finding JSON
                      </div>
                      <pre className="theme-input-surface max-h-64 overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-5 text-zinc-500">
                        {JSON.stringify(f.raw_json, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        来源语义事件
                      </div>
                      <pre className="theme-input-surface max-h-64 overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-5 text-zinc-500">
                        {detail.source_events.length
                          ? detail.source_events.map((event) => JSON.stringify(event)).join("\n")
                          : "无"}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>

              {/* ── Sidebar: like GH issue meta ── */}
              <aside className="px-5 py-5 sm:px-6 lg:px-4">
                <SidebarField label="状态">
                  <div className="flex flex-col gap-1.5">
                    {DISPOSITION_OPTIONS.map((opt) => {
                      const active = (f.disposition ?? "open") === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={busy}
                          onClick={() => setDisposition(opt.value as FindingDisposition)}
                          className={`rounded-lg px-2.5 py-1.5 text-left text-[12px] ring-1 transition-colors disabled:opacity-50 ${
                            active
                              ? "bg-acc-500/15 text-acc-300 ring-acc-400/30"
                              : "theme-surface text-zinc-500 hover:opacity-90"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="状态备注（切换时一并保存）"
                    rows={2}
                    className="theme-input-surface mt-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none focus:border-acc-500"
                  />
                </SidebarField>

                <SidebarField label="技术验证">
                  <StatusBadge status={f.verify_status} />
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-600">
                    Agent / verify 给出，与人工状态独立。
                  </p>
                </SidebarField>

                <SidebarField label="严重度">
                  <SeverityBadge severity={f.severity} />
                </SidebarField>

                <SidebarField label="项目">
                  <span className="break-all text-[12px] text-zinc-300">
                    {f.project_name ?? f.project_id}
                  </span>
                </SidebarField>

                <SidebarField label="代码位置">
                  <span className="break-all font-mono text-[11px] text-zinc-400">
                    {f.location || "—"}
                  </span>
                </SidebarField>

                <SidebarField label="指纹">
                  <span className="break-all font-mono text-[11px] text-zinc-500">{f.fingerprint}</span>
                </SidebarField>

                <SidebarField label="来源运行">
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11px] text-zinc-400">
                      {f.source_job_type} · {f.source_job_status}
                    </span>
                    {f.canvas_id && (
                      <Link
                        to={`/projects/${f.project_id}/tasks/${f.canvas_id}?tab=jobs&job=${f.job_id}`}
                        className="inline-flex items-center gap-1 text-[12px] text-acc-300 hover:underline"
                      >
                        查看来源执行 <ArrowSquareOut size={12} />
                      </Link>
                    )}
                  </div>
                </SidebarField>

                <SidebarField label="关联链接">
                  <div className="space-y-2">
                    {links.length === 0 && (
                      <p className="text-[11px] text-zinc-600">无关联 issue / PR / 工单</p>
                    )}
                    {links.map((l) => (
                      <div
                        key={l.id}
                        className="theme-surface group flex items-start gap-1.5 rounded-lg px-2 py-1.5 ring-1"
                      >
                        <LinkIcon size={12} className="mt-0.5 shrink-0 text-zinc-600" />
                        <div className="min-w-0 flex-1">
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-[12px] text-acc-300 hover:underline"
                            title={l.url}
                          >
                            {l.title || l.url}
                          </a>
                          <div className="font-mono text-[9px] text-zinc-600">
                            {LINK_TYPE_LABEL[l.link_type] ?? l.link_type}
                            {l.created_by ? ` · ${l.created_by}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 hover:text-red-300 group-hover:opacity-100"
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await api.deleteFindingLink(findingId, l.id);
                              await reload();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Trash size={11} />
                        </button>
                      </div>
                    ))}
                    {!showLinkForm ? (
                      <button
                        type="button"
                        onClick={() => setShowLinkForm(true)}
                        className="text-[12px] text-zinc-500 hover:text-zinc-300"
                      >
                        + 添加链接
                      </button>
                    ) : (
                      <div className="theme-input-surface space-y-1.5 rounded-lg border p-2">
                        <input
                          value={linkUrl}
                          onChange={(e) => setLinkUrl(e.target.value)}
                          placeholder="https://…"
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 font-mono text-[11px] outline-none focus:border-acc-500"
                        />
                        <input
                          value={linkTitle}
                          onChange={(e) => setLinkTitle(e.target.value)}
                          placeholder="标题（可选）"
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 text-[11px] outline-none focus:border-acc-500"
                        />
                        <select
                          value={linkType}
                          onChange={(e) => setLinkType(e.target.value as FindingLink["link_type"])}
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 text-[11px] outline-none"
                        >
                          {LINK_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={busy || !linkUrl.trim()}
                            onClick={submitLink}
                            className="rounded-md bg-acc-500 px-2.5 py-1 text-[11px] font-medium text-ink-950 disabled:opacity-40"
                          >
                            添加
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowLinkForm(false)}
                            className="rounded-md px-2.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </SidebarField>
              </aside>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
