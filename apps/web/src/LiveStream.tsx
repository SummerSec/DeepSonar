import { CircleNotch, Check, Wrench, TextAlignLeft } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

/**
 * Agent 实时流视图（§6.2：原始流只过 WS 过手，不落 DB）
 * - 连接 /api/ws?job_id=...，先收环形缓冲补发，随后实时推送
 * - text.delta 合并为流式段落；tool.call.* 渲染为动作卡片；reasoning 暗色斜体
 */

export interface StreamItem {
  type: string;
  seq: number;
  at: number;
  delta?: string;
  toolName?: string;
  action?: string;
  text?: string;
}

/** 渲染单元：text 段落会随 delta 追加增长；tool 卡片 started→completed 置完成态 */
type Block =
  | { kind: "text"; key: string; text: string; reasoning: boolean }
  | { kind: "tool"; key: string; name: string; action: string; done: boolean }
  | { kind: "meta"; key: string; text: string };

function reduceItem(blocks: Block[], item: StreamItem): Block[] {
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
    // 标记最近一个未完成卡片
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

export function LiveStream({ jobId, active }: { jobId: string; active: boolean }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        setBlocks((bs) => reduceItem(bs, item));
      } catch {
        // 非 JSON 帧忽略
      }
    };
    return () => ws.close();
  }, [jobId, active]);

  // 跟随滚动（用户上翻则暂停跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [blocks, follow, active]);

  if (!active) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5">
        <span
          className={`inline-block size-1.5 rounded-full ${connected ? "deepsonar-live-dot bg-acc-500" : "bg-zinc-600"}`}
        />
        <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
          {connected ? "live" : "已断开"}
        </span>
        {!follow && (
          <button
            onClick={() => setFollow(true)}
            className="ml-auto rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[12px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
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
            等待 agent 事件…（job 运行时这里会实时滚动）
          </div>
        )}
        {blocks.map((b) => {
          if (b.kind === "text") {
            return b.reasoning ? (
              <p key={b.key} className="mb-2 whitespace-pre-wrap break-words font-mono text-[13px] italic leading-relaxed text-zinc-600">
                {b.text}
              </p>
            ) : (
              <p key={b.key} className="mb-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-zinc-300">
                {b.text}
              </p>
            );
          }
          if (b.kind === "tool") {
            return (
              <div key={b.key} className="mb-1.5 flex items-center gap-2 rounded-md border border-ink-800 bg-ink-850 px-2.5 py-1.5">
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
        {blocks.length > 0 && blocks[blocks.length - 1]?.kind === "text" && (
          <span className="inline-block h-3 w-1.5 animate-pulse bg-acc-500/70" />
        )}
      </div>
    </div>
  );
}
