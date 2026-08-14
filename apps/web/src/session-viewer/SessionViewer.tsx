import { CaretDown, CaretRight, DownloadSimple } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  cacheHitRate,
  formatCacheHitRate,
  formatTokenCount,
  parseAgentSession,
  sessionCliLabel,
  type SessionItemKind,
  type SessionTimelineItem,
} from "./parseAgentSession";

type ViewerTab = "timeline" | "stats" | "raw";

export type SessionViewerProps = {
  text: string;
  truncated?: boolean;
  /** evidence.manifest.cli：claude-code / codex / open-code / pi / dsh */
  cli?: string | null;
  sessionId?: string | null;
  /** 数据来源说明，如「CLI Session 归档」或「过程流回退」 */
  sourceLabel?: string | null;
  onDownload?: () => void;
  downloadError?: string | null;
};

const KIND_STYLE: Record<SessionItemKind, { label: string; className: string }> = {
  user: { label: "用户", className: "bg-sky-500/15 text-sky-300 ring-sky-400/25" },
  assistant: { label: "助手", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25" },
  tool_call: { label: "工具", className: "bg-violet-500/15 text-violet-300 ring-violet-400/25" },
  tool_result: { label: "结果", className: "bg-amber-500/15 text-amber-300 ring-amber-400/25" },
  broadcast: { label: "广播", className: "bg-cyan-500/15 text-cyan-300 ring-cyan-400/25" },
  system: { label: "系统", className: "bg-zinc-500/15 text-zinc-300 ring-zinc-400/25" },
  usage: { label: "用量", className: "bg-cyan-500/15 text-cyan-300 ring-cyan-400/25" },
  other: { label: "其他", className: "bg-zinc-600/20 text-zinc-400 ring-zinc-500/20" },
};

function formatTs(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function ItemCard({ item }: { item: SessionTimelineItem }) {
  const [open, setOpen] = useState(item.kind === "user" || item.kind === "assistant");
  const style = KIND_STYLE[item.kind];
  const hasBody = Boolean(item.body?.trim());

  return (
    <li
      className={`theme-surface rounded-xl ring-1 ${item.isError ? "ring-red-400/30" : ""}`}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
        disabled={!hasBody}
      >
        <span className="mt-0.5 shrink-0 text-zinc-600">
          {hasBody ? (open ? <CaretDown size={12} /> : <CaretRight size={12} />) : <span className="inline-block w-3" />}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ring-1 ${style.className}`}>
          {style.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`text-[13px] ${item.isError ? "text-red-300" : "text-zinc-200"}`}>
              {item.title}
            </span>
            {item.toolName && (
              <span className="font-mono text-[10px] text-zinc-500">{item.toolName}</span>
            )}
            {item.timestamp && (
              <span className="font-mono text-[10px] text-zinc-600">{formatTs(item.timestamp)}</span>
            )}
          </div>
          {item.tokens && (
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
              in {formatTokenCount(item.tokens.input ?? 0)}
              {" · "}
              out {formatTokenCount(item.tokens.output ?? 0)}
              {(item.tokens.cacheRead ?? 0) > 0 && ` · cacheR ${formatTokenCount(item.tokens.cacheRead ?? 0)}`}
              {(item.tokens.cacheWrite ?? 0) > 0 && ` · cacheW ${formatTokenCount(item.tokens.cacheWrite ?? 0)}`}
              {(() => {
                const rate = cacheHitRate({
                  input: item.tokens.input ?? 0,
                  cacheRead: item.tokens.cacheRead ?? 0,
                  cacheWrite: item.tokens.cacheWrite ?? 0,
                });
                return rate != null && (item.tokens.cacheRead ?? 0) > 0
                  ? ` · hit ${formatCacheHitRate(rate)}`
                  : "";
              })()}
            </div>
          )}
          {!open && hasBody && (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-4 text-zinc-500">
              {item.body}
            </p>
          )}
        </div>
      </button>
      {open && hasBody && (
        <pre className="theme-input-surface mx-3 mb-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-[11px] leading-5 text-zinc-400">
          {item.body}
        </pre>
      )}
    </li>
  );
}

export function SessionViewer({
  text,
  truncated,
  cli,
  sessionId,
  sourceLabel,
  onDownload,
  downloadError,
}: SessionViewerProps) {
  const [tab, setTab] = useState<ViewerTab>("timeline");
  const [kindFilter, setKindFilter] = useState<SessionItemKind | "all">("all");

  const parsed = useMemo(() => parseAgentSession(text, { cli }), [text, cli]);
  const hitRate = useMemo(
    () => cacheHitRate({
      input: parsed.totals.input,
      cacheRead: parsed.totals.cacheRead,
      cacheWrite: parsed.totals.cacheWrite,
    }),
    [parsed.totals.input, parsed.totals.cacheRead, parsed.totals.cacheWrite],
  );

  const filteredItems = useMemo(() => {
    if (kindFilter === "all") return parsed.items;
    return parsed.items.filter((item) => item.kind === kindFilter);
  }, [parsed.items, kindFilter]);

  const counts = useMemo(() => {
    const map: Partial<Record<SessionItemKind, number>> = {};
    for (const item of parsed.items) {
      map[item.kind] = (map[item.kind] ?? 0) + 1;
    }
    return map;
  }, [parsed.items]);

  const tabs: Array<[ViewerTab, string]> = [
    ["timeline", `时间线 ${parsed.items.length}`],
    ["stats", `统计 ${parsed.tools.length}`],
    ["raw", "原始"],
  ];

  // 高度交给外层 Job 详情滚动区，避免 h-full 嵌套导致内容高度塌成 0
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-zinc-500">
          {sourceLabel ? `${sourceLabel} · ` : ""}
          {sessionCliLabel(cli ?? parsed.format)}
          {sessionId ? ` · session ${sessionId}` : ""}
          {parsed.format !== "unknown" && parsed.format !== normalizeForDisplay(cli) && !cli
            ? ` · 识别 ${parsed.format}`
            : ""}
        </span>
        <span className="font-mono text-[10px] text-zinc-600">
          解析 {parsed.totals.parsed}/{parsed.totals.lines}
          {parsed.totals.skipped > 0 ? ` · 跳过 ${parsed.totals.skipped}` : ""}
        </span>
        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            className="theme-surface ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] text-zinc-300 ring-1 hover:opacity-90"
          >
            <DownloadSimple size={13} /> 下载原始文件
          </button>
        )}
      </div>

      {downloadError && <p className="text-[11px] text-red-300">{downloadError}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <StatChip label="条目" value={String(parsed.items.length)} />
        <StatChip label="工具调用" value={String(counts.tool_call ?? 0)} />
        <StatChip
          label="输入 Token"
          value={formatTokenCount(parsed.totals.input)}
        />
        <StatChip
          label="输出 Token"
          value={formatTokenCount(parsed.totals.output)}
        />
        <StatChip
          label="缓存读"
          value={formatTokenCount(parsed.totals.cacheRead)}
          title="cache_read_input_tokens：从 prompt cache 命中读取"
        />
        <StatChip
          label="缓存写"
          value={formatTokenCount(parsed.totals.cacheWrite)}
          title="cache_creation_*：本轮写入/建立 cache；多为 0 表示沿用既有 cache"
        />
        <StatChip
          label="缓存命中率"
          value={formatCacheHitRate(hitRate)}
          title="cache_read / (input + cache_read + cache_write)"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1.5 text-[11px] ${
              tab === id
                ? "bg-acc-400/15 text-acc-300 ring-1 ring-acc-400/30"
                : "theme-surface text-zinc-400 ring-1 hover:opacity-90"
            }`}
          >
            {label}
          </button>
        ))}
        {tab === "timeline" && (
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as SessionItemKind | "all")}
            className="theme-input-surface ml-auto rounded-full border px-2 py-1 font-mono text-[10px] text-zinc-400"
            aria-label="按类型筛选"
          >
            <option value="all">全部类型</option>
            {(Object.keys(KIND_STYLE) as SessionItemKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_STYLE[kind].label}
                {counts[kind] ? ` (${counts[kind]})` : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0">
        {tab === "timeline" && (
          filteredItems.length ? (
            <ol className="space-y-2">
              {filteredItems.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </ol>
          ) : (
            <div className="theme-surface rounded-2xl p-8 text-center text-[13px] text-zinc-600 ring-1">
              {parsed.totals.lines === 0
                ? "Session 内容为空"
                : "未能解析出时间线条目；可切换「原始」查看或下载完整文件"}
            </div>
          )
        )}

        {tab === "stats" && (
          <div className="space-y-4">
            <section className="theme-surface rounded-2xl p-4 ring-1">
              <h3 className="mb-3 text-[12px] font-medium text-zinc-300">Token 汇总</h3>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <TokenStat label="输入" value={parsed.totals.input} />
                <TokenStat label="输出" value={parsed.totals.output} />
                <TokenStat label="缓存读" value={parsed.totals.cacheRead} />
                <TokenStat label="缓存写" value={parsed.totals.cacheWrite} />
                <div>
                  <dt className="font-mono text-[10px] text-zinc-600">缓存命中率</dt>
                  <dd className="font-mono text-[13px] text-zinc-200" title="cache_read / (input + cache_read + cache_write)">
                    {formatCacheHitRate(hitRate)}
                    {hitRate != null && (
                      <span className="ml-1 text-[10px] text-zinc-600">
                        ({formatTokenCount(parsed.totals.cacheRead)} / {formatTokenCount(parsed.totals.input + parsed.totals.cacheRead + parsed.totals.cacheWrite)})
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 font-mono text-[10px] leading-4 text-zinc-600">
                命中率 = 缓存读 / (输入 + 缓存读 + 缓存写)。数据来自 Session 中的 usage 字段；CLI 未报告缓存用量时显示 —。
              </p>
            </section>
            <section className="theme-surface rounded-2xl p-4 ring-1">
              <h3 className="mb-3 text-[12px] font-medium text-zinc-300">工具调用统计</h3>
              {parsed.tools.length ? (
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-600">
                      <th className="pb-2 font-medium">工具</th>
                      <th className="pb-2 font-medium">次数</th>
                      <th className="pb-2 font-medium">错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.tools.map((tool) => (
                      <tr key={tool.name} className="border-b border-zinc-900/80 last:border-0">
                        <td className="py-2 font-mono text-zinc-300">{tool.name}</td>
                        <td className="py-2 font-mono text-zinc-400">{tool.count}</td>
                        <td className={`py-2 font-mono ${tool.errors ? "text-red-300" : "text-zinc-600"}`}>
                          {tool.errors}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-[12px] text-zinc-600">未检测到工具调用</p>
              )}
            </section>
            <section className="theme-surface rounded-2xl p-4 ring-1">
              <h3 className="mb-3 text-[12px] font-medium text-zinc-300">条目类型</h3>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(KIND_STYLE) as SessionItemKind[]).map((kind) => {
                  const n = counts[kind] ?? 0;
                  if (!n) return null;
                  return (
                    <span
                      key={kind}
                      className={`rounded-full px-2.5 py-1 font-mono text-[10px] ring-1 ${KIND_STYLE[kind].className}`}
                    >
                      {KIND_STYLE[kind].label} {n}
                    </span>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "raw" && (
          <>
            <pre className="theme-input-surface max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-2xl border p-4 font-mono text-[11px] leading-5 text-zinc-400">
              {text}
            </pre>
            {truncated && (
              <p className="mt-2 text-[10px] text-amber-300">
                页面预览已截断，请下载完整原始文件。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function normalizeForDisplay(cli?: string | null): string {
  if (!cli) return "";
  return cli.trim().toLowerCase();
}

function StatChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="theme-surface rounded-xl px-3 py-2 ring-1" title={title}>
      <div className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
      <div className="mt-0.5 font-mono text-[14px] text-zinc-200">{value}</div>
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="font-mono text-[10px] text-zinc-600">{label}</dt>
      <dd className="font-mono text-[13px] text-zinc-200">
        {formatTokenCount(value)}
        <span className="ml-1 text-[10px] text-zinc-600">({value})</span>
      </dd>
    </div>
  );
}
