import type { UsageBreakdown } from "./gateway.js";

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

/** Strict protocol fixtures, never assistant/tool text or regex usage guesses.
 * null means unknown/incomplete, including unsupported protocols and size limits.
 */
export function createRepairUsageScanner(path: string, isSse: boolean): {
  push: (chunk: Uint8Array | string) => void;
  finish: () => UsageBreakdown | null;
} {
  const normalized = path.replace(/^\//u, "");
  const protocol = /^(?:v1\/)?(?:chat\/completions|completions)$/u.test(normalized) ? "chat"
    : /^(?:v1\/)?responses$/u.test(normalized) ? "responses"
      : /^(?:v1\/)?messages$/u.test(normalized) ? "anthropic" : null;
  const completionObject = normalized.endsWith("chat/completions") ? "chat.completion" : "text_completion";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let failed = protocol === null, finished = false, ended = false, totalBytes = 0;
  let buffer = "", eventName = "", data: string[] = [], frameBytes = 0;
  const chatChoices = new Map<number, boolean>();
  let observed: UsageBreakdown | null = null, anthropicStart: RecordValue | null = null, anthropicDelta = false;
  const observe = (next: UsageBreakdown | null): void => {
    if (!next) { failed = true; return; }
    if (observed && (next.input < observed.input || next.output < observed.output || next.cacheRead < observed.cacheRead || next.cacheWrite < observed.cacheWrite)) { failed = true; return; }
    observed = next;
  };
  const parse = (text: string): RecordValue | null => {
    try { return record(JSON.parse(text)); } catch { return null; }
  };
  const frame = (): void => {
    if (!data.length) { if (eventName === "error") failed = true; eventName = ""; frameBytes = 0; return; }
    const text = data.join("\n");
    data = []; frameBytes = 0;
    const name = eventName; eventName = "";
    if (ended) { failed = true; return; }
    if (text === "[DONE]") {
      if (protocol !== "chat" || !observed || !chatChoices.size || [...chatChoices.values()].some(done => !done)) failed = true;
      else ended = true;
      return;
    }
    const value = parse(text);
    if (!value || value.error !== undefined || name === "error") { failed = true; return; }
    if (protocol === "chat") {
      if (value.object !== (completionObject === "chat.completion" ? "chat.completion.chunk" : "text_completion")) { failed = true; return; }
      if (!Array.isArray(value.choices)) { failed = true; return; }
      for (const item of value.choices) {
        const choice = record(item);
        if (!choice || count(choice.index) === null || (choice.finish_reason != null && typeof choice.finish_reason !== "string")) { failed = true; return; }
        const index = choice.index as number;
        chatChoices.set(index, chatChoices.get(index) === true || typeof choice.finish_reason === "string");
      }
      if (value.usage !== undefined && value.usage !== null) observe(usage(value.usage, "chat"));
    } else if (protocol === "responses") {
      if (typeof value.type !== "string" || !value.type.startsWith("response.") || (name && name !== value.type)) { failed = true; return; }
      if (["response.failed", "response.incomplete", "response.cancelled", "response.error"].includes(value.type)) { failed = true; return; }
      if (value.type === "response.completed") {
        const response = record(value.response);
        if (!response || response.object !== "response" || response.status !== "completed" || response.error != null || response.incomplete_details != null) { failed = true; return; }
        observe(usage(response.usage, "responses")); ended = true;
      }
    } else if (protocol === "anthropic") {
      if (typeof value.type !== "string" || (name && name !== value.type)) { failed = true; return; }
      if (value.type === "message_start") {
        const message = record(value.message);
        if (anthropicStart || !message || message.type !== "message" || message.role !== "assistant") { failed = true; return; }
        anthropicStart = record(message.usage);
        observe(usage(anthropicStart, "anthropic"));
      } else if (value.type === "message_delta") {
        const deltaUsage = record(value.usage);
        if (!anthropicStart || !deltaUsage || count(deltaUsage.output_tokens) === null) { failed = true; return; }
        // Usage fields are cumulative snapshots. Preserve omitted fields from
        // the last snapshot, but validate every supplied input/cache update too:
        // ignoring them would undercount providers reporting revised totals.
        const nextUsage = { ...anthropicStart, ...deltaUsage };
        observe(usage(nextUsage, "anthropic"));
        if (!failed) anthropicStart = nextUsage;
        anthropicDelta = true;
      } else if (value.type === "message_stop") {
        if (!anthropicStart || !anthropicDelta || !observed) failed = true;
        ended = true;
      } else if (value.type !== "ping" && (!anthropicStart || !["content_block_start", "content_block_delta", "content_block_stop"].includes(value.type))) failed = true;
    }
  };
  const consume = (text: string): void => {
    buffer += text;
    if (!isSse) { if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) failed = true; return; }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      frameBytes += Buffer.byteLength(line) + 1;
      if (frameBytes > MAX_FRAME_BYTES) { failed = true; break; }
      if (!line) frame();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (!line.startsWith(":")) { failed = true; break; }
      if (failed) break;
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) failed = true;
  };
  return {
    push(chunk) {
      if (finished) { failed = true; return; }
      if (failed) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) { failed = true; buffer = ""; data = []; return; }
      try { consume(decoder.decode(bytes, { stream: true })); } catch { failed = true; }
    },
    finish() {
      if (!finished && !failed) {
        try { consume(decoder.decode()); } catch { failed = true; }
        if (isSse) {
          // A partial SSE frame is not evidence of a completed response.
          if (buffer.trim() || data.length || eventName || !ended) failed = true;
        } else {
          const value = parse(buffer);
          if (!value || value.error != null) failed = true;
          else if (protocol === "chat" && value.object === completionObject) {
            if (!Array.isArray(value.choices) || !value.choices.length || value.choices.some(item => typeof record(item)?.finish_reason !== "string")) failed = true;
            else observe(usage(value.usage, "chat"));
          }
          else if (protocol === "responses" && value.object === "response" && value.status === "completed" && value.incomplete_details == null) observe(usage(value.usage, "responses"));
          else if (protocol === "anthropic" && value.type === "message" && value.role === "assistant" && typeof value.stop_reason === "string") observe(usage(value.usage, "anthropic"));
          else failed = true;
        }
      }
      finished = true;
      return failed || !observed ? null : { ...observed };
    },
  };
}
