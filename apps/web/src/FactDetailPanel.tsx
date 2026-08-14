import { ArrowSquareOut, Briefcase, FileText, Link as LinkIcon, Prohibit, SealCheck, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api, type FactDetail } from "./api";
import { MarkdownView } from "./MarkdownView";
import { SeverityBadge, StatusBadge, formatTime } from "./ui";
import { useConfirmDialog } from "./components/ConfirmDialog";

function shortId(id: string): string {
  return id.slice(0, 8);
}

function EvidenceDatum({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9px] uppercase text-zinc-600">{label}</div>
      <div className="mt-1 break-all font-mono text-[11px] leading-5 text-zinc-300">{value || "—"}</div>
    </div>
  );
}

export function FactDetailPanel({
  canvasId,
  factId,
  onClose,
  onOpenFinding,
  onOpenJob,
}: {
  canvasId: string;
  factId: string;
  onClose: () => void;
  onOpenFinding: (findingId: string) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const confirm = useConfirmDialog();
  const [detail, setDetail] = useState<FactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [verificationAction, setVerificationAction] = useState<"verified" | "rejected" | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setActionError(null);
    setNotFound(false);
    try {
      setDetail(await api.fact(canvasId, factId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/-> 404(?:\D|$)/.test(message)) setNotFound(true);
      else setError(message);
      setDetail(null);
    }
  }, [canvasId, factId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="alertdialog"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const fact = detail?.fact;
  const finding = detail?.finding ?? null;
  const job = detail?.job ?? null;

  const resolveFact = async (status: "verified" | "rejected") => {
    const verified = status === "verified";
    if (!await confirm({
      title: verified ? "确认该事实？" : "排除该事实？",
      description: verified
        ? "确认后该 Fact 将标记为已验证，并继续由 Scheduler 推进收敛。"
        : "排除后该 Fact 将标记为 rejected；此操作不会把关联 Finding 技术确认为 confirmed。",
      confirmLabel: verified ? "确认事实" : "排除事实",
      tone: verified ? undefined : "danger",
    })) return;
    setVerificationAction(status);
    setActionError(null);
    try {
      await api.setFactVerification(canvasId, factId, status);
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVerificationAction(null);
    }
  };

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Fact 详情"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="theme-drawer flex h-full min-h-0 w-full min-w-0 flex-col border-l sm:max-w-[760px]">
        <header className="theme-drawer-header theme-divider shrink-0 border-b px-4 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
                <span>Fact</span>
                <span className="text-zinc-400">#{shortId(factId)}</span>
                {fact && <StatusBadge status={fact.verification_status} />}
              </div>
              <h1 className="mt-2 break-words text-[19px] font-semibold leading-7 text-zinc-50">
                {fact?.title ?? (notFound ? "Fact 不存在" : "加载中…")}
              </h1>
              {fact && (
                <p className="mt-1 break-all font-mono text-[10px] text-zinc-600">
                  创建于 {formatTime(fact.created_at)} · 更新于 {formatTime(fact.updated_at)}
                </p>
              )}
              {fact?.verification_status === "needs_human" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={verificationAction !== null}
                    onClick={() => void resolveFact("verified")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[11px] font-medium text-ink-950 disabled:opacity-40"
                  >
                    <SealCheck size={13} /> {verificationAction === "verified" ? "处理中…" : "确认事实"}
                  </button>
                  <button
                    type="button"
                    disabled={verificationAction !== null}
                    onClick={() => void resolveFact("rejected")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 ring-1 ring-red-400/25 disabled:opacity-40"
                  >
                    <Prohibit size={13} /> {verificationAction === "rejected" ? "处理中…" : "排除事实"}
                  </button>
                </div>
              )}
              {actionError && <p className="mt-3 break-words text-[12px] text-red-300">操作失败：{actionError}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="theme-surface flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {!fact && !notFound && !error && (
          <div className="flex flex-1 items-center justify-center p-8 font-mono text-sm text-zinc-600">
            正在读取 Fact…
          </div>
        )}

        {(notFound || error) && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="max-w-lg break-words text-sm text-red-300">
              {notFound ? "Fact 不存在或已从当前画布删除。" : `Fact 加载失败：${error}`}
            </p>
            {!notFound && (
              <button type="button" onClick={() => void load()} className="rounded-md bg-white/[.06] px-3 py-1.5 text-[12px] text-zinc-300 ring-1 ring-white/[.1]">
                重新加载
              </button>
            )}
          </div>
        )}

        {fact && detail && (
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
            <section aria-labelledby="fact-detail-heading">
              <div className="flex items-center gap-2">
                <FileText size={15} className="text-acc-400" />
                <h2 id="fact-detail-heading" className="text-[14px] font-medium text-zinc-200">详情</h2>
              </div>
              <div className="theme-surface mt-3 min-w-0 rounded-lg px-4 py-4 ring-1">
                {fact.description ? (
                  <MarkdownView markdown={fact.description} scrollable={false} />
                ) : (
                  <p className="text-[12px] text-zinc-600">无描述内容。</p>
                )}
              </div>
            </section>

            <section className="theme-divider mt-6 border-t pt-5" aria-labelledby="fact-evidence-heading">
              <div className="flex items-center gap-2">
                <LinkIcon size={15} className="text-acc-400" />
                <h2 id="fact-evidence-heading" className="text-[14px] font-medium text-zinc-200">结构化证据</h2>
              </div>
              {fact.verification ? (
                <div className="mt-3 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                  <EvidenceDatum label="证据类型" value={fact.verification.evidence_kind} />
                  <EvidenceDatum label="结论" value={fact.verification.outcome} />
                  <EvidenceDatum label="关联 Finding" value={fact.verification.finding_id} />
                  <EvidenceDatum label="主题版本" value={fact.verification.subject_revision} />
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-zinc-600">该 Fact 没有结构化验证证据。</p>
              )}

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {finding && (
                  <button
                    type="button"
                    onClick={() => onOpenFinding(finding.id)}
                    className="theme-surface flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 hover:opacity-90"
                  >
                    <ArrowSquareOut size={15} className="shrink-0 text-acc-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-zinc-200">{finding.title}</span>
                      <span className="mt-1 flex items-center gap-2"><SeverityBadge severity={finding.severity} /><StatusBadge status={finding.verify_status} /></span>
                    </span>
                  </button>
                )}
                {job && (
                  <button
                    type="button"
                    onClick={() => onOpenJob(job.id)}
                    className="theme-surface flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 hover:opacity-90"
                  >
                    <Briefcase size={15} className="shrink-0 text-acc-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-zinc-300">{job.type} · {shortId(job.id)}</span>
                      <span className="mt-1 block"><StatusBadge status={job.status} /></span>
                    </span>
                  </button>
                )}
              </div>
            </section>

            <section className="theme-divider mt-6 border-t pt-5" aria-labelledby="fact-trace-heading">
              <h2 id="fact-trace-heading" className="text-[14px] font-medium text-zinc-200">证据链路</h2>
              {detail.trace.nodes.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {detail.trace.nodes.map((node) => (
                    <div key={node.id} className="theme-surface min-w-0 rounded-lg px-3 py-2.5 ring-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-mono text-[10px] uppercase text-zinc-500">{node.node_type}</span>
                        {node.status && <StatusBadge status={node.status} />}
                        <span className="min-w-0 flex-1 break-words text-[12px] text-zinc-300">{node.title}</span>
                        {node.job_id && (
                          <button type="button" onClick={() => onOpenJob(node.job_id as string)} className="font-mono text-[10px] text-acc-400 hover:text-acc-300">
                            查看 Job
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <p className="break-words font-mono text-[10px] leading-5 text-zinc-600">
                    {detail.trace.edges.length} 条结构化边
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-zinc-600">当前没有可展示的结构化证据链路。</p>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
