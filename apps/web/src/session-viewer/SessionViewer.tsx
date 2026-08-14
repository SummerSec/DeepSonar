import { Copy, DownloadSimple } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import "./SessionViewer.css";
import { MarkdownView } from "../MarkdownView";
import {
  cacheHitRate,
  formatCacheHitRate,
  formatTokenCount,
  parseAgentSession,
  sessionCliLabel,
  type SessionItemKind,
  type SessionTimelineItem,
} from "./parseAgentSession";
import {
  buildSessionLedger,
  filterSessionLedger,
  sessionLedgerTurnCount,
  sessionViewerWorkspaceMode,
  type SessionLedgerRow,
} from "./sessionViewerModel";

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
  user: { label: "用户", className: "kind-user" },
  assistant: { label: "助手", className: "kind-assistant" },
  tool_call: { label: "工具", className: "kind-tool_call" },
  tool_result: { label: "结果", className: "kind-tool_result" },
  broadcast: { label: "广播", className: "kind-broadcast" },
  system: { label: "系统", className: "kind-system" },
  usage: { label: "用量", className: "kind-usage" },
  other: { label: "其他", className: "kind-other" },
};

function formatTs(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatIndex(value: number): string {
  return `#${String(value).padStart(3, "0")}`;
}

function tokenLine(tokens: SessionTimelineItem["tokens"]): string {
  if (!tokens) return "";
  const parts = [
    `in ${formatTokenCount(tokens.input ?? 0)}`,
    `out ${formatTokenCount(tokens.output ?? 0)}`,
  ];
  if ((tokens.cacheRead ?? 0) > 0) parts.push(`cacheR ${formatTokenCount(tokens.cacheRead ?? 0)}`);
  if ((tokens.cacheWrite ?? 0) > 0) parts.push(`cacheW ${formatTokenCount(tokens.cacheWrite ?? 0)}`);
  return parts.join(" · ");
}

function tokenChips(tokens: SessionTimelineItem["tokens"]): Array<[string, number]> {
  if (!tokens) return [];
  return [
    ["in", tokens.input ?? 0],
    ["out", tokens.output ?? 0],
    ["cacheR", tokens.cacheRead ?? 0],
    ["cacheW", tokens.cacheWrite ?? 0],
  ];
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document.execCommand !== "function" || !document.body) {
    throw new Error("CLIPBOARD_UNAVAILABLE");
  }

  const textarea = document.createElement("textarea");
  const activeElement = document.activeElement as HTMLElement | null;
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("CLIPBOARD_DENIED");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

function LedgerRow({
  row,
  selected,
  turnCount,
  onSelect,
}: {
  row: SessionLedgerRow;
  selected: boolean;
  turnCount: number;
  onSelect: () => void;
}) {
  const { item } = row;
  const style = KIND_STYLE[item.kind];
  const preview = item.body?.trim();

  return (
    <>
      {row.turnStart && (
        <li className="session-viewer__turn-divider" aria-label={`Turn ${row.turn}`}>
          <span className="session-viewer__turn-label">TURN {String(row.turn).padStart(2, "0")}</span>
          <span className="session-viewer__turn-count">{turnCount} events</span>
        </li>
      )}
      <li>
        <button
          type="button"
          className={`session-viewer__row${selected ? " is-selected" : ""}${item.isError ? " is-error" : ""}`}
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`${formatIndex(row.index)} ${style.label} ${item.title}`}
        >
          <span className="session-viewer__row-index">{formatIndex(row.index)}</span>
          <span className="session-viewer__row-content">
            <span className="session-viewer__row-head">
              <span className={`session-viewer__kind-tag ${style.className}`}>{style.label}</span>
              <span className="session-viewer__row-title">{item.title}</span>
              {item.toolName && <span className="session-viewer__tool-name">{item.toolName}</span>}
              {item.timestamp && <span className="session-viewer__row-time">{formatTs(item.timestamp)}</span>}
              <span className="session-viewer__row-step">S{row.step}</span>
            </span>
            {preview && <span className="session-viewer__row-preview">{preview}</span>}
            {item.tokens && <span className="session-viewer__token-line">{tokenLine(item.tokens)}</span>}
          </span>
        </button>
      </li>
    </>
  );
}

