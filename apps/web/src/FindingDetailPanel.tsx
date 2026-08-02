import { ArrowSquareOut, Link as LinkIcon, Trash, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type FindingComment,
  type FindingDetail,
  type FindingDisposition,
  type FindingLink,
} from "./api";
import { DISPOSITION_OPTIONS, SeverityBadge, StatusBadge, formatTime } from "./ui";

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
    setTimeout(() => setMsg(null), 2500);
  };

  const setDisposition = async (disposition: FindingDisposition) => {
    setBusy(true);
    try {
      await api.setFindingDisposition(findingId, {
        disposition,
        note: note.trim() || undefined,
      });
      flash("处置状态已更新");
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
        flash("评论已添加，已唤醒 Hub 决策是否开新一轮");
      } else if (
        f &&
        (f.verify_status === "confirmed" || f.disposition === "confirmed_vuln") &&
        r.hub?.reason === "hub_paused"
      ) {
        flash("评论已添加；画布已暂停决策，Hub 未启动");
      } else if (f && (f.verify_status === "confirmed" || f.disposition === "confirmed_vuln")) {
        flash(`评论已添加；Hub 未入队（${r.hub?.reason ?? "unknown"}）`);
      } else {
        flash("评论已添加（仅 confirmed 会触发 Hub 再决策）");
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
      flash("链接已关联");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const f = detail?.finding;
  const comments: FindingComment[] = detail?.comments ?? [];
  const links: FindingLink[] = detail?.links ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="发现详情"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="h-full w-full max-w-[760px] overflow-y-auto border-l border-white/[.08] bg-[#0b0f12] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/[.06] bg-[#0b0f12]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-zinc-600">Finding evidence</div>
            <div className="mt-1 truncate text-[15px] font-medium text-zinc-100">
              {f?.title ?? "加载发现详情…"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭发现详情"
            className="flex size-9 items-center justify-center rounded-full text-zinc-500 ring-1 ring-white/[.08] hover:bg-white/[.05] hover:text-white"
          >
            <X size={16} />
          </button>
        </header>

        {msg && <div className="mx-5 mt-4 font-mono text-[12px] text-acc-400">{msg}</div>}
        {error && (
          <div className="m-5 rounded-xl bg-red-950/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-400/20">
            {error}
          </div>
        )}
        {!error && !f && <div className="p-8 font-mono text-sm text-zinc-600">正在读取完整证据…</div>}
        {f && detail && (
          <div className="space-y-5 p-5">
            <section className="rounded-2xl bg-white/[.025] p-5 ring-1 ring-white/[.06]">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <StatusBadge status={f.verify_status} />
                <StatusBadge status={f.disposition ?? "open"} />
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{formatTime(f.created_at)}</span>
              </div>
              <h2 className="mt-4 text-xl font-medium leading-8 text-zinc-100">{f.title}</h2>
              {f.summary && (
                <p className="mt-3 whitespace-pre-wrap text-[14px] leading-7 text-zinc-400">{f.summary}</p>
              )}
              {f.disposition_by && (
                <p className="mt-3 font-mono text-[11px] text-zinc-600">
                  处置：{f.disposition} · {f.disposition_by}
                  {f.disposition_at ? ` · ${formatTime(f.disposition_at)}` : ""}
                </p>
              )}
            </section>

            {/* 人工处置 */}
            <section className="rounded-2xl bg-white/[.02] p-4 ring-1 ring-white/[.06]">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                处置状态
              </h3>
              <p className="mb-3 text-[11px] leading-5 text-zinc-600">
                技术验证（上方徽章）由 Agent 给出；此处是任务完成后的人工闭环：接受、确认漏洞、误报、处理完成或归档。
              </p>
              <div className="flex flex-wrap gap-2">
                {DISPOSITION_OPTIONS.map((opt) => {
                  const active = (f.disposition ?? "open") === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={busy}
                      onClick={() => setDisposition(opt.value as FindingDisposition)}
                      className={`rounded-full px-3 py-1.5 text-[12px] ring-1 transition-colors disabled:opacity-50 ${
                        active
                          ? "bg-acc-500/15 text-acc-300 ring-acc-400/30"
                          : "bg-white/[.03] text-zinc-400 ring-white/[.08] hover:text-zinc-200"
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
                placeholder="处置备注（可选，切换状态时一并保存）"
                rows={2}
                className="mt-3 w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-acc-500"
              />
            </section>

            {/* 关联链接 */}
            <section className="rounded-2xl bg-white/[.02] p-4 ring-1 ring-white/[.06]">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                关联链接
              </h3>
              <div className="space-y-2">
                {links.length === 0 && <p className="text-[12px] text-zinc-600">暂无关联</p>}
                {links.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center gap-2 rounded-xl bg-black/20 px-3 py-2 ring-1 ring-white/[.04]"
                  >
                    <LinkIcon size={14} className="shrink-0 text-zinc-500" />
                    <div className="min-w-0 flex-1">
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-[13px] text-acc-300 hover:underline"
                      >
                        {l.title || l.url}
                      </a>
                      <div className="font-mono text-[10px] text-zinc-600">
                        {l.link_type}
                        {l.created_by ? ` · ${l.created_by}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded p-1 text-zinc-600 hover:text-red-300"
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
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_120px]">
                <input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://…"
                  className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[12px] text-zinc-200"
                />
                <select
                  value={linkType}
                  onChange={(e) => setLinkType(e.target.value)}
                  className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-2 text-[12px] text-zinc-300"
                >
                  <option value="related">相关</option>
                  <option value="ticket">工单</option>
                  <option value="pr">PR</option>
                  <option value="doc">文档</option>
                  <option value="evidence">证据</option>
                </select>
                <input
                  value={linkTitle}
                  onChange={(e) => setLinkTitle(e.target.value)}
                  placeholder="标题（可选）"
                  className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] text-zinc-200 sm:col-span-2"
                />
                <button
                  type="button"
                  disabled={busy || !linkUrl.trim()}
                  onClick={submitLink}
                  className="rounded-lg bg-white/[.06] px-3 py-2 text-[12px] text-zinc-200 ring-1 ring-white/[.08] disabled:opacity-40 sm:col-span-2"
                >
                  添加链接
                </button>
              </div>
            </section>

            {/* 评论 */}
            <section className="rounded-2xl bg-white/[.02] p-4 ring-1 ring-white/[.06]">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                评论 ({comments.length})
              </h3>
              <p className="mb-3 text-[11px] leading-5 text-zinc-600">
                对<strong className="text-zinc-400">已确认（confirmed）</strong>
                的 Finding 发表评论后，会写入画布并唤醒 Hub：由 Hub 判断是否 complete，或下发新一轮
                intent。未确认的 Finding 仅记录评论。
              </p>
              <div className="space-y-3">
                {comments.length === 0 && <p className="text-[12px] text-zinc-600">暂无评论</p>}
                {comments.map((c) => (
                  <div key={c.id} className="rounded-xl bg-black/20 px-3 py-2.5 ring-1 ring-white/[.04]">
                    <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-600">
                      <span className="text-zinc-400">{c.author_name || "anonymous"}</span>
                      <span className="ml-auto">{formatTime(c.created_at)}</span>
                      <button
                        type="button"
                        className="text-zinc-600 hover:text-red-300"
                        disabled={busy}
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
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-zinc-300">{c.body}</p>
                  </div>
                ))}
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="写下评论…"
                rows={3}
                className="mt-3 w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-acc-500"
              />
              <button
                type="button"
                disabled={busy || !comment.trim()}
                onClick={submitComment}
                className="mt-2 rounded-lg bg-acc-500 px-3 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40"
              >
                发表评论
              </button>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              {[
                ["项目", f.project_name ?? f.project_id],
                ["代码位置", f.location || "未提供"],
                ["指纹", f.fingerprint],
                ["来源运行", `${f.source_job_type} · ${f.source_job_status}`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-white/[.02] p-4 ring-1 ring-white/[.05]">
                  <div className="font-mono text-[9px] uppercase tracking-[.16em] text-zinc-600">{label}</div>
                  <div className="mt-2 break-all font-mono text-[12px] leading-5 text-zinc-300">{value}</div>
                </div>
              ))}
            </section>

            {f.canvas_id && (
              <Link
                to={`/projects/${f.project_id}/tasks/${f.canvas_id}?tab=jobs&job=${f.job_id}`}
                className="inline-flex items-center gap-2 rounded-full bg-acc-500/[.08] px-4 py-2 text-[12px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.14]"
              >
                查看来源执行过程 <ArrowSquareOut size={14} />
              </Link>
            )}

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                验证运行 ({detail.verification_jobs.length})
              </h3>
              {detail.verification_jobs.length ? (
                <div className="space-y-2">
                  {detail.verification_jobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex flex-wrap items-center gap-3 rounded-xl bg-white/[.02] px-4 py-3 ring-1 ring-white/[.05]"
                    >
                      <StatusBadge status={job.status} />
                      <span className="font-mono text-[11px] text-zinc-400">{job.type}</span>
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">
                        {formatTime(job.started_at ?? job.created_at)}
                      </span>
                      {job.error && (
                        <div className="w-full font-mono text-[11px] text-red-300">{job.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-zinc-600">尚未派生验证运行。</p>
              )}
            </section>

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                原始 Finding JSON
              </h3>
              <pre className="max-h-[420px] overflow-auto rounded-2xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-zinc-400 ring-1 ring-white/[.06]">
                {JSON.stringify(f.raw_json, null, 2)}
              </pre>
            </section>

            <section>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.18em] text-zinc-500">
                来源语义事件 ({detail.source_events.length})
              </h3>
              <pre className="max-h-[420px] overflow-auto rounded-2xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-zinc-500 ring-1 ring-white/[.06]">
                {detail.source_events.map((event) => JSON.stringify(event)).join("\n")}
              </pre>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
