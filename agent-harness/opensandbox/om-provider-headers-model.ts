/** Deterministic provider only. Pi, OM, SDK, Gateway and launch remain production. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const OM_HEADERS_MODEL = "om-headers-selected";
export const OM_HEADERS_PROVIDER = "selected";
export const OM_HEADERS_SECRET = "offline-om-headers-fixture-key";
export type OmHeaderCall = { stage: string; model: string; providerHeader: string; modelHeader: string; requestId: string | null; inputTokens: number; outputTokens: number; totalTokens: number };

export async function startOmHeaderModel() {
  const calls: OmHeaderCall[] = [];
  const catalogCalls: Array<{ method: string; path: string; providerHeader: string; modelHeader: string; returnedModels: string[] }> = [];
  const probeCalls: Array<{ model: string; providerHeader: string; modelHeader: string; status: number }> = [];
  const errors: string[] = [];
  const credentialProjectionStages = new Set<string>();
  const credentialNames = ["DEEPSONAR_GATEWAY_TOKEN", "DEEPSONAR_API_TOKEN"];
  const checkCredentialProjection = (text: string, stage: string) => {
    const envLine = text.match(/OM_CREDENTIAL_ENV (\{[^\n]+\})/u)?.[1];
    if (!envLine) return;
    const authLine = text.match(/OM_CREDENTIAL_AUTH (\{[^\n]+\})/u)?.[1];
    assert.ok(authLine, "actual auth-file tool output must accompany env output");
    const env = JSON.parse(envLine), auth = JSON.parse(authLine);
    for (const key of credentialNames) assert.equal(env[key], "[REDACTED]", "model-visible env credential must be redacted");
    assert.equal(auth[OM_HEADERS_PROVIDER]?.key, "[REDACTED]", "main auth-file credential must be redacted");
    assert.equal(auth.__deepsonar_observational_memory?.key, "[REDACTED]", "OM auth-file credential must be redacted");
    credentialProjectionStages.add(stage);
  };
  let observed = false;
  let completionAllowed = false;
  let omSequence = 0;
  let recallCallId: string | undefined;
  let recalled = false;
  let recallResultSha256: string | null = null;
  const sourcePrefix = Array.from({ length: 8 }, (_, i) => `OM_HEADER_SOURCE_${i} ${createHash("sha256").update(String(i)).digest("hex")}`).join("\n");
  let expectedObservation: { id: string; content: string; source: string } | undefined;
  let mainCalls = 0;
  let completionCallId: string | undefined;
  let completionStatus: "not_started" | "pending" | "accepted" | "stopped" = "not_started";
  let completionCode: string | null = null;
  const completionCodes = new Set(["INACTIVE", "INITIAL_STATE_CONFLICT", "NOT_ALLOWED", "BUDGET_EXHAUSTED",
    "RESTORE_NOT_ALLOWED", "RESTORE_UNCONFIRMED", "REJECTED", "IDENTITY_CONFLICT", "RECOVERY_STOPPED",
    "REVISION_CONFLICT", "WAIT_EXHAUSTED", "CLIENT_ERROR"].map(code => `OM_COMPLETION_${code}`));
  const completionProgram = readFileSync(new URL("./om-provider-headers-completion.py", import.meta.url), "utf8");
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        assert.equal(req.headers.authorization, `Bearer ${OM_HEADERS_SECRET}`);
        assert.equal(req.headers["x-fixture-provider"], "selected-provider");
        assert.equal(req.headers["x-fixture-model"], "provider-default", "catalog discovery must not apply an inference model override");
        assert.equal(req.headers["x-fixture-unselected"], undefined);
        catalogCalls.push({ method: req.method, path: req.url,
          providerHeader: String(req.headers["x-fixture-provider"]), modelHeader: String(req.headers["x-fixture-model"]),
          returnedModels: [OM_HEADERS_MODEL] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: OM_HEADERS_MODEL, object: "model", created: 1, owned_by: "offline-fixture" }] }));
        return;
      }
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
      if (body.stream === undefined) {
        assert.equal(calls.length, 0, "readiness probe must precede the real Job");
        assert.equal(probeCalls.length, 0, "exactly one production readiness probe");
        assert.deepEqual(body, { model: OM_HEADERS_MODEL, max_tokens: 8, messages: [{ role: "user", content: "ping" }] });
        probeCalls.push({ model: body.model, providerHeader: String(req.headers["x-fixture-provider"]),
          modelHeader: String(req.headers["x-fixture-model"]), status: 200 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "offline-probe", object: "chat.completion", model: OM_HEADERS_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      const names = (body.tools ?? []).map((tool: any) => tool.function?.name);
      const stage = names.includes("record_observations") ? "observer" : names.includes("record_reflections") ? "reflector" : "main";
      assert.ok(calls.length < 40, "bounded offline model request count exceeded");
      const transcript = JSON.stringify(body.messages ?? []);
      const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(transcript) / 4));
      // Unique response usage identifies each actual OM exchange independently
      // of concurrent request arrival, finish order, or database timestamps.
      const outputTokens = stage === "main" ? 32 : 32 + ++omSequence;
      calls.push({ stage, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model: body.model, providerHeader: String(req.headers["x-fixture-provider"]),
        modelHeader: String(req.headers["x-fixture-model"]), requestId: typeof req.headers["x-deepsonar-request-id"] === "string" ? req.headers["x-deepsonar-request-id"] : null });
      const messages = body.messages ?? [];
      for (const message of messages) {
        const text = typeof message.content === "string" ? message.content
          : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        checkCredentialProjection(text, stage);
      }
      let tool: { name: string; arguments: Record<string, unknown> } | undefined;
      if (stage === "observer") {
        const toolResult = messages.some((message: any) => message.role === "tool");
        if (!toolResult) {
          const observerText = messages.map((message: any) => typeof message.content === "string" ? message.content
            : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")).join("\n");
          const sources = [...observerText.matchAll(/\[Source entry id: ([^\]\s]+)\]([\s\S]*?)(?=\[Source entry id:|$)/gu)];
          const selected = sources.find(entry => entry[2]!.includes(sourcePrefix)) ?? sources[0];
          assert.ok(selected, "canonical OM observer must provide an actual source entry id");
          const source = selected[1]!;
          const content = `Offline header acceptance retained observation number ${calls.length}.`;
          // Canonical OM 3.1.4 hashes observation content into this identity.
          // Only the real record_observations tool writes the native store.
          if (selected[2]!.includes(sourcePrefix)) expectedObservation ??= {
            id: createHash("sha256").update(content).digest("hex").slice(0, 12), content, source,
          };
          tool = { name: "record_observations", arguments: { observations: [{ timestamp: "2026-11-05 12:00",
            content, relevance: "high", sourceEntryIds: [source] }] } };
        } else {
          const results = messages.filter((message: any) => message.role === "tool").map((message: any) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
          assert.match(results, /Recorded [1-9][0-9]* new observations?/u, "canonical observer must actually record a source-backed observation");
          assert.doesNotMatch(results, /rejected/iu, "rejected observations cannot satisfy acceptance");
          if (expectedObservation && transcript.includes(expectedObservation.content)) observed = true;
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
        if (completionCallId && completionStatus === "pending") {
          const result = messages.find((message: any) => message.role === "tool" && message.tool_call_id === completionCallId);
          const resultText = typeof result?.content === "string" ? result.content : Array.isArray(result?.content)
            ? result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
          // Only this tool's fixed, receipt-backed marker permits the model to
          // end normally. An HTTP attempt or ordinary final text is not acceptance.
          const accepted = resultText.split("\n").some((line: string) => {
            try {
              const outcome = JSON.parse(line);
              if (outcome.om_completion === "stopped" && completionCodes.has(outcome.code)) completionCode = outcome.code;
              return outcome.om_completion === "accepted";
            } catch { return false; }
          });
          completionStatus = accepted ? "accepted" : "stopped";
          assert.ok(accepted, "OM completion client stopped without an accepted receipt");
        }
        if (recallCallId && !recalled) {
          const result = messages.find((message: any) => message.role === "tool" && message.tool_call_id === recallCallId);
          assert.ok(result, "real Pi must return the requested recall tool result before another main request");
          const resultText = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
          assert.ok(expectedObservation);
          // Native recall exposes SOURCE text to the model; observation prose
          // and sourceEntryIds live in details, not in OpenAI tool.content.
          assert.ok(resultText.includes(sourcePrefix), "real recall by recorded observation id must resolve the known synthetic source prefix");
          assert.match(resultText, /\[Tool result: bash @ /u);
          recallResultSha256 = createHash("sha256").update(resultText).digest("hex");
          recalled = true;
        }
        if (mainCalls === 1) {
          assert.ok(bash, "installed Pi must expose its real bash tool");
          // Fits Pi's normal 50 KiB tool-output limit while exceeding OM's
          // unmodified 10k-token observation threshold with diverse source text.
          tool = { name: bash, arguments: { command: "python3 - <<'PY'\nimport hashlib,json,os\nkeys=['DEEPSONAR_GATEWAY_TOKEN','DEEPSONAR_API_TOKEN']\nassert all(os.environ.get(k) for k in keys)\nassert not os.environ.get('DEEPSONAR_OM_GATEWAY_TOKEN')\nprint('OM_CREDENTIAL_ENV '+json.dumps({k:os.environ[k] for k in keys}))\nwith open('/workspace/.deepsonar-home/.pi/agent/auth.json') as f:\n print('OM_CREDENTIAL_AUTH '+json.dumps(json.load(f)))\nfor i in range(580):\n print('OM_HEADER_SOURCE_'+str(i)+' '+hashlib.sha256(str(i).encode()).hexdigest())\nPY" } };
        } else if (!completionAllowed) {
          assert.ok(bash);
          tool = { name: bash, arguments: { command: "sleep 1" } };
        } else if (!recallCallId) {
          assert.ok(expectedObservation); assert.ok(names.includes("recall"), "canonical OM must register its real recall tool");
          recallCallId = `offline-tool-${calls.length}`;
          completionAllowed = false;
          tool = { name: "recall", arguments: { id: expectedObservation.id } };
        } else if (observed && recalled && !completionCallId) {
          assert.ok(bash);
          completionCallId = `offline-tool-${calls.length}`;
          completionStatus = "pending";
          tool = { name: bash, arguments: { command: `python3 - <<'PY'\n${completionProgram}\nPY`, timeout: 120 } };
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
      chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens });
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
  return { url: `http://127.0.0.1:${address.port}`, calls, catalogCalls, probeCalls, errors, observed: () => observed,
    credentialProjectionEvidence: () => ({ main: credentialProjectionStages.has("main"), observer: credentialProjectionStages.has("observer") }),
    completionEvidence: () => ({ status: completionStatus, code: completionCode }),
    recallEvidence: () => ({ current_session_read_verified: recalled, successful_reads: recalled ? 1 : 0,
      verified_source_prefix_sha256: recalled ? createHash("sha256").update(sourcePrefix).digest("hex") : null,
      recall_result_sha256: recallResultSha256,
      observation_content_sha256: recalled && expectedObservation ? createHash("sha256").update(expectedObservation.content).digest("hex") : null,
      does_not_prove: ["reading stored observation prose", "reading sourceEntryIds JSON", "cross-process restart persistence", "public content export"] }),
    allowCompletion: () => { assert.ok(observed); completionAllowed = true; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
