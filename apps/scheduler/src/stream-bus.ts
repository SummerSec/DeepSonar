/**
 * Agent 实时流总线（§6.2：原始流只过手不落库）
 * - 调度器进程内 pub/sub：executor 发布，/ws 路由订阅转发
 * - 每个 job 保留最近 BUFFER_MAX 条环形缓冲，晚加入的订阅者能补看上下文
 * - 进程重启即丢失 —— 原始流本来就属于冷存储（blob），这里只服务实时观看
 */

export interface StreamItem {
  /** agentbox 规范化事件类型（text.delta / tool.call.started / ...）或语义事件 */
  type: string;
  seq: number;
  at: number;
  [k: string]: unknown;
}

const BUFFER_MAX = 300;

const buffers = new Map<string, StreamItem[]>();
const subs = new Map<string, Set<(item: StreamItem) => void>>();
const seqs = new Map<string, number>();

export function publishStream(jobId: string, item: Omit<StreamItem, "seq" | "at">): void {
  const seq = (seqs.get(jobId) ?? 0) + 1;
  seqs.set(jobId, seq);
  const full = { ...item, seq, at: Date.now() } as StreamItem;

  let buf = buffers.get(jobId);
  if (!buf) {
    buf = [];
    buffers.set(jobId, buf);
  }
  // 新一轮运行开始时清掉上一轮的残留（同 job resume 场景）
  if (item.type === "run.started") buf.length = 0;
  // 连续 delta 合并进缓冲末条：否则 300 条容量只能回放最后几百字符，
  // 早期的工具调用卡片会被挤出去（订阅方仍逐条实时推送，前端自己做合并）
  const last = buf[buf.length - 1];
  if (
    (item.type === "text.delta" || item.type === "reasoning.delta") &&
    last?.type === item.type
  ) {
    last.delta = String(last.delta ?? "") + String(item.delta ?? "");
    last.at = Date.now();
  } else {
    buf.push(full);
    if (buf.length > BUFFER_MAX) buf.splice(0, buf.length - BUFFER_MAX);
  }

  for (const fn of subs.get(jobId) ?? []) {
    try {
      fn(full);
    } catch {
      // 订阅方写入失败（连接断开等）由 WS 层的 close 清理
    }
  }
}

export function streamBuffer(jobId: string): StreamItem[] {
  return buffers.get(jobId) ?? [];
}

export function subscribeStream(jobId: string, fn: (item: StreamItem) => void): () => void {
  let set = subs.get(jobId);
  if (!set) {
    set = new Set();
    subs.set(jobId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subs.delete(jobId);
  };
}
