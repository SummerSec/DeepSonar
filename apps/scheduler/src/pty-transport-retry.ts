/**
 * #1143：OpenSandbox PTY 传输中断（WebSocket close/error、流被切断）发生在 provision
 * 之后、Agent 已跑过若干轮模型请求时，与 Pi 流截断同族，属于已证明安全的瞬态。
 * 自动重试预算按本 Job 已消耗的 opensandbox_pty_transport 次数计算，不看 attempt_no。
 *
 * `OPENSANDBOX_PTY_HOST_KILL` 不在此列：被杀来源（Reaper / 资源压力 / 外部 kill）未
 * 确认前盲目重派会重复被杀，继续 fail closed。
 */
export const MAX_AUTOMATIC_PTY_TRANSPORT_RETRIES = 1;
export const PTY_TRANSPORT_REASON = "opensandbox_pty_transport";

const PTY_TRANSPORT_RE = /OPENSANDBOX_PTY_TRANSPORT_ERROR/;
const PTY_HOST_KILL_RE = /OPENSANDBOX_PTY_HOST_KILL/;

export interface AutomaticPtyTransportRetryPlan {
  retry: boolean;
  nextRetryCount: number;
}

export function isPtyTransportFailureMessage(text: string): boolean {
  return PTY_TRANSPORT_RE.test(text) && !PTY_HOST_KILL_RE.test(text);
}

export function readPtyTransportReason(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const reason = (outcome as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function isConsumedPtyTransportRetry(row: {
  status?: unknown;
  outcome_json?: unknown;
  state_json?: unknown;
}): boolean {
  if (String(row.status ?? "") === "active") return false;
  if (readPtyTransportReason(row.outcome_json) === PTY_TRANSPORT_REASON) return true;
  const state = row.state_json;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return readPtyTransportReason((state as Record<string, unknown>).outcome) === PTY_TRANSPORT_REASON;
  }
  return false;
}

export function countConsumedPtyTransportRetries(
  rows: Array<{ status?: unknown; outcome_json?: unknown; state_json?: unknown }>,
): number {
  return rows.reduce((n, row) => n + (isConsumedPtyTransportRetry(row) ? 1 : 0), 0);
}

export function planAutomaticPtyTransportRetry(consumedPtyTransportRetries: number): AutomaticPtyTransportRetryPlan {
  const consumed = Number.isFinite(consumedPtyTransportRetries)
    ? Math.max(0, Math.floor(consumedPtyTransportRetries))
    : 0;
  if (consumed < MAX_AUTOMATIC_PTY_TRANSPORT_RETRIES) {
    return { retry: true, nextRetryCount: consumed + 1 };
  }
  return { retry: false, nextRetryCount: consumed };
}

/**
 * 重派前置条件：本次 Attempt 不能在存在未收口外部效果时被重放。
 *
 * #1181 评审修正：`agent_run` 效果是本次执行在启动时自己写入的 `effect_pending`，
 * 只有 Attempt 终态收口才会结算，正常 dispatcher 入口永远看得到它在途——所以不能要求
 * 「全部 settled」（那样重派永不可达）。这里允许且仅允许本次执行自己的 `agent_run`
 * 处于 `effect_pending`（重派路径会随终态收口它），其余 `planned` / `effect_pending` /
 * `unknown` 一律拒绝。
 */
export function attemptEffectsAllowPtyRetry(rows: Array<{ kind?: unknown; status?: unknown }>): boolean {
  let inFlightAgentRun = 0;
  for (const row of rows) {
    if (String(row.status ?? "") === "settled") continue;
    if (String(row.status ?? "") === "effect_pending" && String(row.kind ?? "") === "agent_run") {
      inFlightAgentRun += 1;
      continue;
    }
    return false;
  }
  return inFlightAgentRun <= 1;
}