function Inspector({
  row,
  onClear,
}: {
  row: SessionLedgerRow;
  onClear: () => void;
}) {
  const { item } = row;
  const style = KIND_STYLE[item.kind];
  const detail = item.body?.trim() ?? "";
  const body = detail || "（无正文）";
  const [copyFeedback, setCopyFeedback] = useState("");
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    setCopyFeedback("");
    setShowSource(false);
  }, [row.index]);

  useEffect(() => {
    if (!copyFeedback) return;
    const timeout = window.setTimeout(() => setCopyFeedback(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  const copyDetail = async () => {
    if (!detail) {
      setCopyFeedback("没有可复制的详情");
      return;
    }
    try {
      await writeClipboard(detail);
      setCopyFeedback("已复制详情");
    } catch (error) {
      const denied = (error instanceof DOMException && error.name === "NotAllowedError")
        || (error instanceof Error && error.message === "CLIPBOARD_DENIED");
      setCopyFeedback(denied ? "复制失败：浏览器未授予剪贴板权限" : "复制失败：当前浏览器不支持剪贴板");
    }
  };

  return (
    <aside className="session-viewer__inspector" aria-label="Session 条目检查器">
      <header className="session-viewer__inspector-header">
        <div className="session-viewer__inspector-title">
          <strong>{item.title}</strong>
          <small>{formatIndex(row.index)} · {style.label} · turn {row.turn} / step {row.step}</small>
        </div>
        <div className="session-viewer__inspector-actions">
          <button
            type="button"
            className="session-viewer__inspector-source"
            onClick={() => setShowSource((value) => !value)}
            title={showSource ? "显示 Markdown 渲染结果" : "查看未渲染原文"}
            aria-label={showSource ? "渲染" : "原文"}
            aria-pressed={showSource}
          >
            {showSource ? "渲染" : "原文"}
          </button>
          <button
            type="button"
            className="session-viewer__inspector-copy"
            onClick={() => void copyDetail()}
            title="复制详情内容"
            aria-label="复制详情内容"
          >
            <Copy size={12} /> 复制
          </button>
          <button type="button" className="session-viewer__search-clear" onClick={onClear} aria-label="关闭检查器">×</button>
        </div>
      </header>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`session-viewer__inspector-feedback${copyFeedback ? " is-visible" : ""}${copyFeedback.startsWith("复制失败") ? " is-error" : ""}`}
      >
        {copyFeedback}
      </span>
      <div className="session-viewer__inspector-meta">
        <span><span className="session-viewer__inspector-label">kind</span><span className={`session-viewer__kind-tag ${style.className}`}>{item.kind}</span></span>
        {item.toolName && <span><span className="session-viewer__inspector-label">tool</span><span className="session-viewer__inspector-value">{item.toolName}</span></span>}
        {item.timestamp && <span><span className="session-viewer__inspector-label">time</span><span className="session-viewer__inspector-value">{formatTs(item.timestamp)}</span></span>}
        <span><span className="session-viewer__inspector-label">id</span><span className="session-viewer__inspector-value">{item.id}</span></span>
      </div>
      {showSource ? (
        <pre className="session-viewer__inspector-source-body">{body}</pre>
      ) : (
        <div className="session-viewer__inspector-markdown">
          <MarkdownView markdown={body} controls={false} scrollable={false} />
        </div>
      )}
      {item.tokens && (
        <div className="session-viewer__token-grid" aria-label="Token 明细">
          {tokenChips(item.tokens).map(([label, value]) => (
            <span key={label} className="session-viewer__token-chip">{label} <strong>{formatTokenCount(value)}</strong></span>
          ))}
        </div>
      )}
    </aside>
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
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const parsed = useMemo(() => parseAgentSession(text, { cli }), [text, cli]);
  const rows = useMemo(() => buildSessionLedger(parsed.items), [parsed.items]);
  const filteredRows = useMemo(
    () => filterSessionLedger(rows, { kind: kindFilter, query }),
    [rows, kindFilter, query],
  );
  const selectedRow = useMemo(
    () => rows.find((row) => row.index === selectedIndex),
    [rows, selectedIndex],
  );
  const workspaceMode = sessionViewerWorkspaceMode(Boolean(selectedRow));
  const hitRate = useMemo(
    () => cacheHitRate({
      input: parsed.totals.input,
      cacheRead: parsed.totals.cacheRead,
      cacheWrite: parsed.totals.cacheWrite,
    }),
    [parsed.totals.input, parsed.totals.cacheRead, parsed.totals.cacheWrite],
  );

  const counts = useMemo(() => {
    const map: Partial<Record<SessionItemKind, number>> = {};
    for (const item of parsed.items) map[item.kind] = (map[item.kind] ?? 0) + 1;
    return map;
  }, [parsed.items]);

  const turnCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of rows) map.set(row.turn, (map.get(row.turn) ?? 0) + 1);
    return map;
  }, [rows]);

  const tabs: Array<[ViewerTab, string]> = [
    ["timeline", `账本 ${parsed.items.length}`],
    ["stats", `统计 ${parsed.tools.length}`],
    ["raw", "原始记录"],
  ];

  return (
    <div className="session-viewer flex min-h-0 flex-col gap-3">
      <div className="session-viewer__header">
        <span className="session-viewer__eyebrow">
          {sourceLabel ? `${sourceLabel} · ` : ""}
          {sessionCliLabel(cli ?? parsed.format)}
          {sessionId ? ` · session ${sessionId}` : ""}
          {!cli && parsed.format !== "unknown" ? ` · 识别 ${parsed.format}` : ""}
        </span>
        <span className="session-viewer__counter">
          parsed {parsed.totals.parsed}/{parsed.totals.lines}
          {parsed.totals.skipped > 0 ? ` · skipped ${parsed.totals.skipped}` : ""}
        </span>
        {onDownload && (
          <button type="button" onClick={onDownload} className="session-viewer__download">
            <DownloadSimple size={13} /> 下载原始文件
          </button>
        )}
      </div>

      {downloadError && <p className="session-viewer__error">{downloadError}</p>}

      <div className="session-viewer__stats">
        <StatChip label="条目" value={String(parsed.items.length)} />
        <StatChip label="工具调用" value={String(counts.tool_call ?? 0)} />
        <StatChip label="输入 Token" value={formatTokenCount(parsed.totals.input)} />
        <StatChip label="输出 Token" value={formatTokenCount(parsed.totals.output)} />
        <StatChip label="缓存读" value={formatTokenCount(parsed.totals.cacheRead)} title="cache_read_input_tokens" />
        <StatChip label="缓存写" value={formatTokenCount(parsed.totals.cacheWrite)} title="cache_creation_*" />
        <StatChip label="缓存命中率" value={formatCacheHitRate(hitRate)} title="cache_read / (input + cache_read + cache_write)" />
      </div>

      <div className="session-viewer__tabbar" role="tablist" aria-label="Session 视图">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`session-viewer__tab${tab === id ? " is-active" : ""}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "timeline" && (
        <>
          <div className="session-viewer__toolbar" role="search">
            <label className="session-viewer__search">
              <span className="session-viewer__search-label">FIND</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 event / content / tool"
                aria-label="搜索 Session 条目"
              />
              {query && (
                <button type="button" className="session-viewer__search-clear" onClick={() => setQuery("")} aria-label="清除搜索">×</button>
              )}
            </label>
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as SessionItemKind | "all")}
              className="session-viewer__filter"
              aria-label="按类型筛选"
            >
              <option value="all">全部事件</option>
              {(Object.keys(KIND_STYLE) as SessionItemKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_STYLE[kind].label}{counts[kind] ? ` (${counts[kind]})` : ""}
                </option>
              ))}
            </select>
            <span className="session-viewer__toolbar-count">
              {filteredRows.length}/{rows.length} rows · {sessionLedgerTurnCount(rows)} turns
            </span>
          </div>

          <div className={`session-viewer__workspace${workspaceMode === "split" ? " has-inspector" : ""}`}>
            <section className="session-viewer__ledger" aria-label="Session event ledger">
              {filteredRows.length ? (
                <div className="session-viewer__ledger-scroll">
                  <ol className="session-viewer__ledger-list">
                    {filteredRows.map((row) => (
                      <LedgerRow
                        key={row.item.id || row.index}
                        row={row}
                        selected={row.index === selectedIndex}
                        turnCount={turnCounts.get(row.turn) ?? 0}
                        onSelect={() => setSelectedIndex(row.index)}
                      />
                    ))}
                  </ol>
                </div>
              ) : (
                <div className="session-viewer__empty-state">
                  <strong>{parsed.totals.lines === 0 ? "Session 内容为空" : "没有匹配的事件"}</strong>
                  <p>{parsed.totals.lines === 0 ? "可切换 RAW 查看原始归档。" : "调整搜索词或类型筛选后重试。"}</p>
                </div>
              )}
            </section>
            {selectedRow && <Inspector row={selectedRow} onClear={() => setSelectedIndex(null)} />}
          </div>
        </>
      )}

      {tab === "stats" && (
        <div className="session-viewer__stats-pane">
          <section className="session-viewer__stats-card">
            <h3>Token 汇总</h3>
            <dl className="session-viewer__token-summary">
              <TokenStat label="输入" value={parsed.totals.input} />
              <TokenStat label="输出" value={parsed.totals.output} />
              <TokenStat label="缓存读" value={parsed.totals.cacheRead} />
              <TokenStat label="缓存写" value={parsed.totals.cacheWrite} />
              <div>
                <dt>缓存命中率</dt>
                <dd>
                  {formatCacheHitRate(hitRate)}
                  {hitRate != null && <small> ({formatTokenCount(parsed.totals.cacheRead)} / {formatTokenCount(parsed.totals.input + parsed.totals.cacheRead + parsed.totals.cacheWrite)})</small>}
                </dd>
              </div>
            </dl>
            <p className="session-viewer__note">命中率 = 缓存读 / (输入 + 缓存读 + 缓存写)。数据来自 Session 中的 usage 字段；CLI 未报告缓存用量时显示 —。</p>
          </section>
          <section className="session-viewer__stats-card">
            <h3>工具调用统计</h3>
            {parsed.tools.length ? (
              <table className="session-viewer__table">
                <thead><tr><th>工具</th><th>次数</th><th>错误</th></tr></thead>
                <tbody>
                  {parsed.tools.map((tool) => (
                    <tr key={tool.name}><td>{tool.name}</td><td>{tool.count}</td><td>{tool.errors}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="session-viewer__note">未检测到工具调用</p>}
          </section>
          <section className="session-viewer__stats-card">
            <h3>条目类型</h3>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(KIND_STYLE) as SessionItemKind[]).map((kind) => {
                const count = counts[kind] ?? 0;
                if (!count) return null;
                return <span key={kind} className={`session-viewer__kind-tag ${KIND_STYLE[kind].className}`}>{KIND_STYLE[kind].label} {count}</span>;
              })}
            </div>
          </section>
        </div>
      )}

      {tab === "raw" && (
        <div className="session-viewer__raw">
          <div className="session-viewer__raw-header">
            <span className="session-viewer__raw-title">RAW ARCHIVE</span>
            <span className="session-viewer__raw-meta">{text.length.toLocaleString()} chars · 未改写</span>
          </div>
          <pre>{text}</pre>
          {truncated && <p className="session-viewer__truncated">页面预览已截断，请下载完整原始文件。</p>}
        </div>
      )}
    </div>
  );
}

function StatChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="session-viewer__stat" title={title}><div className="session-viewer__stat-label">{label}</div><div className="session-viewer__stat-value">{value}</div></div>;
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{formatTokenCount(value)} <small>({value})</small></dd></div>;
}
