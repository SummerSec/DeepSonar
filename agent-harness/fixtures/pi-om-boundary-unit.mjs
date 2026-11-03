// Unit doubles for the wrapper's boundary. These are NOT the real-plugin RPC
// acceptance fixture (pi-om-real-rpc.mjs); no memory algorithm is reproduced.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { FROZEN_CONFIG } from "./pi-om-config.mjs";

const doubleSource = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
export class Runtime {
  ensureConfig(cwd) {
    this.config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"))["observational-memory"];
    this.cwd = cwd;
  }
  launchConsolidationTask(_ctx, work) { return work().catch(() => {}); }
}
export function createAssistantMessageEventStream() {
  const queue = []; let done = false; let wake;
  return { push(event) { queue.push(event); wake?.(); }, end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!done || queue.length) {
      if (queue.length) yield queue.shift(); else await new Promise((resolve) => { wake = resolve; });
    } } };
}
export function streamSimple() { throw new Error("unit must supply an explicit stream"); }
export default function plugin(pi) {
  const runtime = new Runtime();
  pi.on("agent_start", (_event, ctx) => {
    runtime.ensureConfig(ctx.cwd);
    pi.capturedConfig = runtime.config;
    void runtime.launchConsolidationTask(ctx, async () => {
      const model = ctx.modelRegistry.find(runtime.config.model.provider, runtime.config.model.id);
      await ctx.modelRegistry.getApiKeyAndHeaders(model);
      for await (const event of ctx.modelRegistry.streamSimple(model, {}, {})) {
        if (event.type === "error") throw new Error(event.error.errorMessage);
      }
      pi.appendEntry("om.observations.recorded", { observations: [] });
    });
  });
  pi.on("session_before_compact", () => ({ compaction: { summary: "unit OM summary" } }));
  pi.registerTool({ name: "recall", execute: async () => pi.recallResult,
    renderResult: (result) => result });
  pi.registerCommand("om:view", { handler: () => { throw new Error("clipboard must never run"); } });
}
`;

export async function loadGovernedBoundary() {
  const doubleUrl = `data:text/javascript;base64,${Buffer.from(doubleSource).toString("base64")}`;
  let source = readFileSync(new URL("../pi-observational-memory-governed.ts", import.meta.url), "utf8");
  source = source.replace('"/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/src/index.ts"', JSON.stringify(doubleUrl))
    .replace('"/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/src/runtime.js"', JSON.stringify(doubleUrl))
    .replace('"@earendil-works/pi-ai/compat"', JSON.stringify(doubleUrl));
  const code = stripTypeScriptTypes(source, { mode: "transform", sourceUrl: "governed-om-unit.ts" });
  const { createGovernedObservationalMemoryExtension } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return { createGovernedObservationalMemoryExtension, config: structuredClone(FROZEN_CONFIG) };
}

// Feed an actual Gateway response (or an SDK's message-only carrier) through the
// production wrapper's worker, settle and compaction hooks; no classifier double.
export async function createFailureBoundary(errorMessage) {
  const { createGovernedObservationalMemoryExtension: create, config } = await loadGovernedBoundary();
  const root = mkdtempSync(path.join(tmpdir(), "om-gateway-boundary-"));
  const previous = Object.fromEntries(["TEMP", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_OBSERVATIONAL_MEMORY_PASSIVE"]
    .map((key) => [key, process.env[key]]));
  process.env.TEMP = root;
  process.env.TMPDIR = root;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
  const close = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  };
  const hooks = new Map();
  const messages = [];
  const entries = [];
  const model = { provider: config.model.provider, id: config.model.id, api: "openai-completions", baseUrl: "http://127.0.0.1/om" };
  const context = { cwd: root, mode: "rpc", hasUI: true,
    ui: { notify: () => { throw new Error("RPC must not create UI frames"); } },
    model: { provider: "main", id: "main", contextWindow: 1000000 },
    sessionManager: { getSessionId: () => "gateway-boundary", getSessionFile: () => path.join(root, "session.jsonl") },
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-unit" }),
      async *streamSimple() { yield { type: "error", error: { errorMessage } }; } },
  };
  const pi = { on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerTool() {}, registerCommand() {},
    sendMessage: (message) => messages.push(message), appendEntry: (...args) => entries.push(args),
  };
  try { create(config)(pi); } catch (error) { close(); throw error; }
  return { messages, entries, close,
    async event(name) { let result; for (const handler of hooks.get(name) ?? []) result = await handler({}, context); return result; },
  };
}
