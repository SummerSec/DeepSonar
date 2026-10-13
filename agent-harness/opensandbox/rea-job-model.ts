/** Local deterministic Anthropic transport. Only planning is mocked, never tools. */
import assert from "node:assert/strict";
import { createServer } from "node:http";

function toolBlocks(message: any): any[] {
  return Array.isArray(message?.content) ? message.content : [];
}

function actorToolResult(messages: any[]): { seen: boolean; failed: boolean; detail: string } {
  for (const message of messages ?? []) {
    for (const block of toolBlocks(message)) {
      if (block?.type !== "tool_result" || block.tool_use_id !== "toolu_rea_e2e") continue;
      const text = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((part: any) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n")
          : JSON.stringify(block.content ?? "");
      const failed = block.is_error === true
        || /Exit code\s+(?!0\b)\d+/i.test(text)
        || /AssertionError|Traceback|REA_ACTOR_FAILED/i.test(text);
      return { seen: true, failed, detail: text.slice(0, 800) };
    }
  }
  return { seen: false, failed: false, detail: "" };
}

function failReportSeen(messages: any[]): boolean {
  return (messages ?? []).some((message: any) => toolBlocks(message).some((block: any) =>
    block?.type === "tool_result" && block.tool_use_id === "toolu_rea_fail_report"));
}

export async function startReaJobModel() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (request.url?.includes("count_tokens")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ input_tokens: 2000 }));
        return;
      }
      calls++;
      assert.ok(calls <= 50, "deterministic model request budget exhausted");
      const messages = body.messages ?? [];
      const actor = actorToolResult(messages);
      let content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>;
      let stop: "end_turn" | "tool_use";
      if (!actor.seen) {
        content = [{ type: "tool_use", id: "toolu_rea_e2e", name: "Bash", input: {
          command: "python3 /workspace/rea-job-actor.py", timeout: 600000,
          description: "Run deterministic REA integration actor with real tools and governed Control API",
        } }];
        stop = "tool_use";
      } else if (actor.failed && !failReportSeen(messages)) {
        // Surface the real actor error via Control API, then refuse mark_job_done
        // so the Job fails with the egress/actor cause rather than silent text loops.
        const encoded = Buffer.from(`REA_ACTOR_FAILED ${actor.detail}`.slice(0, 1500)).toString("base64");
        const reportPy = [
          "import base64,json,os,urllib.request,uuid",
          `msg=base64.b64decode('${encoded}').decode()`,
          "req=urllib.request.Request(os.environ['DEEPSONAR_API_BASE_URL'].rstrip('/')+'/operations/emit_progress', data=json.dumps({'message': msg[:1500]}).encode(), method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['DEEPSONAR_API_TOKEN'],'Idempotency-Key':str(uuid.uuid4())})",
          "try:",
          " urllib.request.urlopen(req, timeout=15)",
          "except Exception as exc:",
          " print('emit_progress_failed', exc)",
          "raise SystemExit(1)",
        ].join("\n");
        content = [{ type: "tool_use", id: "toolu_rea_fail_report", name: "Bash", input: {
          command: `python3 -c ${JSON.stringify(reportPy)}`,
          timeout: 30000,
          description: "Report actor failure through Control API without marking the Job done",
        } }];
        stop = "tool_use";
      } else if (actor.failed) {
        content = [{ type: "text", text: "REA test actor failed; refusing mark_job_done so Scheduler keeps the failure. Detail was emitted as REA_ACTOR_FAILED." }];
        stop = "end_turn";
      } else {
        content = [{ type: "text", text: "REA test actor finished; authoritative outcome is in the Control API and Scheduler." }];
        stop = "end_turn";
      }
      const message = { id: "msg_rea_e2e", type: "message", role: "assistant", model: body.model,
        content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 100 } };
      if (!body.stream) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(message));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      const event = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2000, output_tokens: 0 } } });
      const block = content[0]!;
      if (block.type === "tool_use") {
        event("content_block_start", { index: 0, content_block: { ...block, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 100 } });
      event("message_stop", {});
      response.end();
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { type: "api_error", message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
