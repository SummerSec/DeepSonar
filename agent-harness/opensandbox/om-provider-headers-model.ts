/** Deterministic provider only. Pi, OM, SDK, Gateway and launch remain production. */
import assert from "node:assert/strict";
import { createServer } from "node:http";

export const OM_HEADERS_MODEL = "om-headers-selected";
export const OM_HEADERS_PROVIDER = "selected";
export const OM_HEADERS_SECRET = "offline-om-headers-fixture-key";
export type OmHeaderCall = { stage: string; model: string; providerHeader: string; modelHeader: string; requestId: string | null; inputTokens: number; outputTokens: number; totalTokens: number };

export async function startOmHeaderModel() {
  const calls: OmHeaderCall[] = [];
  const errors: string[] = [];
  let observed = false;
  let completionAllowed = false;
  let mainCalls = 0;
  let completionSent = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, `Bearer ${OM_HEADERS_SECRET}`);
      assert.equal(req.headers["x-fixture-provider"], "selected-provider");
      assert.equal(req.headers["x-fixture-model"], "selected-model");
      assert.equal(req.headers["x-fixture-unselected"], undefined);
      assert.equal(req.headers["x-deepsonar-request-id"], undefined, "Gateway consumes internal correlation headers");
      const bytes: Buffer[] = [];
      for await (const chunk of req) bytes.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(bytes).toString("utf8"));
      assert.equal(body.model, OM_HEADERS_MODEL);
      const names = (body.tools ?? []).map((tool: any) => tool.function?.name);
      const stage = names.includes("record_observations") ? "observer" : names.includes("record_reflections") ? "reflector" : "main";
      assert.ok(calls.length < 40, "bounded offline model request count exceeded");
      const transcript = JSON.stringify(body.messages ?? []);
      const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(transcript) / 4));
      calls.push({ stage, inputTokens, outputTokens: 32, totalTokens: inputTokens + 32, model: body.model, providerHeader: String(req.headers["x-fixture-provider"]),
        modelHeader: String(req.headers["x-fixture-model"]), requestId: typeof req.headers["x-deepsonar-request-id"] === "string" ? req.headers["x-deepsonar-request-id"] : null });
      const messages = body.messages ?? [];
      let tool: { name: string; arguments: Record<string, unknown> } | undefined;
      if (stage === "observer") {
        const toolResult = messages.some((message: any) => message.role === "tool");
        if (!toolResult) {
          const source = transcript.match(/Source entry id: ([^\]\\\s]+)/u)?.[1];
          assert.ok(source, "canonical OM observer must provide an actual source entry id");
          tool = { name: "record_observations", arguments: { observations: [{ timestamp: "2026-11-05 12:00",
            content: `Offline header acceptance retained source ${source}.`, relevance: "high", sourceEntryIds: [source] }] } };
        } else {
          const results = messages.filter((message: any) => message.role === "tool").map((message: any) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
          assert.match(results, /Recorded [1-9][0-9]* new observations?/u, "canonical observer must actually record a source-backed observation");
          assert.doesNotMatch(results, /rejected/iu, "rejected observations cannot satisfy acceptance");
          observed = true;
        }
      } else if (stage === "reflector") {
        if (!messages.some((message: any) => message.role === "tool")) {
          const id = transcript.match(/\[([a-f0-9]{12})\] [0-9]{4}-[0-9]{2}-[0-9]{2}/u)?.[1];
          assert.ok(id, "canonical reflector must provide an observation id");
          tool = { name: "record_reflections", arguments: { reflections: [{ content: "Offline header acceptance reflection.", supportingObservationIds: [id] }] } };
        }
      } else {
        mainCalls++;
        const bash = names.find((name: string) => name.toLowerCase() === "bash");
        if (mainCalls === 1) {
          assert.ok(bash, "installed Pi must expose its real bash tool");
          // Fits Pi's normal 50 KiB tool-output limit while exceeding OM's
          // unmodified 10k-token observation threshold with diverse source text.
          tool = { name: bash, arguments: { command: "python3 - <<'PY'\nimport hashlib\nfor i in range(580):\n print('OM_HEADER_SOURCE_'+str(i)+' '+hashlib.sha256(str(i).encode()).hexdigest())\nPY" } };
        } else if (!completionAllowed) {
          assert.ok(bash);
          tool = { name: bash, arguments: { command: "sleep 1" } };
        } else if (observed && !completionSent) {
          assert.ok(bash); completionSent = true;
          const program = ["import json,os,urllib.request,uuid",
            "url=os.environ['DEEPSONAR_API_BASE_URL'].rstrip('/')+'/operations/mark_job_done'",
            "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['DEEPSONAR_API_TOKEN'],'Idempotency-Key':str(uuid.uuid4()),'X-Deepsonar-Proposal-Revision':'0'}",
            "req=urllib.request.Request(url,data=json.dumps({'summary':'Real Pi and OM completed the offline provider-header acceptance.'}).encode(),headers=headers,method='POST')",
            "print(urllib.request.urlopen(req,timeout=30).read().decode())"].join("\n");
          tool = { name: bash, arguments: { command: `python3 - <<'PY'\n${program}\nPY` } };
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `offline-header-${calls.length}`;
      const chunk = (delta: unknown, finish_reason: string | null = null, usage?: object) => res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created: 1, model: OM_HEADERS_MODEL,
        choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
      })}\n\n`);
      chunk({ role: "assistant" });
      if (tool) chunk({ tool_calls: [{ index: 0, id: `offline-tool-${calls.length}`, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
      else chunk({ content: "Offline provider-header acceptance turn complete." });
      chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: inputTokens, completion_tokens: 32, total_tokens: inputTokens + 32 });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      // Do not put request bodies or authentication values in public artifacts.
      errors.push(error instanceof Error ? error.name : "ModelFixtureError");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"type":"offline_fixture_assertion_failed"}}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, calls, errors, observed: () => observed,
    allowCompletion: () => { assert.ok(observed); completionAllowed = true; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
