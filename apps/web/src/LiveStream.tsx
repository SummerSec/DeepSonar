import { CircleNotch, Check, Funnel, Wrench, TextAlignLeft, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StreamPage } from "./api";
import { MarkdownView } from "./MarkdownView";

/**
 * Agent 实时流视图（§6.2：原始流只过 WS 过手，不落 DB）
 * - 连接 /api/ws?job_id=...，先收环形缓冲补发，随后实时推送
 * - text.delta 合并为流式段落；tool.call.* 渲染为动作卡片；reasoning 暗色斜体
 * - 支持按类型筛选 + 关键词过滤（与运行详情过程视图一致）
 */

export interface StreamItem {
  type: string;
  attempt_id?: string;
  seq: number;
  at: number;
  cursor?: string;
  delta?: string;
  toolName?: string;
  action?: string;
  text?: string;
}

/** 渲染单元：text 段落会随 delta 追加增长；tool 卡片 started→completed 置完成态 */
export type StreamBlock =
  | { kind: "text"; key: string; text: string; reasoning: boolean }
  | { kind: "tool"; key: string; name: string; action: string; done: boolean }
  | { kind: "meta"; key: string; text: string };

export type StreamKindFilter = "all" | "text" | "tool" | "meta";

export function reduceStreamItem(blocks: StreamBlock[], item: StreamItem): StreamBlock[] {
  const key = String(item.seq);
  if (item.type === "text.delta" || item.type === "reasoning.delta") {
    const reasoning = item.type === "reasoning.delta";
    const last = blocks[blocks.length - 1];
    if (last?.kind === "text" && last.reasoning === reasoning) {
      return [...blocks.slice(0, -1), { ...last, text: last.text + (item.delta ?? "") }];
    }
    return [...blocks, { kind: "text", key, text: item.delta ?? "", reasoning }];
  }
  if (item.type === "tool.call.started") {
    return [
      ...blocks,
      { kind: "tool", key, name: item.toolName ?? "tool", action: item.action ?? "", done: false },
    ];
  }
  if (item.type === "tool.call.completed") {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "tool" && !b.done) {
        return [...blocks.slice(0, i), { ...b, done: true }, ...blocks.slice(i + 1)];
      }
    }
    return blocks;
  }
  if (item.type === "run.started") return [...blocks, { kind: "meta", key, text: "agent 开始运行" }];
  if (item.type === "run.completed") return [...blocks, { kind: "meta", key, text: "运行结束" }];
  if (item.type === "run.error") return [...blocks, { kind: "meta", key, text: `运行出错：${item.text ?? ""}` }];
  return blocks;
}

/** 将持久化 stream 记录还原为与实时流相同的 block 列表 */
export function recordsToStreamBlocks(records: Array<Record<string, unknown>>): StreamBlock[] {
  let blocks: StreamBlock[] = [];
  for (const record of records) {
    const payload =
      record.payload_json && typeof record.payload_json === "object"
        ? (record.payload_json as Record<string, unknown>)
        : record;
    const type = String(record.type ?? payload.type ?? "");
    const item: StreamItem = {
      type,
      seq: Number(record.seq ?? record.job_seq ?? blocks.length + 1),
      at: Number(record.at ?? record.ts ?? Date.now()),
      delta: typeof payload.delta === "string" ? payload.delta : undefined,
      toolName: typeof payload.toolName === "string" ? payload.toolName : typeof payload.tool_name === "string" ? payload.tool_name : undefined,
      action: typeof payload.action === "string" ? payload.action : typeof payload.message === "string" ? payload.message : undefined,
      text:
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.message === "string"
            ? payload.message
            : undefined,
    };
    // 非标准帧：尽量落到 text/meta
    if (
      !type.includes("delta") &&
      !type.startsWith("tool.") &&
      !type.startsWith("run.") &&
      !type.startsWith("text") &&
      !type.startsWith("reasoning")
    ) {
      const text =
        [payload.message, payload.text, payload.summary, payload.title]
          .find((v): v is string => typeof v === "string" && v.trim().length > 0) ??
        JSON.stringify(payload);
      blocks = [...blocks, { kind: "meta", key: String(item.seq), text: `${type}: ${text}` }];
      continue;
    }
    blocks = reduceStreamItem(blocks, item);
  }
  return blocks;
}

