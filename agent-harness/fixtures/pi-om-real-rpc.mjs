import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { RpcClient } from "./pi-rpc-client.mjs";
import { FROZEN_CONFIG, MODEL, OM_PROVIDER, OBSERVATION, REFLECTION } from "./pi-om-config.mjs";

const IMAGE_OM_ROOT = "/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory";
const IMAGE_WRAPPER = "/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts";
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const observationId = createHash("sha256").update(OBSERVATION).digest("hex").slice(0, 12);
const privateProse = new RegExp(`${OBSERVATION}|${REFLECTION}`, "u");

function resolveCli(binary) {
  let executable = binary;
  if (!path.isAbsolute(executable)) executable = process.env.PATH.split(path.delimiter)
    .map((dir) => path.join(dir, binary)).find(existsSync);
  assert.ok(executable, "Pi CLI is unavailable; provide DEEPSONAR_PI_BINARY pointing to dist/cli.js");
  if (/\.(?:cmd|ps1)$/iu.test(executable)) executable = path.join(path.dirname(executable), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  executable = realpathSync(executable);
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(executable), "../package.json"), "utf8"));
  assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
  assert.equal(pkg.version, "1.4.0", "real RPC smoke requires the pinned Pi CLI");
  return executable;
}

async function loadBoundaries(root) {
  const dir = process.env.DEEPSONAR_RPC_BOUNDARY_DIR ?? path.join(REPO, "packages/runtime-sandbox/src");
  const load = async (name, source) => {
    const file = path.join(root, `${name}.mjs`);
    writeFileSync(file, stripTypeScriptTypes(source, { mode: "transform", sourceUrl: `${name}.ts` }));
    return { file, module: await import(pathToFileURL(file).href) };
  };
  const redactor = await load("redactor", readFileSync(path.join(dir, "pi-observational-memory.ts"), "utf8"));
  const framer = await load("framer", readFileSync(path.join(dir, "pi-jsonl-framer.ts"), "utf8"));
  const adapter = readFileSync(path.join(dir, "runtime-adapters.ts"), "utf8");
  const parser = await load("parser", adapter.slice(adapter.indexOf("const PI_RPC_EVENT_TYPES"), adapter.indexOf("const ALL_IMAGE_KEYS")));
  const capture = await load("capture", readFileSync(path.join(dir, "pi-rpc-output.ts"), "utf8")
    .replace('"./pi-observational-memory.js"', JSON.stringify(pathToFileURL(redactor.file).href)));
  return { ...redactor.module, ...framer.module, ...parser.module, ...capture.module };
}

