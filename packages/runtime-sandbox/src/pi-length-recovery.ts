import { createHash } from "node:crypto";

/** Frozen diagnostic input only; the runner never changes model limits or quotas. */
export interface RuntimeModelBudget {
  context_window_tokens: RuntimeModelLimit;
  max_output_tokens: RuntimeModelLimit;
  catalog_revision: string | null;
}
interface RuntimeModelLimit {
  configured: number | null;
  declared: number | null;
  effective: number | null;
  source: "job" | "role_config" | "credential_settings" | "provider_declared" | "cli_default";
}
export type PiRecoveryAction = "state" | "compact" | "continue" | "stop";
export const PI_LENGTH_RECOVERY_MAX_ATTEMPTS = 2;
export const PI_LENGTH_RECOVERY_MESSAGE = "本轮 Pi 响应因 length 被截断，未证明任务完成，剩余可用输出额度未知。请在当前 Session 读取已有状态与工具/控制回执，仅继续未完成的步骤；用短文本和小块完整工具参数修正，不重复旧 prompt、已接受的提案或已成功的工具调用。效果 pending/unknown 或回执不明时先查询，禁止重放；不能修正则明确说明阻塞。原完成门与预算不变。";
export const PI_LENGTH_COMPACTION_INSTRUCTIONS = "Create a concise checkpoint of the existing goal, constraints, accepted effects and receipts, unfinished steps, and unknown effects that must not be replayed. Do not perform tools or claim completion. Preserve the original authorization and budgets.";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const isCorrectablePiCompactionError = (value: unknown): boolean => typeof value === "string" && /^(?:(?:Context overflow recovery|Auto-compaction|Compaction) failed: )?(?:Already compacted|Nothing to compact \(session too small\)|(?:Summarization|Turn prefix summarization) failed: generation hit the token cap and the summary is incomplete|Truncated response recovery failed after one compact-and-retry attempt)$/u.test(value);

/** Observations, not context identity or settlement authority. Run-wide counts survive process resume. */
export class PiLengthRecovery {
  truncated = false;
  attempts = 0;
  lengthCount = 0;
  compactionCount = 0;
  noProgressCompactions = 0;
  validResponses = 0;
  stopCode = "PI_LENGTH_RECOVERY_EXHAUSTED";
  private consecutiveLengths = 0;
  private phase?: "state" | "compact" | "after_compact";
  private manualEndObserved = false;
  private summarySinceLength = false;
  private lastLength: Record<string, unknown> = {};
  private lastCompaction: Record<string, unknown> = {};
  private actualModel: Record<string, unknown> = {};

  constructor(private readonly frozenBudget?: RuntimeModelBudget) {}

  diagnostic(): Record<string, unknown> {
    return { stop_reason: "length", truncated: this.truncated, length_count: this.lengthCount,
      recovery_attempts: this.attempts, recovery_limit: PI_LENGTH_RECOVERY_MAX_ATTEMPTS,
      compaction_count: this.compactionCount, no_progress_compactions: this.noProgressCompactions,
      valid_responses: this.validResponses, last_length: this.lastLength, last_compaction: this.lastCompaction,
      actual_model: this.actualModel, frozen_model_budget: this.frozenBudget ?? null,
      remaining_request_budget: "unknown", context_identity: "unknown" };
  }

  begin(): PiRecoveryAction {
    if (this.attempts >= PI_LENGTH_RECOVERY_MAX_ATTEMPTS) {
      if (this.noProgressCompactions >= 2) this.stopCode = "PI_COMPACTION_NO_PROGRESS";
      return "stop";
    }
    this.phase = "state";
    return "state";
  }

