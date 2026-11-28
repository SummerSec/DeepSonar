import type { sql } from "../../db.js";
import { toolCallActivityPatch, toolCallProgressMessage, type ToolCallPhase } from "./stall-policy.js";

const PROGRESS_THROTTLE_MS = 20_000;

export interface ToolCallActivityOptions {
  db: typeof sql;
  jobId: string;
  /** 实时流投递；失败不阻塞工具执行。 */
  emit: (type: "progress", payload: { message: string }) => Promise<unknown> | unknown;
  /** 命令/参数脱敏；工具名只保留可安全展示的摘要。 */
  scrub: (toolName: string) => string;
}

/**
 * #1304：事件流必须成对。
 *
 * `started` 无条件投递，对应的 `completed` 也一定要投递——旧实现用
 * `phase === "started" || now - lastEmit > 20s` 同时压制 completed，实测
 * started 251,415 条 / completed 983 条（0.39%），Reaper 曾经依赖的
 * 「最后一条 tool.call.* 是否 started」因此对 97.7% 的 Job 永久点亮。
 *
 * 现在只对「同一 callId 的重复事件」去重，不再按相位压制；payload 的
 * runtime_activity 两相都写，供 Reaper 读取权威信号。
 */
export function createToolCallActivityRecorder(options: ToolCallActivityOptions) {
  const started = new Set<string>();
  let lastEmit = 0;
  return (phase: ToolCallPhase, toolName: string, callId?: string | null): void => {
    const summary = options.scrub(toolName);
    void options.db`
      UPDATE jobs SET payload_json = payload_json || ${options.db.json(toolCallActivityPatch(phase, summary) as never)}
      WHERE id = ${options.jobId} AND status = 'running'`.catch(() => {});
    const key = callId && callId.trim() ? callId : toolName;
    const now = Date.now();
    // 同一 callId 的重复 started 只投递一次；没有 callId 时退回工具名，不能据此去重
    // （同一个工具会被连续调用多次），所以只有带 callId 才做重复判定。
    if (phase === "started" && callId && callId.trim() && started.has(key)) return;
    if (phase !== "started" && !started.has(key) && now - lastEmit <= PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    if (phase === "started") started.add(key); else started.delete(key);
    void Promise.resolve(options.emit("progress", { message: toolCallProgressMessage(phase, toolName) }))
      .catch(() => {});
  };
}