async function fakeGateway(scenario) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        assert.ok(Buffer.byteLength(text) <= 16 * 1024 * 1024);
      }
      const body = JSON.parse(text);
      const workload = req.url.startsWith("/om/") ? "observational_memory" : "main";
      assert.match(req.url, /^\/(?:main|om)\/chat\/completions$/u);
      assert.equal(req.headers.authorization, `Bearer offline-${workload}`);
      assert.equal(body.model, MODEL);
      const names = body.tools?.map((tool) => tool.function.name) ?? [];
      const stage = names.includes("record_observations") ? "observer" : names.includes("record_reflections") ? "reflector" : "main";
      assert.equal(stage === "main", workload === "main", "worker escaped its attributed Gateway route");
      // Synthetic usage follows request size so the real plugin's progress
      // watermark sees new context rather than an impossible constant window.
      const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(text) / 4));
      const row = { workload, model: body.model, stage, status: 200, input_bytes: Buffer.byteLength(text), total_tokens: promptTokens + 16,
        tool_acks: body.messages.filter((message) => message.role === "tool").map((message) =>
          typeof message.content === "string" ? message.content.slice(0, 512) : "nontext") };
      requests.push(row);
      if (workload !== "main" && ["quota", "transient", "permission", "unknown", "protocol"].includes(scenario)) {
        row.status = scenario === "quota" ? 429 : scenario === "transient" ? 503 : scenario === "permission" ? 403 : 409;
        row.total_tokens = null;
        if (scenario === "protocol") {
          row.status = 200;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("data: {invalid-json-from-offline-gateway}\n\ndata: [DONE]\n\n");
          return;
        }
        const error = scenario === "quota" ? { type: "quota_exhausted", message: "request quota exhausted" }
          : scenario === "transient" ? { type: "gateway_transient", effect_status: "not_started" }
            : scenario === "unknown" ? { type: "workload_usage_unknown" }
              : scenario === "permission" ? { type: "frozen_model_mismatch" } : { type: "malformed_response" };
        // SDK errors preserve message, so include the structured Gateway code
        // in the transient/unknown fixture's message as well.
        if (!error.message) error.message = JSON.stringify({ error: { ...error } });
        res.writeHead(row.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
        return;
      }
      const transcript = JSON.stringify(body.messages);
      let tool;
      if (stage === "observer" && !body.messages.some((message) => message.role === "tool")) {
        const source = transcript.match(/Source entry id: ([^\]\\\s]+)/u)?.[1];
        assert.ok(source, "actual observer input must carry source identities");
        // Preserve the target observation's source association. Reusing its
        // content for later chunks would deliberately deduplicate its id and
        // replace the large source with a subsequent short assistant entry.
        const content = transcript.includes("Source entry with large content:") ? OBSERVATION : `${OBSERVATION}_OTHER_${source}`;
        tool = { name: "record_observations", arguments: { observations: [{ timestamp: "2026-10-31 12:00",
          content, relevance: "high", sourceEntryIds: [source] }] } };
      } else if (stage === "reflector" && !body.messages.some((message) => message.role === "tool")) {
        const ids = [...transcript.matchAll(/\[([a-f0-9]{12})\] [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}/gu)].map((match) => match[1]);
        const support = ids.includes(observationId) ? observationId : ids[0];
        assert.ok(support, "actual reflector input must carry an allowed observation id");
        const content = support === observationId ? REFLECTION : `${REFLECTION}_OTHER_${support}`;
        tool = { name: "record_reflections", arguments: { reflections: [{ content, supportingObservationIds: [support] }] } };
      } else if (stage === "main" && transcript.includes("RECALL_NOW")
        && !body.messages.some((message) => message.role === "tool" && message.tool_call_id === "recall-call")) {
        tool = { name: "recall", arguments: { id: observationId } };
      }
      const id = `offline-${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk",
        created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      chunk({ role: "assistant" });
      if (tool) chunk({ tool_calls: [{ index: 0, id: stage === "main" ? "recall-call" : `${stage}-record`,
        type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
      else chunk({ content: stage === "main" && !names.length ? "NATIVE_SUMMARY" : "offline completed" });
      chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: promptTokens, completion_tokens: 16, total_tokens: promptTokens + 16 });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      server.fixtureError = error;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "offline fixture rejected request" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, port: server.address().port };
}

function configure(root, port, wrapper, scenario) {
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, ".pi/extensions"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const hostile = { "observational-memory": { passive: true, debugLog: true, observeAfterTokens: 99999999,
    model: { provider: "untrusted", id: "override" } } };
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ ...hostile,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 } }));
  writeFileSync(path.join(workspace, ".pi/settings.json"), JSON.stringify(hostile));
  writeFileSync(path.join(workspace, ".pi/extensions/forbidden.ts"), 'throw new Error("PROJECT_EXTENSION_AUTO_LOADED");');
  const model = { id: MODEL, name: "Offline RPC fixture", reasoning: false, input: ["text"],
    contextWindow: 1000000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: {
    "offline-main": { baseUrl: `http://127.0.0.1:${port}/main`, api: "openai-completions", apiKey: "offline-main", models: [model] },
    [OM_PROVIDER]: { baseUrl: `http://127.0.0.1:${port}/om`, api: "openai-completions", apiKey: "offline-observational_memory", models: [model] },
  } }));
  const extension = path.join(root, "governed.ts");
  const bootstrap = scenario === "disabled" ? "" : `createGovernedObservationalMemoryExtension(${JSON.stringify(FROZEN_CONFIG)})(pi);`;
  const mutate = scenario === "config-drift" ? `pi.on("agent_start", () => {
    const dir = fs.readdirSync(os.tmpdir()).find((name) => name.startsWith("deepsonar-om-"));
    const settings = path.join(os.tmpdir(), dir, "agent/settings.json");
    fs.chmodSync(settings, 0o600); fs.writeFileSync(settings, "{}");
  });` : "";
  writeFileSync(extension, `import fs from "node:fs"; import os from "node:os"; import path from "node:path";
    import { createGovernedObservationalMemoryExtension } from ${JSON.stringify(wrapper)};
    export default function(pi) { ${mutate} ${bootstrap} }`);
  return { home, workspace, extension };
}

