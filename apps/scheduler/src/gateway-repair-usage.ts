import type { UsageBreakdown } from "./gateway.js";
import { createUsageShapeDiagnostic, type UsageScanReason } from "./gateway-usage-shape.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_777_216;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function optionalCount(value: unknown): number | null { return value === undefined ? 0 : count(value); }

function usage(value: unknown, protocol: "chat" | "responses" | "anthropic"): UsageBreakdown | null {
  const u = record(value);
  if (!u) return null;
  const input = count(u[protocol === "chat" ? "prompt_tokens" : "input_tokens"]);
  const output = count(u[protocol === "chat" ? "completion_tokens" : "output_tokens"]);
  if (input === null || output === null) return null;
  let cacheRead: number | null = 0, cacheWrite: number | null = 0;
  if (protocol === "anthropic") {
    cacheRead = optionalCount(u.cache_read_input_tokens);
    cacheWrite = optionalCount(u.cache_creation_input_tokens);
    if (u.cache_creation !== undefined) {
      const creation = record(u.cache_creation);
      if (!creation) return null;
      const short = optionalCount(creation.ephemeral_5m_input_tokens);
      const long = optionalCount(creation.ephemeral_1h_input_tokens);
      if (short === null || long === null || !Number.isSafeInteger(short + long)) return null;
      if (u.cache_creation_input_tokens !== undefined && cacheWrite !== short + long) return null;
      cacheWrite = short + long;
    }
  } else {
    const detailsValue = u[protocol === "chat" ? "prompt_tokens_details" : "input_tokens_details"];
    if (detailsValue !== undefined && detailsValue !== null) {
      const details = record(detailsValue);
      if (!details) return null;
      cacheRead = optionalCount(details.cached_tokens);
    }
    if (cacheRead !== null && cacheRead > input) return null;
  }
  if (cacheRead === null || cacheWrite === null) return null;
  const total = input + output + (protocol === "anthropic" ? cacheRead + cacheWrite : 0);
  if (!Number.isSafeInteger(total)) return null;
  if (protocol !== "anthropic" && count(u.total_tokens) !== total) return null;
  return { input, output, total, cacheRead, cacheWrite };
}

/**
 * #1059: anthropic-compatible group aggregates commonly send
 * `message_start.usage` without `output_tokens`, reporting only the
 * cumulative input/cache snapshot, and deliver the cumulative output with
 * `message_delta`. Validate every supplied field now; the supplied snapshot
 * still seeds the monotonic baseline (with output 0) so a later delta may not
 * report lower input/cache, and the stream must still deliver a complete
 * usage before `message_stop`.
 */
function anthropicStartUsage(value: unknown): { valid: boolean; pendingOutput: boolean } {
  const u = record(value);
  if (!u) return { valid: false, pendingOutput: false };
  if (u.output_tokens === undefined) return { valid: usage({ ...u, output_tokens: 0 }, "anthropic") !== null, pendingOutput: true };
  return { valid: usage(u, "anthropic") !== null, pendingOutput: false };
}

/** Strict protocol fixtures, never assistant/tool text or regex usage guesses.
 * null means unknown/incomplete, including unsupported protocols and size limits.
 */
