import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { RpcClient } from "./pi-rpc-client.mjs";
import { FROZEN_CONFIG, MODEL, OM_PROVIDER, OBSERVATION, REFLECTION } from "./pi-om-config.mjs";
import { resolvePiPackage } from "../pi-image-packaging.mjs";

const IMAGE_OM_ROOT = "/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory";
const IMAGE_WRAPPER = "/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts";
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const observationId = createHash("sha256").update(OBSERVATION).digest("hex").slice(0, 12);
const privateProse = new RegExp(`${OBSERVATION}|${REFLECTION}`, "u");

function resolveCli(binary) {
  const { executable, metadata } = resolvePiPackage(binary);
  assert.equal(metadata.version, "1.4.0", "real RPC smoke requires the pinned Pi CLI");
  return executable;
}

async function loadBoundaries(root) {
  const dir = process.env.DEEPSONAR_RPC_BOUNDARY_DIR ?? path.join(REPO, "packages/runtime-sandbox/src");
  const load = async (name, source) => {
    const file = path.join(root, `${name}.mjs`);
    writeFileSync(file, stripTypeScriptTypes(source, { mode: "transform", sourceUrl: `${name}.ts` }));
    return { file, module: await import(pathToFileURL(file).href) };
  };
  const sharedPath = process.env.DEEPSONAR_RPC_BOUNDARY_DIR
    ? path.join(dir, "pi-observational-memory-redaction.ts")
    : path.join(REPO, "packages/shared-types/src/pi-observational-memory-redaction.ts");
  const shared = await load("memory-fields", readFileSync(sharedPath, "utf8"));
  const sharedImport = JSON.stringify(pathToFileURL(shared.file).href);
  const redactor = await load("redactor", readFileSync(path.join(dir, "pi-observational-memory.ts"), "utf8")
    .replace('"@deepsonar/shared-types"', sharedImport));
  const framer = await load("framer", readFileSync(path.join(dir, "pi-jsonl-framer.ts"), "utf8"));
  const adapter = readFileSync(path.join(dir, "runtime-adapters.ts"), "utf8");
  const parser = await load("parser", adapter.slice(adapter.indexOf("const PI_RPC_EVENT_TYPES"), adapter.indexOf("const ALL_IMAGE_KEYS")));
  const capture = await load("capture", readFileSync(path.join(dir, "pi-rpc-output.ts"), "utf8")
    .replace('"@deepsonar/shared-types"', sharedImport));
  return { ...shared.module, ...redactor.module, ...framer.module, ...parser.module, ...capture.module };
}

async function fakeGateway(scenario, options = {}) {
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
        // The eight failure scenarios record the canonical observation, so they
        // recall by its fixed id. The growth probe synthesises its own entries,
        // so it recalls the first id the plugin actually offered instead of
        // asserting against an id that session never contained.
        // The eight failure scenarios record the canonical observation verbatim,
        // so they keep recalling by its fixed id. Sessions that synthesise their
        // own entries (the growth probe) recall an id they actually recorded.
        const canonical = transcript.includes("Source entry with large content:");
        const offered = [...transcript.matchAll(/\[([a-f0-9]{12})\]/gu)].map((match) => match[1]);
        const id = canonical ? observationId : options.recallId?.() ?? offered[0];
        if (id) {
          options.onRecall?.(id);
          tool = { name: "recall", arguments: { id } };
        }
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
    const imageProof = process.env.DEEPSONAR_PI_IMAGE_PROOF === "1";
    if (imageProof) {
      assert.equal(process.env.DEEPSONAR_PI_OM_PACKAGE, undefined, "image proof cannot substitute a host plugin");
    }
    const omRoot = imageProof ? IMAGE_OM_ROOT
      : process.env.DEEPSONAR_PI_OM_PACKAGE ?? (existsSync(IMAGE_OM_ROOT) ? IMAGE_OM_ROOT : path.join(REPO, ".tmp-om-3.1.4/package"));
    assert.equal(JSON.parse(readFileSync(path.join(omRoot, "package.json"), "utf8")).version, "3.1.4");
    let wrapper = IMAGE_WRAPPER;
    if (imageProof) {
      assert.ok(existsSync(wrapper), "the built image must contain its production wrapper");
    } else {
      const originalWrapper = existsSync(IMAGE_WRAPPER) ? IMAGE_WRAPPER : path.join(REPO, "agent-harness/pi-observational-memory-governed.ts");
      wrapper = path.join(root, "tested-wrapper.ts");
      // Host-only testing relocates the immutable canonical package. Image
      // acceptance always imports the installed production wrapper directly.
      writeFileSync(wrapper, readFileSync(originalWrapper, "utf8").replaceAll(`${IMAGE_OM_ROOT}/src/`, `${omRoot.replaceAll("\\", "/")}/src/`));
    }
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

// ---------------------------------------------------------------- growth probe

// Byte accounting for #835 item 3. It measures what actually lands on disk per
// round and per session instead of trusting a client-side RSS sample, and it
// never reads file contents into the report so private prose cannot leak into
// an artifact.
function directoryBytes(directory, skip = new Set()) {
  const totals = new Map();
  let total = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (skip.has(absolute)) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        let size = 0;
        try { size = statSync(absolute).size; } catch { continue; }
        const bucket = path.relative(directory, absolute).split(path.sep)[0];
        totals.set(bucket, (totals.get(bucket) ?? 0) + size);
        total += size;
        files += 1;
      }
    }
  };
  walk(directory);
  return { total, files, buckets: Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b))) };
}