export async function runRealPiRpc() {
  // Fail before creating subprocesses or opening a listener if Pi is missing.
  const cli = resolveCli(process.env.DEEPSONAR_PI_BINARY ?? "pi");
  const root = mkdtempSync(path.join(tmpdir(), "deepsonar-real-om-rpc-"));
  const reports = [];
  try {
    const boundary = await loadBoundaries(root);
    const omRoot = process.env.DEEPSONAR_PI_OM_PACKAGE ?? (existsSync(IMAGE_OM_ROOT) ? IMAGE_OM_ROOT : path.join(REPO, ".tmp-om-3.1.4/package"));
    assert.equal(JSON.parse(readFileSync(path.join(omRoot, "package.json"), "utf8")).version, "3.1.4");
    const originalWrapper = existsSync(IMAGE_WRAPPER) ? IMAGE_WRAPPER : path.join(REPO, "agent-harness/pi-observational-memory-governed.ts");
    const wrapper = path.join(root, "tested-wrapper.ts");
    // Test-only path relocation. The implementation and canonical published
    // plugin bytes are unchanged; production has no override environment flag.
    writeFileSync(wrapper, readFileSync(originalWrapper, "utf8").replaceAll(`${IMAGE_OM_ROOT}/src/`, `${omRoot.replaceAll("\\", "/")}/src/`));
    for (const scenario of ["success", "quota", "transient", "permission", "unknown", "protocol", "config-drift", "disabled"]) {
      const scenarioRoot = path.join(root, scenario);
      mkdirSync(scenarioRoot);
      const gateway = await fakeGateway(scenario);
      let client;
      try {
        const paths = configure(scenarioRoot, gateway.port, wrapper.replaceAll("\\", "/"), scenario);
        const start = (sessionFile) => new RpcClient(cli, ["--provider", "offline-main", "--model", MODEL,
          "-e", paths.extension, ...(sessionFile ? ["--session", sessionFile] : [])], {
          cwd: paths.workspace, env: { ...process.env, HOME: paths.home, USERPROFILE: paths.home,
            PI_CODING_AGENT_DIR: paths.home, PI_OBSERVATIONAL_MEMORY_PASSIVE: "1", TEMP: scenarioRoot, TMPDIR: scenarioRoot },
        }, boundary.PiJsonlFramer, (line) => boundary.parsePiJsonlRecord(line, 8 * 1024 * 1024));
        client = start();
        const state = await client.command("get_state");
        assert.equal(state.success, true);
        const hard = ["permission", "unknown", "protocol", "config-drift"].includes(scenario);
        await client.turn("Source entry with large content: " + "original-source-detail ".repeat(scenario === "success" ? 60000 : 200), hard);
        if (hard) {
          assert.ok(client.records.some((record) => record.type === "extension_error"), "background hard failure was swallowed");
        } else if (scenario === "success") {
          assert.ok(gateway.requests.some((row) => row.stage === "observer"));
          assert.ok(client.records.some((record) => record.type === "entry_appended"
            && record.entry?.customType === "om.observations.recorded"), "the actual observer must commit its session entry before settlement");
          // The bounded observer first covers Pi's preceding system entry.
          // Advance another real turn to cover the large user entry before
          // asking for the observation linked specifically to that entry.
          await client.turn("Observe the remaining original source before recall.");
          await client.turn("RECALL_NOW");
          assert.ok(gateway.requests.some((row) => row.stage === "reflector"), "the actual reflector must run after observer state is committed");
          // The production parser already redacts memory. Inspect the actual
          // wire result first so redaction cannot hide an oversized recall.
          const recall = client.wireRecalls.find((record) => !record.isError);
          assert.ok(recall && !recall.isError, "actual recall tool did not succeed");
          assert.ok(recall.result.details.sourceCharacterCount > 1024 * 1024, "recall must recover the actual large original source");
          assert.ok(Buffer.byteLength(JSON.stringify(recall.result)) <= 128 * 1024);
          assert.ok(recall.result.details.sourceEntries.length > 0);
          for (const source of recall.result.details.sourceEntries) assert.ok(Buffer.byteLength(source.content ?? "") <= 16 * 1024);
          const safe = boundary.redactPiObservationalMemory(recall);
          assert.doesNotMatch(JSON.stringify(safe), privateProse);
          assert.equal(safe.toolCallId, recall.toolCallId);
          assert.doesNotMatch(JSON.stringify(safe), /original-source-detail/u);
          const sessionFile = state.data.sessionFile;
          const safeArchive = boundary.redactPiObservationalMemoryText(readFileSync(sessionFile, "utf8"));
          assert.doesNotMatch(safeArchive, privateProse);
          const copies = [];
          const capture = new boundary.PiRpcOutputCapture({ uploadFile: async (content) => { copies.push(content); } }, [],
            async ({ content }) => { copies.push(content); return "/evidence/offline.json"; }, () => {});
          const large = structuredClone(recall);
          large.result.content[0].text = OBSERVATION.repeat(60000);
          await capture.prepare(large, Buffer.byteLength(JSON.stringify(large)));
          assert.equal(copies.length, 2);
          for (const copy of copies) assert.doesNotMatch(copy, privateProse);
          const beforeResume = gateway.requests.filter((row) => row.workload !== "main").length;
          await client.stop(true);
          for (const settingsFile of [path.join(paths.home, "settings.json"), path.join(paths.workspace, ".pi/settings.json")]) {
            const changed = JSON.parse(readFileSync(settingsFile, "utf8"));
            changed["observational-memory"] = { passive: true, observeAfterTokens: 99999999,
              model: { provider: "changed-between-processes", id: "forbidden" } };
            writeFileSync(settingsFile, JSON.stringify(changed));
          }
          client = start(sessionFile);
          const resumed = await client.command("get_state");
          assert.equal(resumed.data.sessionId, state.data.sessionId);
          assert.equal(resumed.data.sessionFile, sessionFile);
          await client.turn("Same Job recovery with additional source context.");
          assert.ok(gateway.requests.filter((row) => row.workload !== "main").length > beforeResume);
          const invalid = await client.command("set_model", { provider: "forbidden", modelId: "override" });
          assert.equal(invalid.success, false);
          const compacted = await client.command("compact");
          assert.equal(compacted.success, true);
          assert.doesNotMatch(JSON.stringify(boundary.redactPiObservationalMemory(compacted)), privateProse);
        } else {
          const degraded = client.records.find((record) => record.type === "message_end" && record.message?.customType === "deepsonar.om.status");
          assert.equal(Boolean(degraded), scenario !== "disabled", "expected worker failure must be visible over RPC");
          if (degraded) assert.equal(degraded.message.details.fallback, "native_compaction");
          const compacted = await client.command("compact");
          assert.equal(compacted.success, true);
          assert.match(JSON.stringify(compacted.data), /NATIVE_SUMMARY/u, "native model compaction did not run");
          assert.doesNotMatch(JSON.stringify(compacted.data), /om.folded/u);
          if (scenario === "disabled") assert.ok(gateway.requests.every((row) => row.workload === "main"));
        }
        if (gateway.server.fixtureError) throw gateway.server.fixtureError;
        assert.doesNotMatch(client.stderr, privateProse);
        assert.doesNotMatch(client.stderr, /PROJECT_EXTENSION_AUTO_LOADED/u);
        const counts = { scenario, main: gateway.requests.filter((row) => row.workload === "main").length,
          background: gateway.requests.filter((row) => row.workload !== "main").length,
          observer: gateway.requests.filter((row) => row.stage === "observer").length,
          reflector: gateway.requests.filter((row) => row.stage === "reflector").length,
          frames: client.records.length };
        reports.push(counts);
        console.log(JSON.stringify({ pi_rpc_offline: "passed", ...counts }));
      } catch (error) {
        console.error(JSON.stringify({ pi_rpc_offline: "failed", scenario, requests: gateway.requests,
          entries: client?.records.filter((record) => record.type === "entry_appended").map((record) => record.entry?.customType),
          errors: client?.records.filter((record) => record.type === "extension_error").map((record) => String(record.error).match(/PI_OM_[A-Z0-9_]+/u)?.[0] ?? "other"),
          recalls: client?.records.filter((record) => record.type === "tool_execution_end" && record.toolName === "recall").map((record) => ({
            status: record.result?.details?.status, sourceCharacterCount: record.result?.details?.sourceCharacterCount,
            sources: record.result?.details?.sourceEntries?.map((entry) => ({ id: entry.id, length: entry.content?.length })) })) }));
        throw error;
      } finally {
        if (client) await client.stop();
        gateway.server.closeAllConnections();
        await new Promise((resolve) => gateway.server.close(resolve));
      }
    }
    return reports;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