export function filterStreamBlocks(
  blocks: StreamBlock[],
  kind: StreamKindFilter,
  query: string,
): StreamBlock[] {
  const needle = query.trim().toLowerCase();
  return blocks.filter((b) => {
    if (kind !== "all" && b.kind !== kind) return false;
    if (!needle) return true;
    if (b.kind === "text") return b.text.toLowerCase().includes(needle);
    if (b.kind === "tool") return `${b.name} ${b.action}`.toLowerCase().includes(needle);
    return b.text.toLowerCase().includes(needle);
  });
}

const KIND_OPTIONS: { value: StreamKindFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "tool", label: "工具" },
  { value: "meta", label: "系统" },
];

/** 过程流筛选条 + 列表（实时 / 归档共用） */
export function ProcessStreamView({
  blocks,
  live,
  connected,
  emptyHint,
}: {
  blocks: StreamBlock[];
  live?: boolean;
  connected?: boolean;
  emptyHint?: string;
}) {
  const [kind, setKind] = useState<StreamKindFilter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterStreamBlocks(blocks, kind, query), [blocks, kind, query]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="flex h-full min-h-[320px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[.06] px-3 py-2">
        {live && (
          <>
            <span
              className={`inline-block size-1.5 rounded-full ${connected ? "deepsonar-live-dot bg-acc-500" : "bg-zinc-600"}`}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">
              {connected ? "live" : "已断开"}
            </span>
            <span className="mx-0.5 h-3 w-px bg-white/[.08]" />
          </>
        )}
        <Funnel size={12} className="shrink-0 text-zinc-600" />
        <div className="flex flex-wrap gap-1">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setKind(opt.value)}
              className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
                kind === opt.value
                  ? "bg-white/[.1] text-zinc-100"
                  : "text-zinc-500 hover:bg-white/[.04] hover:text-zinc-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索执行过程"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文本 / 工具…"
          className="min-h-8 min-w-[8rem] flex-1 rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 ring-1 ring-white/[.08] placeholder:text-zinc-700"
        />
        {(kind !== "all" || query) && (
          <button
            type="button"
            onClick={() => {
              setKind("all");
              setQuery("");
            }}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] hover:text-zinc-200"
          >
            <X size={10} /> 清除
          </button>
        )}
        <span className="font-mono text-[10px] text-zinc-600">
          {visible.length}/{blocks.length}
        </span>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
          >
            回到底部
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        {blocks.length === 0 && (
          <div className="py-8 text-center font-mono text-[13px] text-zinc-600">
            {emptyHint ?? "等待 agent 事件…"}
          </div>
        )}
        {blocks.length > 0 && visible.length === 0 && (
          <div className="py-8 text-center font-mono text-[13px] text-zinc-600">没有匹配当前筛选的过程</div>
        )}
        {visible.map((b) => {
          if (b.kind === "text") {
            return b.reasoning ? (
              <MarkdownView
                key={b.key}
                markdown={b.text}
                controls={false}
                className="mb-2 font-mono italic text-zinc-600"
              />
            ) : (
              <MarkdownView key={b.key} markdown={b.text} controls={false} className="mb-2" />
            );
          }
          if (b.kind === "tool") {
            return (
              <div
                key={b.key}
                className="mb-1.5 flex items-center gap-2 rounded-md border border-ink-800 bg-ink-850 px-2.5 py-1.5"
              >
                {b.done ? (
                  <Check size={12} className="shrink-0 text-acc-400" />
                ) : (
                  <CircleNotch size={12} className="shrink-0 animate-spin text-run-400" />
                )}
                <Wrench size={11} className="shrink-0 text-zinc-600" />
                <span className="truncate font-mono text-[13px] text-zinc-300">{b.action || b.name}</span>
              </div>
            );
          }
          return (
            <div key={b.key} className="mb-2 flex items-center gap-1.5 font-mono text-[12px] text-zinc-600">
              <TextAlignLeft size={11} />
              {b.text}
            </div>
          );
        })}
        {live && blocks.length > 0 && blocks[blocks.length - 1]?.kind === "text" && (
          <span className="inline-block h-3 w-1.5 animate-pulse bg-acc-500/70" />
        )}
      </div>
    </div>
  );
}