function findSessionFiles(directory, found = []) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) findSessionFiles(absolute, found);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(absolute);
  }
  return found;
}

// #835 item 3: bounded multi-round / multi-session load with per-round on-disk
// measurement. The assertions cover the *rules* (recall still resolves earlier
// material after a resume, private prose never reaches the report, every frame
// stays inside the framing limit) while the numbers are recorded for the
// artifact — no threshold is tuned to make the run pass.
export async function runGrowthProbe({ rounds = 4, resumeRounds = 3 } = {}) {
  const cli = resolveCli(process.env.DEEPSONAR_PI_BINARY ?? "pi");
  const root = mkdtempSync(path.join(tmpdir(), "deepsonar-om-growth-"));
  const imageProof = process.env.DEEPSONAR_PI_IMAGE_PROOF === "1";
  let client;
  let gateway;
  try {
    const boundary = await loadBoundaries(root);
    const omRoot = imageProof ? IMAGE_OM_ROOT
      : process.env.DEEPSONAR_PI_OM_PACKAGE ?? (existsSync(IMAGE_OM_ROOT) ? IMAGE_OM_ROOT : path.join(REPO, ".tmp-om-3.1.4/package"));
    assert.equal(JSON.parse(readFileSync(path.join(omRoot, "package.json"), "utf8")).version, "3.1.4");
    let wrapper = IMAGE_WRAPPER;
    if (imageProof) {
      assert.ok(existsSync(wrapper), "the built image must contain its production wrapper");
    } else {
      const originalWrapper = existsSync(IMAGE_WRAPPER) ? IMAGE_WRAPPER : path.join(REPO, "agent-harness/pi-observational-memory-governed.ts");
      wrapper = path.join(root, "tested-wrapper.ts");
      writeFileSync(wrapper, readFileSync(originalWrapper, "utf8").replaceAll(`${IMAGE_OM_ROOT}/src/`, `${omRoot.replaceAll("\\", "/")}/src/`));
    }
    const scenarioRoot = path.join(root, "growth");
    mkdirSync(scenarioRoot);
    // The growth probe synthesises its own entries, so the canonical fixture id
    // never exists in it. Recall targets an id frozen BEFORE the restart, which
    // is what "the resumed process still resolves pre-restart sources" means.
    const recallState = { id: null };
    const recallIssued = [];
    gateway = await fakeGateway("success", { recallId: () => recallState.id, onRecall: (id) => recallIssued.push(id) });
    const paths = configure(scenarioRoot, gateway.port, wrapper.replaceAll("\\", "/"), "success");
    const start = (sessionFile) => new RpcClient(cli, ["--provider", "offline-main", "--model", MODEL,
      "-e", paths.extension, ...(sessionFile ? ["--session", sessionFile] : [])], {
      cwd: paths.workspace, env: { ...process.env, HOME: paths.home, USERPROFILE: paths.home,
        PI_CODING_AGENT_DIR: paths.home, PI_OBSERVATIONAL_MEMORY_PASSIVE: "1", TEMP: scenarioRoot, TMPDIR: scenarioRoot },
    }, boundary.PiJsonlFramer, (line) => {
      // Frame size is the number of bytes that actually crossed the pipe, not the
      // length of a re-serialised object (UTF-16 characters, different escaping).
      largestFrameBytes = Math.max(largestFrameBytes, Buffer.byteLength(line, "utf8"));
      return boundary.parsePiJsonlRecord(line, 8 * 1024 * 1024);
    });
    const samples = [];
    let largestFrameBytes = 0;
    const sample = (label) => {
      samples.push({ label, agent: directoryBytes(paths.home), workspace: directoryBytes(paths.workspace),
        observerRequests: gateway.requests.filter((row) => row.stage === "observer").length,
        reflectorRequests: gateway.requests.filter((row) => row.stage === "reflector").length,
        frames: client.records.length });
    };
    client = start();
    assert.equal((await client.command("get_state")).success, true);
    for (let round = 1; round <= rounds; round += 1) {
      await client.turn(`Growth round ${round} source entry: ` + `session-one-detail ${round} `.repeat(300));
      sample(`session-1/round-${round}`);
    }
    const firstSession = findSessionFiles(paths.home).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    assert.ok(firstSession, "the first session must persist a transcript before the resume probe");
    // Freeze the pre-restart state BEFORE the process dies: the observation the
    // resumed process must still resolve, the source entries it has to name, and
    // the exact bytes of the ledger it must not rewrite.
    const frozenObservations = [];
    for (const record of client.records) {
      for (const observation of record.entry?.data?.observations ?? []) {
        if (observation?.id) frozenObservations.push({ id: String(observation.id),
          sources: (observation.sourceEntryIds ?? []).map(String) });
      }
    }
    assert.ok(frozenObservations.length > 0, "the first session must record at least one observation to freeze");
    const frozen = frozenObservations[0];
    const ledgerPrefix = readFileSync(firstSession);
    const ledgerPrefixSha256 = createHash("sha256").update(ledgerPrefix).digest("hex");
    recallState.id = frozen.id;
    await client.stop();
    client = start(firstSession);
    assert.equal((await client.command("get_state")).success, true);
    for (let round = 1; round <= resumeRounds; round += 1) {
      await client.turn(`Resumed session round ${round}: ` + `session-two-detail ${round} `.repeat(300));
      sample(`session-2/round-${round}`);
    }
    // History integrity is a statement about the frozen bytes, not about a total
    // directory size (new rounds or settings files could cover a truncated ledger).
    const resumedLedger = readFileSync(firstSession);
    assert.ok(resumedLedger.length >= ledgerPrefix.length, "the resumed session must not truncate the existing ledger");
    assert.equal(createHash("sha256").update(resumedLedger.subarray(0, ledgerPrefix.length)).digest("hex"),
      ledgerPrefixSha256, "the pre-restart ledger prefix must be preserved byte for byte");
    recallIssued.length = 0;
    await client.turn("RECALL_NOW");
    sample("session-2/recall");
    assert.deepEqual(recallIssued, [frozen.id], "the resumed session must recall exactly the frozen pre-restart observation");
    const recall = client.records.filter((record) => record.type === "tool_execution_end" && record.toolName === "recall").pop();
    const recallDetails = recall?.result?.details ?? {};
    assert.ok(recall, "the recall tool must actually run, otherwise its status is meaningless");
    const status = recallDetails.status ?? "missing";
    // Diagnostics stay at metadata level: the raw observation records carry
    // private prose and must never reach a log, even on the failure path.
    const safeDiagnostics = JSON.stringify({
      status,
      requestedId: frozen.id,
      stages: gateway.requests.reduce((counts, row) => ({ ...counts, [row.stage]: (counts[row.stage] ?? 0) + 1 }), {}),
      recordedTypes: client.records.map((record) => record.entry?.customType).filter(Boolean),
    });
    assert.equal(status, "ok", `recall of the frozen pre-restart observation must succeed: ${safeDiagnostics}`);
    const recallSources = (recallDetails.sourceEntries ?? []).map((entry) => String(entry.id));
    assert.ok(recallSources.length > 0, `recall must name sources: ${safeDiagnostics}`);
    for (const source of recallSources) {
      assert.ok(frozen.sources.includes(source),
        `recall must resolve pre-restart sources only: ${safeDiagnostics} sources=${JSON.stringify(recallSources)}`);
    }
    // Negative control: a session that never saw those records must NOT resolve
    // the frozen id, otherwise the positive case above proves nothing.
    await client.stop();
    client = start();
    assert.equal((await client.command("get_state")).success, true);
    recallIssued.length = 0;
    await client.turn("RECALL_NOW");
    const isolatedRecall = client.records.filter((record) => record.type === "tool_execution_end" && record.toolName === "recall").pop();
    assert.deepEqual(recallIssued, [frozen.id], "the negative control must query the same frozen id, not an unrelated one");
    assert.ok(isolatedRecall, "the negative control must actually run the recall tool; a missing call proves nothing");
    const isolatedStatus = isolatedRecall.result?.details?.status;
    // Exact answer only: a missing record, an internal error, or any other status
    // would also satisfy a loose "not ok" check and would hide a broken probe.
    assert.equal(isolatedStatus, "not_found",
      `a fresh session must answer not_found for pre-restart observations (got ${JSON.stringify(isolatedStatus)})`);
    const report = {
      pi_om_growth: "passed",
      rounds, resumeRounds,
      ledgerPrefixBytes: ledgerPrefix.length,
      ledgerPrefixSha256,
      largestFrameBytes,
      requests: gateway.requests.length,
      frozenObservationId: frozen.id,
      recallSources: recallSources.length,
      negativeControl: isolatedStatus,
      samples: samples.map((entry) => ({ label: entry.label, agentBytes: entry.agent.total, agentFiles: entry.agent.files,
        workspaceBytes: entry.workspace.total, observerRequests: entry.observerRequests,
        reflectorRequests: entry.reflectorRequests, frames: entry.frames, agentBuckets: entry.agent.buckets })),
      methodology: "synthetic scale only; bytes are on-disk totals per round, frame bytes are UTF-8 pipe bytes; "
        + "no public quality or SLA claim",
    };
    const artifactDirectory = process.env.DEEPSONAR_GROWTH_ARTIFACT_DIR;
    if (artifactDirectory) {
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(path.join(artifactDirectory, "pi-om-growth.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
    assert.ok(!privateProse.test(JSON.stringify(report)), "the growth artifact must not carry private prose");
    return report;
  } finally {
    if (client) await client.stop().catch(() => {});
    if (gateway) { gateway.server.closeAllConnections(); await new Promise((resolve) => gateway.server.close(resolve)); }
    rmSync(root, { recursive: true, force: true });
  }
}
