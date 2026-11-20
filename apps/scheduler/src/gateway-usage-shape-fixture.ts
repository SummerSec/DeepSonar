/** Synthetic protocol bytes shared by the real HTTP/PG integration fixtures. */
export function anthropicUsageShapeCases() {
  const event = (value: unknown, name?: string) => `${name ? `event: ${name}\r\n` : ""}data: ${JSON.stringify(value)}\r\n\r\n`;
  const start = event({ type: "message_start", message: { type: "message", role: "assistant",
    usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
  const pending = event({ type: "message_start", message: { type: "message", role: "assistant",
    usage: { input_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
  const content = event({ type: "content_block_delta", delta: { type: "text_delta", text: "SYNTHETIC_PRIVATE_CONTENT" },
    SYNTHETIC_PRIVATE_KEY: "SYNTHETIC_PRIVATE_VALUE" });
  const empty = event({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  const final = event({ type: "message_delta", usage: { output_tokens: 3 }, delta: { stop_reason: "end_turn" } });
  const stop = event({ type: "message_stop" });
  return [
    { name: "start_only", body: start + stop, known: false },
    { name: "content_without_final", body: start + content + stop, known: false },
    { name: "stop_reason_only", body: start + content + empty + stop, known: false },
    { name: "final_then_absent", body: start + content + final + empty + stop, known: true },
    { name: "pending_completed", body: pending + content + empty + final + stop, known: true },
    { name: "pending_without_final", body: pending + empty + stop, known: false },
    { name: "invalid_after_final", body: start + final + event({ type: "message_delta", usage: null }) + stop, known: false },
    { name: "unknown_event", body: start + event({ type: "SYNTHETIC_PRIVATE_EVENT" }) + final + stop, known: false },
  ];
}