export function LiveStream({ jobId, active }: { jobId: string; active: boolean }) {
  const [blocks, setBlocks] = useState<StreamBlock[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("正在申请实时流凭证…");

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;
    let retry = 0;
    let cursor: string | null = null;
    const seen = new Set<string>();
    setBlocks([]);
    setConnected(false);

    const appendPage = (page: StreamPage) => {
      const items = page.items ?? page.events ?? [];
      const fresh = items.filter((item) => {
        const streamItem = item as unknown as StreamItem;
        const key = `${streamItem.attempt_id ?? "legacy"}:${streamItem.seq}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setBlocks((before) => fresh.reduce((next, item) => reduceStreamItem(next, item as unknown as StreamItem), before));
      if (page.next_cursor) cursor = page.next_cursor;
      if (page.truncated || page.gap) {
        setStatus(page.gap ? "实时流存在 CURSOR_GAP，请从归档首帧重新加载" : "实时流归档已截断，较早帧可能存在 CURSOR_GAP");
      }
    };

    const connect = async () => {
      if (!alive) return;
      try {
        // Reconnects first backfill the durable/active evidence tail.  The bus
        // itself is best-effort and may have evicted frames while disconnected.
        const backfill = await api.jobStreamPage(jobId, {
          after: cursor,
          limit: 50,
          tail: cursor === null,
        });
        if (!alive) return;
        appendPage(backfill);
        setStatus("正在申请实时流凭证…");
        const ticket = await api.createWsTicket(jobId);
        if (!alive) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const query = new URLSearchParams({ job_id: jobId, ticket: ticket.ticket });
        if (cursor) query.set("after", cursor);
        ws = new WebSocket(`${proto}://${location.host}/api/ws?${query.toString()}`);
        ws.onopen = () => {
          retry = 0;
          setConnected(true);
          setStatus("实时流已连接");
        };
        ws.onclose = (event) => {
          if (!alive) return;
          setConnected(false);
          const terminal = event.code === 4400 || event.code === 4410 || event.code === 4401 || event.code === 4403 || event.code === 4404 || event.code === 4409;
          if (event.code === 4400) setStatus("实时流游标 INVALID_CURSOR，请刷新归档");
          else if (event.code === 4410) setStatus("实时流游标 CURSOR_GAP，请刷新归档");
          else if (event.code === 4401) setStatus("实时流鉴权失败，请重新登录");
          else if (event.code === 4404) setStatus("Job 不存在，无法读取实时流");
          else if (event.code === 4409) setStatus("Job 已结束，实时流已关闭；可查看归档过程");
          else if (event.code === 1013) setStatus("实时流背压，正在通过 HTTP 补齐…");
          else setStatus("实时流已断开，正在重连…");
          if (terminal) return;
          retryTimer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
        };
        ws.onerror = () => {
          if (alive) setStatus("实时流连接错误，正在重连…");
        };
        ws.onmessage = (ev) => {
          try {
            const payload = JSON.parse(String(ev.data)) as StreamPage | StreamItem;
            if (Array.isArray((payload as StreamPage).items) || Array.isArray((payload as StreamPage).events)) {
              appendPage(payload as StreamPage);
              return;
            }
            const item = payload as StreamItem;
            const key = `${item.attempt_id ?? "legacy"}:${item.seq}`;
            if (!seen.has(key)) {
              seen.add(key);
              setBlocks((before) => reduceStreamItem(before, item));
            }
            if (item.cursor) cursor = item.cursor;
          } catch {
            // 非 JSON 帧忽略
          }
        };
      } catch (error) {
        if (!alive) return;
        setConnected(false);
        const message = error instanceof Error ? error.message : String(error);
        const cursorError = message.includes("INVALID_CURSOR") || message.includes("CURSOR_GAP");
        setStatus(message.includes("JOB_NOT_RUNNING") || message.includes("job is not running")
          ? "Job 已结束，实时流已关闭；可查看归档过程"
          : message.includes("CURSOR_GAP")
            ? "实时流游标 CURSOR_GAP，请刷新归档"
            : message.includes("INVALID_CURSOR")
              ? "实时流游标 INVALID_CURSOR，请刷新归档"
          : message.includes("401") || message.includes("AUTH")
            ? "实时流鉴权失败，请重新登录"
            : "实时流暂不可用，正在重试…");
        if (!cursorError && !message.includes("JOB_NOT_RUNNING") && !message.includes("job is not running")) {
          retryTimer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
        }
      }
    };
    void connect();
    return () => {
      alive = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [jobId]);

  if (!active) return null;

  return <div className="flex h-full min-h-0 flex-col">
    <div className="border-b border-white/[.06] px-3 py-1.5 font-mono text-[10px] text-zinc-600">{status}</div>
    <div className="min-h-0 flex-1">
      <ProcessStreamView
        blocks={blocks}
        live
        connected={connected}
        emptyHint="等待 agent 事件…（实时流与归档会自动补齐）"
      />
    </div>
  </div>;
}