  async perform(action: PiRecoveryAction, control: {
    guard?: () => { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;
    completionGate?: () => boolean;
    emit: (code: string, extra?: Record<string, unknown>) => void;
    state: () => Promise<void>;
    compact: () => Promise<void>;
    send: () => Promise<void>;
  }): Promise<{ isError?: boolean; error?: string }> {
    const guard = await control.guard?.();
    // Recheck after the asynchronous authority read: an accepted completion wins.
    if (control.completionGate?.() === true) {
      control.emit("PI_LENGTH_RECOVERY_STOPPED", { reason: "completion_accepted" });
      return { isError: false };
    }
    if (action === "stop" || guard && guard.allowed !== true) {
      const reasons = new Set(["waiting_human", "cancelled", "timeout", "completion_accepted", "terminal_prepared",
        "unknown_external_effect", "lease_expired", "inactive", "budget_exhausted", "unknown"]);
      const reason = guard && guard.allowed !== true ? reasons.has(guard.reason ?? "") ? guard.reason! : "unknown" : "attempts_exhausted";
      const code = guard && guard.allowed !== true ? "PI_LENGTH_RECOVERY_STOPPED" : this.stopCode;
      control.emit(code, { reason });
      return { isError: true, error: `${code}: ${reason}; stopReason=length; recovery_attempts=${this.attempts}` };
    }
    if (action === "state" && this.phase === "state") this.attempts++;
    control.emit("PI_LENGTH_RECOVERY_ATTEMPT", { action });
    if (action === "state") await control.state();
    else if (action === "compact") await control.compact();
    else await control.send();
    return {};
  }

  private compaction(value: unknown): void {
    const result = object(value);
    const summary = typeof result.summary === "string" ? result.summary.trim() : "";
    const valid = Boolean(summary && typeof result.firstKeptEntryId === "string" && result.firstKeptEntryId
      && (number(result.tokensBefore) ?? 0) > 0);
    const before = number(result.tokensBefore);
    const after = number(result.estimatedTokensAfter);
    this.compactionCount++;
    this.lastCompaction = { evidence: valid ? "summary_observed" : "no_summary", tokens_before: before,
      estimated_tokens_after: after, estimated_reduction: before !== null && after !== null ? after < before : null,
      summary_sha256: valid ? createHash("sha256").update(summary).digest("hex") : null,
      summary_bytes: Buffer.byteLength(summary), usage: this.usage(result.usage) };
    // An estimate is not actual context usage. Neither it nor a summary clears truncation.
    this.summarySinceLength ||= valid;
    if (valid) this.noProgressCompactions = 0;
    else this.noProgressCompactions++;
  }

  private usage(value: unknown): Record<string, number | null> {
    const usage = object(value);
    return { input: number(usage.input), output: number(usage.output), cache_read: number(usage.cacheRead),
      cache_write: number(usage.cacheWrite), total: number(usage.totalTokens) };
  }

  observe(record: Record<string, unknown>): PiRecoveryAction | undefined {
    if (record.type === "message_end") {
      const message = object(record.message);
      if (message.role && message.role !== "assistant") return;
      if (message.stopReason === "length") {
        this.truncated = true;
        this.lengthCount++;
        this.consecutiveLengths++;
        this.summarySinceLength = false;
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        this.lastLength = { usage: this.usage(message.usage), content_shape: {
          text_blocks: content.filter(block => block.type === "text").length,
          thinking_blocks: content.filter(block => block.type === "thinking").length,
          tool_blocks: content.filter(block => block.type === "toolCall").length } };
        // Also bound provider-internal compact/retry loops which never reach agent_settled.
        if (this.consecutiveLengths >= PI_LENGTH_RECOVERY_MAX_ATTEMPTS + 2) return "stop";
      } else if (["stop", "toolUse"].includes(String(message.stopReason))) {
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        if (content.some(block => block.type === "text" && typeof block.text === "string" && block.text.trim()
          || block.type === "toolCall" && typeof block.name === "string" && block.name
          && block.arguments !== null && typeof block.arguments === "object" && !Array.isArray(block.arguments))) {
          this.truncated = false;
          this.validResponses++;
          this.consecutiveLengths = 0;
          this.noProgressCompactions = 0;
        }
      }
    }
    if (record.type === "compaction_end") {
      if (record.aborted === true) return;
      this.compaction(record.result);
      if (record.errorMessage !== undefined && !isCorrectablePiCompactionError(record.errorMessage)) return;
      if (this.phase === "compact") this.manualEndObserved = true;
      // One failed compaction still gets actionable feedback. Repeated failures cannot loop forever.
      if (this.truncated && this.noProgressCompactions >= 2 && this.attempts > 0 && this.phase !== "compact") {
        this.stopCode = "PI_COMPACTION_NO_PROGRESS";
        return "stop";
      }
    }
    if (record.type !== "response") return;
    if (record.command === "get_state" && record.success === true) {
      const data = object(record.data);
      const model = object(data.model);
      this.actualModel = { context_window_tokens: number(model.contextWindow), max_output_tokens: number(model.maxTokens),
        auto_compaction_enabled: typeof data.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : null };
      if (!this.phase || this.phase === "compact") return;
      if (data.isStreaming !== false || data.isCompacting !== false || data.pendingMessageCount !== 0) {
        this.stopCode = "PI_LENGTH_RECOVERY_SESSION_NOT_IDLE";
        return "stop";
      }
      if (this.phase === "after_compact") { this.phase = undefined; return "continue"; }
      const usage = object(this.lastLength.usage);
      const input = number(usage.input);
      const cache = (number(usage.cache_read) ?? 0) + (number(usage.cache_write) ?? 0);
      const window = number(model.contextWindow);
      const lowOutput = number(usage.output) !== null && (number(usage.output) ?? 0) <= 1;
      // This is last observed request usage, not a fabricated current-context estimate.
      const pressure = input !== null && window !== null && input + cache >= window - 4096;
      if (!this.summarySinceLength && (lowOutput || pressure || this.noProgressCompactions > 0)) {
        this.phase = "compact";
        this.manualEndObserved = false;
        return "compact";
      }
      this.phase = undefined;
      return "continue";
    }
    if (record.command === "compact" && this.phase === "compact") {
      if (record.success !== true && !isCorrectablePiCompactionError(record.error)) {
        this.phase = undefined; // Adapter preserves permission, cancellation, provider and unknown-effect errors.
        return;
      }
      if (!this.manualEndObserved) this.compaction(record.data);
      this.phase = "after_compact";
      return "state"; // Recheck live identity and idle state; compact can run extension callbacks.
    }
  }
}