export function createRepairUsageScanner(path: string, isSse: boolean): {
  push: (chunk: Uint8Array | string) => void;
  finish: () => UsageBreakdown | null;
  diagnostic: () => ReturnType<ReturnType<typeof createUsageShapeDiagnostic>["snapshot"]>;
} {
  const normalized = path.replace(/^\//u, "");
  const protocol = /^(?:v1\/)?(?:chat\/completions|completions)$/u.test(normalized) ? "chat"
    : /^(?:v1\/)?responses$/u.test(normalized) ? "responses"
      : /^(?:v1\/)?messages$/u.test(normalized) ? "anthropic" : null;
  const completionObject = normalized.endsWith("chat/completions") ? "chat.completion" : "text_completion";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let failed = protocol === null, finished = false, ended = false, totalBytes = 0;
  // #1250/#1252：Responses 在 response.completed 之后只会出现表层尾帧（如 response.output_text.done），
  // 一律拒收会把已观察到的合法最终用量整条作废。见 responsesTail。
  let responsesTail = false;
  let reason: UsageScanReason = protocol === null ? "unsupported_protocol" : "complete";
  const diagnostic = createUsageShapeDiagnostic(protocol, isSse);
  const fail = (next: UsageScanReason): void => { if (!failed) reason = next; failed = true; };
  let buffer = "", eventName = "", data: string[] = [], frameBytes = 0;
  const chatChoices = new Map<number, boolean>();
  let observed: UsageBreakdown | null = null, anthropicStart: RecordValue | null = null, anthropicDelta = false;
  const observe = (next: UsageBreakdown | null): void => {
    if (!next) { fail("invalid_usage"); return; }
    if (observed && (next.input < observed.input || next.output < observed.output || next.cacheRead < observed.cacheRead || next.cacheWrite < observed.cacheWrite)) { fail("usage_regression"); return; }
    observed = next;
  };
  const parse = (text: string): RecordValue | null => {
    try { return record(JSON.parse(text)); } catch { return null; }
  };
  const frame = (): void => {
    if (!data.length) { if (eventName === "error") { diagnostic.frame(null, eventName); fail("upstream_error"); } eventName = ""; frameBytes = 0; return; }
    const text = data.join("\n");
    data = []; frameBytes = 0;
    const name = eventName; eventName = "";
    if (ended && !responsesTail) { fail("invalid_sequence"); return; }
    // #1252：[DONE] 是 Responses 的标准结束标记，先于"结束后不再收业务帧"判定。
    if (text === "[DONE]" && protocol === "responses" && ended) { diagnostic.frame(null, name); return; }
    if (text === "[DONE]") {
      diagnostic.frame(null, name);
      if (protocol !== "chat" || !chatChoices.size || [...chatChoices.values()].some(done => !done)) fail("invalid_sequence");
      else if (!observed) fail("missing_final_usage");
      else { ended = true; diagnostic.finalUsage(); }
      return;
    }
    const value = parse(text);
    diagnostic.frame(value, name);
    if (!value) { fail("invalid_json"); return; }
    if (value.error !== undefined || name === "error") { fail("upstream_error"); return; }
    if (protocol === "chat") {
      if (value.object !== (completionObject === "chat.completion" ? "chat.completion.chunk" : "text_completion")) { fail("invalid_envelope"); return; }
      if (!Array.isArray(value.choices)) { fail("invalid_envelope"); return; }
      for (const item of value.choices) {
        const choice = record(item);
        if (!choice || count(choice.index) === null || (choice.finish_reason != null && typeof choice.finish_reason !== "string")) { fail("invalid_envelope"); return; }
        const index = choice.index as number;
        chatChoices.set(index, chatChoices.get(index) === true || typeof choice.finish_reason === "string");
      }
      if (value.usage !== undefined && value.usage !== null) observe(usage(value.usage, "chat"));
    } else if (protocol === "responses") {
      if (typeof value.type !== "string" || !value.type.startsWith("response.")) { fail("unknown_event"); return; }
      if (name && name !== value.type) { fail("event_mismatch"); return; }
      if (["response.failed", "response.incomplete", "response.cancelled", "response.error"].includes(value.type)) { fail("upstream_error"); return; }
      if (ended && responsesTail) {
        // #1252：完成之后只接受已知的表层尾帧，任何业务帧、重复完成或未知事件都继续拒绝。
        if (value.type === "response.completed") { fail("invalid_sequence"); return; }
        const tailFrame = value.response === undefined && count(value.output_index) !== null
          && ["response.output_text.done", "response.output_item.done", "response.content_part.done"].includes(value.type);
        if (!tailFrame) { fail("invalid_sequence"); return; }
        return;
      }
      if (value.type === "response.completed") {
        const response = record(value.response);
        if (!response || response.object !== "response" || response.status !== "completed" || response.error != null || response.incomplete_details != null) { fail("invalid_envelope"); return; }
        observe(usage(response.usage, "responses")); ended = true; responsesTail = true;
        if (!failed) diagnostic.finalUsage();
      }
    } else if (protocol === "anthropic") {
      if (typeof value.type !== "string") { fail("unknown_event"); return; }
      if (name && name !== value.type) { fail("event_mismatch"); return; }
      if (value.type === "message_start") {
        const message = record(value.message);
        if (anthropicStart || !message || message.type !== "message" || message.role !== "assistant") { fail("invalid_sequence"); return; }
        anthropicStart = record(message.usage);
        // #1059: an aggregated start snapshot without output_tokens is the
        // documented compat shape, not a reason to distrust the whole stream;
        // supplied fields still validate here, and the delta must complete it.
        const start = anthropicStartUsage(anthropicStart);
        if (!anthropicStart || !start.valid) { fail("invalid_usage"); return; }
        // A pending output is not final evidence, but the announced input/cache
        // already forms the monotonic baseline: observing it with output 0 keeps
        // `observe`'s undercount guard armed for the first delta.
        observe(usage(start.pendingOutput ? { ...anthropicStart, output_tokens: 0 } : anthropicStart, "anthropic"));
      } else if (value.type === "message_delta") {
        if (!anthropicStart) { fail("invalid_sequence"); return; }
        // An omitted usage contributes no evidence. A later/earlier valid delta
        // is still required, even when the start contains integer output_tokens.
        if (value.usage === undefined) return;
        const deltaUsage = record(value.usage);
        if (!deltaUsage || count(deltaUsage.output_tokens) === null) { fail("invalid_usage"); return; }
        // Usage fields are cumulative snapshots. Preserve omitted fields from
        // the last snapshot, but validate every supplied input/cache update too:
        // ignoring them would undercount providers reporting revised totals.
        const nextUsage = { ...anthropicStart, ...deltaUsage };
        observe(usage(nextUsage, "anthropic"));
        if (!failed) anthropicStart = nextUsage;
        anthropicDelta = true;
        if (!failed) diagnostic.finalUsage();
      } else if (value.type === "message_stop") {
        if (!anthropicStart || !anthropicDelta || !observed) fail("missing_final_usage");
        ended = true;
      } else if (value.type !== "ping") {
        if (!["content_block_start", "content_block_delta", "content_block_stop"].includes(value.type)) fail("unknown_event");
        else if (!anthropicStart || anthropicDelta) fail("invalid_sequence");
      }
    }
  };
  const consume = (text: string): void => {
    buffer += text;
    if (!isSse) { if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("frame_limit"); return; }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      frameBytes += Buffer.byteLength(line) + 1;
      if (frameBytes > MAX_FRAME_BYTES) { fail("frame_limit"); break; }
      if (!line) frame();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (!line.startsWith(":")) { fail("invalid_envelope"); break; }
      if (failed) break;
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("frame_limit");
  };
  return {
    push(chunk) {
      if (finished) { fail("push_after_finish"); return; }
      if (failed) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += bytes.byteLength;
      diagnostic.bytes(bytes.byteLength);
      if (totalBytes > MAX_RESPONSE_BYTES) { fail("response_limit"); buffer = ""; data = []; return; }
      try { consume(decoder.decode(bytes, { stream: true })); } catch { fail("invalid_utf8"); }
    },
    finish() {
      if (!finished && !failed) {
        try { consume(decoder.decode()); } catch { fail("invalid_utf8"); }
        if (isSse) {
          // A partial SSE frame is not evidence of a completed response.
          // #1252：已完成且用量合法的 Responses 之后的残留字节属于传输收尾（客户端可能先关连接），
          // 不能把已经取得的最终用量改判为未知。
          if (!ended) fail("truncated");
          else if (!responsesTail && (buffer.trim() || data.length || eventName)) fail("truncated");
        } else {
          const value = parse(buffer);
          diagnostic.frame(value, "");
          if (!value) fail("invalid_json");
          else if (value.error != null) fail("upstream_error");
          else if (protocol === "chat" && value.object === completionObject) {
            if (!Array.isArray(value.choices) || !value.choices.length || value.choices.some(item => typeof record(item)?.finish_reason !== "string")) fail("invalid_envelope");
            else observe(usage(value.usage, "chat"));
          }
          else if (protocol === "responses" && value.object === "response" && value.status === "completed" && value.incomplete_details == null) observe(usage(value.usage, "responses"));
          else if (protocol === "anthropic" && value.type === "message" && value.role === "assistant" && typeof value.stop_reason === "string") observe(usage(value.usage, "anthropic"));
          else fail("invalid_envelope");
          if (!failed && observed) diagnostic.finalUsage();
        }
      }
      finished = true;
      return failed || !observed ? null : { ...observed };
    },
    diagnostic: () => diagnostic.snapshot(reason, failed),
  };
}
