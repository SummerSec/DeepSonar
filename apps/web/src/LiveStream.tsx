import { CircleNotch, Check, Funnel, Wrench, TextAlignLeft, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownView } from "./MarkdownView";

/**
 * Agent 实时流视图（§6.2：原始流只过 WS 过手，不落 DB）
 * - 连接 /api/ws?job_id=...，先收环形缓冲补发，随后实时推送
 * - text.delta 合并为流式段落；tool.call.* 渲染为动作卡片；reasoning 暗色斜体
 * - 支持按类型筛选 + 关键词过滤（与运行详情过程视图一致）
 */

export interface StreamItem {
  type: string;
  seq: number;
  at: number;
  delta?: string;
  toolName?: string;
  action?: string;
  text?: string;
  /** canvas.broadcast 的结构化字段（由 stream-bus 直接推送，或嵌在 payload 中）。 */
  payload?: Record<string, unknown>;
  broadcast_id?: string;
  delivery_status?: string;
  source_node_type?: string;
  source_job_id?: string;
  source_node_id?: string;
  target_job_id?: string;
  target_role?: string;
  title?: string | null;
  attempt?: number;
  error_code?: string | null;
  error_message?: string | null;
  skip_reason?: string | null;
  payload_preview?: string | null;
}

/** 渲染单元：text 段落会随 delta 追加增长；tool 卡片 started→completed 置完成态 */
export type StreamBlock =
  | { kind: "text"; key: string; text: string; reasoning: boolean }
  | { kind: "tool"; key: string; name: string; action: string; done: boolean }
  | {
      kind: "broadcast";
      key: string;
      status: string;
      title: string;
      sourceNodeType: string;
      attempt: number | null;
      errorCode: string | null;
      errorMessage: string | null;
      skipReason: string | null;
      preview: string | null;
    }
  | { kind: "meta"; key: string; text: string };

export type StreamKindFilter = "all" | "text" | "tool" | "broadcast" | "meta";

/** 画布广播状态是平台投递账本状态，不代表模型已读取或采纳。 */
function broadcastField(item: StreamItem, key: string): unknown {
  const direct = (item as unknown as Record<string, unknown>)[key];
  if (direct !== undefined) return direct;
  return item.payload?.[key];
}

function broadcastStatus(item: StreamItem): string {
  const raw = broadcastField(item, "delivery_status");
  return raw === "planned" || raw === "injected" || raw === "failed" || raw === "skipped" || raw === "unknown"
    ? raw
    : "unknown";
}

function broadcastText(item: StreamItem, key: string): string | null {
  const value = broadcastField(item, key);
  return typeof value === "string" && value.trim() ? value : null;
}

export function reduceStreamItem(blocks: StreamBlock[], item: StreamItem): StreamBlock[] {
  const key = String(item.seq);
  if (item.type === "canvas.broadcast") {
    const status = broadcastStatus(item);
    const attemptValue = broadcastField(item, "attempt");
    const attempt = typeof attemptValue === "number" && Number.isFinite(attemptValue) ? attemptValue : null;
    const title = broadcastText(item, "title") ?? "未命名画布增量";
    const sourceNodeType = broadcastText(item, "source_node_type") ?? "fact/finding";
    const errorCode = broadcastText(item, "error_code");
    const errorMessage = broadcastText(item, "error_message");
    const skipReason = broadcastText(item, "skip_reason");
    const preview = broadcastText(item, "payload_preview");
    return [
      ...blocks,
      {
        kind: "broadcast",
        key: `broadcast-${String(broadcastField(item, "broadcast_id") ?? key)}`,
        status,
        title,
        sourceNodeType,
        attempt,
        errorCode,
        errorMessage,
        skipReason,
        preview,
      },
    ];
  }
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
      payload: type === "canvas.broadcast" ? { ...record, ...payload } : payload,
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
    if (type === "canvas.broadcast") {
      blocks = reduceStreamItem(blocks, item);
      continue;
    }
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
  kind: StreamKindFilter | "broadcast",
  query: string,
): StreamBlock[] {
  const needle = query.trim().toLowerCase();
  return blocks.filter((b) => {
    if (kind !== "all" && b.kind !== kind) return false;
    if (!needle) return true;
    if (b.kind === "text") return b.text.toLowerCase().includes(needle);
    if (b.kind === "tool") return `${b.name} ${b.action}`.toLowerCase().includes(needle);
    if (b.kind === "broadcast") {
      return `${b.status} ${b.sourceNodeType} ${b.title} ${b.errorCode ?? ""} ${b.errorMessage ?? ""} ${b.preview ?? ""}`
        .toLowerCase()
        .includes(needle);
    }
    return b.text.toLowerCase().includes(needle);
  });
}

const KIND_OPTIONS: { value: StreamKindFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "tool", label: "工具" },
  { value: "broadcast", label: "画布注入" },
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
          if (b.kind === "broadcast") {
            const statusLabel: Record<string, string> = {
              planned: "已计划",
              injected: "平台已注入",
              failed: "注入失败",
              skipped: "已跳过",
              unknown: "结果不确定",
            };
            const statusColor: Record<string, string> = {
              planned: "text-sky-300",
              injected: "text-emerald-300",
              failed: "text-red-300",
              skipped: "text-zinc-400",
              unknown: "text-amber-300",
            };
            return (
              <div
                key={b.key}
                className="mb-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[.045] px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                  <span className="rounded bg-cyan-400/10 px-1.5 py-0.5 uppercase tracking-[.12em] text-cyan-300 ring-1 ring-cyan-300/20">
                    画布注入
                  </span>
                  <span className={statusColor[b.status] ?? "text-zinc-300"}>
                    {statusLabel[b.status] ?? `状态 ${b.status}`}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-500">{b.sourceNodeType}</span>
                  {b.attempt !== null && <span className="text-zinc-600">attempt {b.attempt}</span>}
                </div>
                <div className="mt-1 text-[13px] leading-relaxed text-zinc-200">{b.title}</div>
                {b.status === "injected" && (
                  <div className="mt-1 font-mono text-[10px] leading-relaxed text-emerald-300/70">
                    Agent.attach/sendMessage 已由平台调用并返回成功；这不表示模型已读取或采纳。
                  </div>
                )}
                {b.status === "unknown" && (
                  <div className="mt-1 font-mono text-[10px] leading-relaxed text-amber-200/80">
                    平台未能确认注入结果，不会据此推断模型是否读取。
                  </div>
                )}
                {(b.errorCode || b.errorMessage) && (
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-red-300/90">
                    {b.errorCode ? `${b.errorCode}${b.errorMessage ? "：" : ""}` : "错误"}
                    {b.errorMessage ?? ""}
                  </div>
                )}
                {b.status === "skipped" && b.skipReason && (
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-500">
                    跳过原因：{b.skipReason}
                  </div>
                )}
                {b.preview && (
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 px-2.5 py-2 font-mono text-[11px] leading-5 text-zinc-400">
                    {b.preview}
                  </pre>
                )}
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

  useEffect(() => {
    if (!active) return;
    setBlocks([]);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?job_id=${jobId}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const item = JSON.parse(String(ev.data)) as StreamItem;
        setBlocks((bs) => reduceStreamItem(bs, item));
      } catch {
        // 非 JSON 帧忽略
      }
    };
    return () => ws.close();
  }, [jobId, active]);

  if (!active) return null;

  return (
    <ProcessStreamView
      blocks={blocks}
      live
      connected={connected}
      emptyHint="等待 agent 事件…（job 运行时这里会实时滚动）"
    />
  );
}
