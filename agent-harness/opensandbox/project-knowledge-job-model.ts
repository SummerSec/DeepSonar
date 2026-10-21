/** Deterministic Anthropic transport; the Bash actor and Control API remain real. */
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function startKnowledgeJobModel() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      response.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
      if (request.url?.includes("count_tokens")) { response.end(JSON.stringify({ input_tokens: 1000 })); return; }
      assert.ok(++calls <= 32, "knowledge model request budget exhausted");
      const results = (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block.type === "tool_result" && block.tool_use_id === "toolu_knowledge_actor");
      const result = results[0];
      const detail = typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? "");
      const failed = result && (result.is_error || /Exit code\s+(?!0\b)\d+|AssertionError|Traceback|KNOWLEDGE_ACTOR_FAILED/i.test(detail));
      const content = !result
        ? { type: "tool_use", id: "toolu_knowledge_actor", name: "Bash", input: {
          command: "python3 /workspace/knowledge-job-actor.py", timeout: 600000,
          description: "Execute real knowledge Control API checks in the sandbox",
        } }
        : { type: "text", text: failed ? `KNOWLEDGE_ACTOR_FAILED ${detail.slice(0, 500)}` : "Knowledge actor finished; Scheduler owns the outcome." };
      const stop = content.type === "tool_use" ? "tool_use" : "end_turn";
      const message = { id: "msg_knowledge_job", type: "message", role: "assistant", model: body.model,
        content: [content], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 50 } };
      if (!body.stream) { response.end(JSON.stringify(message)); return; }
      const event = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
      if (content.type === "tool_use") {
        event("content_block_start", { index: 0, content_block: { ...content, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: content.text } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } });
      event("message_stop", {}); response.end();
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: { type: "api_error", message: String(error) } })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
