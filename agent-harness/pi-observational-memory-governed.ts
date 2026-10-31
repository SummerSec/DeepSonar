/**
 * Image-resident adapter for the canonical pi-observational-memory 3.1.4
 * source entry. The Scheduler stub supplies the frozen object; this file is
 * copied into the image and is the only supported OM loader.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import observationalMemory from "/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/src/index.ts";
// Match the upstream import specifier: jiti gives runtime.ts and runtime.js
// different class identities, so only runtime.js tracks the actual OM tasks.
import { Runtime } from "/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/src/runtime.js";
import { createAssistantMessageEventStream, streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

const VERSION = "3.1.4";
const INTEGRITY = "sha512-jgQbFyLMs4wWhkf6F0voOgzMwtIXsb8+ks0MsPKpPxkdpyMX5E/el6Mk/vJ40m8GlKwBIsCKjL1r7Z2U8dCtmA==";
const SCHEMA = "deepsonar.pi-observational-memory/v1";
const SETTINGS_KEY = "observational-memory";
const GATEWAY_PROVIDER = "__deepsonar_observational_memory";
const PACKAGE = "pi-observational-memory";
const MAX_RECALL_TEXT_BYTES = 16 * 1024;
const MAX_RECALL_ITEMS = 32;
const MAX_RECALL_RESULT_BYTES = 128 * 1024;
const REDACTED_RECALL = "[recall result truncated by DeepSonar]";
const MEMORY_CONTENT_KEYS = new Set([
  "content", "text", "summary", "sourceEntries", "source_entries", "observations", "reflections",
  "details", "directObservationMatches", "direct_observation_matches", "matches", "result", "output", "message",
]);

type FrozenConfig = {
  readonly schema: string;
  readonly package: string;
  readonly version: string;
  readonly integrity: string;
  readonly source_provider: string;
  readonly source_model: string;
  readonly model: { readonly provider: string; readonly id: string; readonly thinking: string };
  readonly observeAfterTokens: number;
  readonly reflectAfterTokens: number;
  readonly observerChunkMaxTokens: number | null;
  readonly compactAfterTokens: number;
  readonly compactAfterTokensMode: "calibrated" | "ratio";
  readonly compactAfterTokensRatio: number;
  readonly observationsPoolMaxTokens: number;
  readonly observationsPoolTargetTokens: number;
  readonly agentMaxTurns: number;
  readonly agentMaxTokens: number;
  readonly passive: false;
  readonly showWorkerNotifications: false;
  readonly debugLog: false;
  readonly request_budget?: {
    readonly total_requests: number;
    readonly main_requests: number;
    readonly background_requests: number;
  };
  readonly background_limits?: { readonly max_requests: number; readonly max_tokens: number };
};

type AnyRecord = Record<string, any>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(code: string): never {
  throw new Error(code);
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`PI_OM_CONFIG_INVALID:${name}`);
  return value as number;
}

function nonNegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`PI_OM_CONFIG_INVALID:${name}`);
  return value as number;
}

function rejectUnknownKeys(value: AnyRecord, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`PI_OM_CONFIG_FIELD_UNKNOWN:${label}.${key}`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as AnyRecord)) deepFreeze(entry);
  return value;
}

function validateFrozenConfig(input: unknown): FrozenConfig {
  if (!isRecord(input)) fail("PI_OM_CONFIG_INVALID:object");
  rejectUnknownKeys(input, [
    "schema", "package", "version", "integrity", "source_provider", "source_model", "model",
    "observeAfterTokens", "reflectAfterTokens", "observerChunkMaxTokens", "compactAfterTokens",
    "compactAfterTokensMode", "compactAfterTokensRatio", "observationsPoolMaxTokens",
    "observationsPoolTargetTokens", "agentMaxTurns", "agentMaxTokens", "passive",
    "showWorkerNotifications", "debugLog", "request_budget", "background_limits",
  ], "config");
  if (input.schema !== SCHEMA || input.package !== PACKAGE || input.version !== VERSION || input.integrity !== INTEGRITY) {
    fail("PI_OM_CONFIG_IDENTITY_MISMATCH");
  }
  if (typeof input.source_provider !== "string" || !input.source_provider.trim()) fail("PI_OM_SOURCE_PROVIDER_INVALID");
  if (typeof input.source_model !== "string" || !input.source_model.trim()) fail("PI_OM_SOURCE_MODEL_INVALID");
  if (!isRecord(input.model)) {
    fail("PI_OM_MODEL_SCOPE_INVALID");
  }
  rejectUnknownKeys(input.model, ["provider", "id", "thinking"], "model");
  if (input.model.provider !== GATEWAY_PROVIDER || input.model.id !== input.source_model) {
    fail("PI_OM_MODEL_SCOPE_INVALID");
  }
  if (!(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as string[]).includes(input.model.thinking)) {
    fail("PI_OM_MODEL_THINKING_INVALID");
  }
  const requiredPositive = [
    "observeAfterTokens", "reflectAfterTokens", "compactAfterTokens", "observationsPoolMaxTokens",
    "observationsPoolTargetTokens", "agentMaxTurns", "agentMaxTokens",
  ];
  for (const key of requiredPositive) positive(input[key], key);
  if (input.observerChunkMaxTokens !== null && input.observerChunkMaxTokens !== undefined) positive(input.observerChunkMaxTokens, "observerChunkMaxTokens");
  if (input.observationsPoolTargetTokens >= input.observationsPoolMaxTokens) fail("PI_OM_CONFIG_INVALID:observationsPoolTargetTokens");
  if (input.compactAfterTokensMode !== "calibrated" && input.compactAfterTokensMode !== "ratio") fail("PI_OM_CONFIG_INVALID:compactAfterTokensMode");
  if (typeof input.compactAfterTokensRatio !== "number" || !Number.isFinite(input.compactAfterTokensRatio) || input.compactAfterTokensRatio <= 0 || input.compactAfterTokensRatio >= 1) {
    fail("PI_OM_CONFIG_INVALID:compactAfterTokensRatio");
  }
  if (input.passive !== false || input.showWorkerNotifications !== false || input.debugLog !== false) fail("PI_OM_CONFIG_MUTABLE_FLAGS");

  if (input.request_budget !== undefined) {
    if (!isRecord(input.request_budget)) fail("PI_OM_CONFIG_INVALID:request_budget");
    rejectUnknownKeys(input.request_budget, ["total_requests", "main_requests", "background_requests"], "request_budget");
    const total = positive(input.request_budget.total_requests, "request_budget.total_requests");
    const main = positive(input.request_budget.main_requests, "request_budget.main_requests");
    const background = positive(input.request_budget.background_requests, "request_budget.background_requests");
    if (main + background > total) fail("PI_OM_ALLOCATION_EXCEEDS_TOTAL");
  }
  if (input.background_limits !== undefined) {
    if (!isRecord(input.background_limits)) fail("PI_OM_CONFIG_INVALID:background_limits");
    rejectUnknownKeys(input.background_limits, ["max_requests", "max_tokens"], "background_limits");
    const maxRequests = nonNegative(input.background_limits.max_requests, "background_limits.max_requests");
    nonNegative(input.background_limits.max_tokens, "background_limits.max_tokens");
    if (input.request_budget && maxRequests > input.request_budget.background_requests) fail("PI_OM_BACKGROUND_LIMIT_EXCEEDS_ALLOCATION");
  }
  return deepFreeze({ ...input, model: { ...input.model } }) as FrozenConfig;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  maxBytes -= Buffer.byteLength(`\n${REDACTED_RECALL}`, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return `${value.slice(0, end)}\n${REDACTED_RECALL}`;
}

function boundRecallValue(value: unknown, key = "", seen = new WeakSet<object>(), changed = { value: false }): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_RECALL_TEXT_BYTES) changed.value = true;
    return utf8Prefix(value, MAX_RECALL_TEXT_BYTES);
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_RECALL_ITEMS) changed.value = true;
    const output = value.slice(0, MAX_RECALL_ITEMS).map((entry) => boundRecallValue(entry, key, seen, changed));
    seen.delete(value);
    return output;
  }
  const output: AnyRecord = {};
  for (const [entryKey, entry] of Object.entries(value as AnyRecord)) {
    output[entryKey] = boundRecallValue(entry, entryKey, seen, changed);
  }
  seen.delete(value);
  return output;
}

function recallResultTooLarge(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RECALL_RESULT_BYTES;
  } catch {
    return true;
  }
}

function boundRecallResult(value: unknown): unknown {
  const changed = { value: false };
  const bounded = boundRecallValue(value, "", new WeakSet<object>(), changed);
  if (changed.value && isRecord(bounded) && isRecord(bounded.details)) {
    bounded.details.partial = true;
    if (bounded.details.status === "ok") bounded.details.status = "partial";
  }
  if (!recallResultTooLarge(bounded)) return bounded;
  if (!isRecord(bounded)) return { content: [{ type: "text", text: REDACTED_RECALL }] };
  const details = isRecord(bounded.details) ? bounded.details : {};
  const sourceEntries = Array.isArray(details.sourceEntries) ? details.sourceEntries.slice(0, 8).map((source: AnyRecord) => ({
    id: source.id, origin: source.origin, timestamp: source.timestamp, tokens: source.tokens,
    qualifiers: [], ...(typeof source.content === "string" ? { content: utf8Prefix(source.content, 2048) } : {}),
  })) : [];
  return {
    ...Object.fromEntries(Object.entries(bounded).filter(([key]) => ["toolCallId", "tool_call_id", "toolName", "status", "memoryId", "observationId"].includes(key))),
    content: [{ type: "text", text: REDACTED_RECALL }],
    details: { ...Object.fromEntries(Object.entries(details)
        .filter(([key, value]) => ["memoryId", "observationId", "collision"].includes(key)
          && (typeof value !== "string" || value.length <= 128))),
      status: "partial", partial: true, message: REDACTED_RECALL,
      sourceCharacterCount: details.sourceCharacterCount,
      observations: [], reflections: [], matches: [], directObservationMatches: [], sourceEntries,
      unavailableSupportingObservations: [], missingSourceEntryIds: [], nonSourceEntryIds: [] },
  };
}

function redactUiMemoryContent(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return REDACTED_RECALL;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) => redactUiMemoryContent(entry, seen));
    seen.delete(value);
    return output;
  }
  const output: AnyRecord = {};
  for (const [key, entry] of Object.entries(value as AnyRecord)) {
    output[key] = MEMORY_CONTENT_KEYS.has(key)
      ? redactUiMemoryContent(entry, seen)
      : redactUiMemoryTree(entry, seen);
  }
  seen.delete(value);
  return output;
}

function redactUiMemoryTree(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) => redactUiMemoryTree(entry, seen));
    seen.delete(value);
    return output;
  }
  const output: AnyRecord = {};
  for (const [key, entry] of Object.entries(value as AnyRecord)) {
    output[key] = MEMORY_CONTENT_KEYS.has(key)
      ? redactUiMemoryContent(entry, seen)
      : redactUiMemoryTree(entry, seen);
  }
  seen.delete(value);
  return output;
}

function redactRecallUiResult(value: unknown): unknown {
  return redactUiMemoryTree(value, new WeakSet<object>());
}

function settingsFor(config: FrozenConfig): AnyRecord {
  return {
    observeAfterTokens: config.observeAfterTokens,
    reflectAfterTokens: config.reflectAfterTokens,
    ...(config.observerChunkMaxTokens == null ? {} : { observerChunkMaxTokens: config.observerChunkMaxTokens }),
    compactAfterTokens: config.compactAfterTokens,
    compactAfterTokensMode: config.compactAfterTokensMode,
    compactAfterTokensRatio: config.compactAfterTokensRatio,
    observationsPoolMaxTokens: config.observationsPoolMaxTokens,
    observationsPoolTargetTokens: config.observationsPoolTargetTokens,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxTokens: config.agentMaxTokens,
    passive: false,
    showWorkerNotifications: false,
    debugLog: false,
    model: { provider: GATEWAY_PROVIDER, id: config.source_model, thinking: config.model.thinking },
  };
}

function guardedUi(ui: unknown, rpc: boolean): unknown {
  if (!isRecord(ui)) return ui;
  return new Proxy(ui, {
    get(target, property, receiver) {
      if (property === "notify" && typeof target.notify === "function") {
        // Upstream error diagnostics can contain provider bodies or memory.
        // RPC has hasUI=true, but notify creates a separate extension UI
        // subprotocol. The governed host reports status through sendMessage.
        return (_message: unknown, type?: unknown) => rpc ? undefined : target.notify("Observational memory status updated", type);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

type GuardState = { hardFailure?: Error; degraded?: string; workers: Set<Promise<unknown>> };

function workerFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/^PI_OM_[A-Z0-9_]+$/u.test(raw) && !raw.startsWith("PI_OM_WORKER_")) return raw;
  // pi-ai retains HTTP errors as '<status> <JSON>'. Classify only the
  // Gateway's structured code, never provider prose or a bare HTTP 5xx.
  const body = raw.replace(/^\d{3}\s+/u, "");
  if (/^429 (?:request quota exhausted|observational-memory token cap exhausted)$/u.test(raw)) return "PI_OM_WORKER_QUOTA_EXHAUSTED";
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.type ?? parsed?.error?.code ?? parsed?.error_code;
    if (code === "quota_exhausted" || code === "workload_token_cap_exhausted") return "PI_OM_WORKER_QUOTA_EXHAUSTED";
    if (code === "gateway_transient" && parsed.error?.effect_status === "not_started") return "PI_OM_WORKER_TRANSIENT";
    if (code === "workload_usage_unknown" || code === "workload_usage_pending") return "PI_OM_UNKNOWN_EFFECT";
  } catch { /* Unrecognized errors fail closed. */ }
  return "PI_OM_PROTOCOL_WORKER_FAILURE";
}

function guardedRegistry(registry: unknown, config: FrozenConfig, state: GuardState, assertConfig: () => void): AnyRecord {
  if (!isRecord(registry)) fail("PI_OM_MODEL_REGISTRY_MISSING");
  const assertModel: (model: unknown) => asserts model is AnyRecord = (model) => {
    try {
      if (state.hardFailure) throw state.hardFailure;
      assertConfig();
      if (!isRecord(model) || model.provider !== GATEWAY_PROVIDER || model.id !== config.model.id) fail("PI_OM_MODEL_MISMATCH");
    } catch (error) { throw asHardFailure(error, state); }
  };
  const recordFailure = (error: unknown): Error => {
    if (state.degraded && error instanceof Error && error.message === state.degraded) return error;
    const code = workerFailure(error);
    if (/^PI_OM_WORKER_(?:QUOTA|TRANSIENT)(?:_|$)/u.test(code)) state.degraded ??= code;
    else asHardFailure(new Error(code), state);
    return new Error(code);
  };
  const streamWorker = (model: AnyRecord, context: unknown, options: unknown) => {
    const output = createAssistantMessageEventStream();
    const pump = (async () => {
      try {
        assertModel(model);
        if (state.degraded) throw new Error(state.degraded);
        const expected = registry.find(GATEWAY_PROVIDER, config.model.id);
        if (!expected || model.api !== expected.api || model.baseUrl !== expected.baseUrl) fail("PI_OM_MODEL_ROUTE_MISMATCH");
        let stream = registry.streamSimple;
        let owner = registry;
        if (typeof stream !== "function") {
          const provider = registry.getRegisteredProviderConfig?.(GATEWAY_PROVIDER);
          if (provider?.api === model.api && typeof provider.streamSimple === "function") {
            stream = provider.streamSimple;
            owner = provider;
          } else stream = compatStreamSimple;
        }
        const source = stream.call(owner, model, context, options);
        let terminal = false;
        for await (const event of source) {
          if (event.type === "error") {
            const detail = event.error?.errorMessage ?? event.error ?? event.message;
            throw detail instanceof Error ? detail : new Error(typeof detail === "string" ? detail : "PI_OM_PROTOCOL_WORKER_FAILURE");
          }
          if (event.type === "done") {
            if (event.message?.provider !== GATEWAY_PROVIDER || event.message?.model !== config.model.id) fail("PI_OM_MODEL_RESPONSE_MISMATCH");
            terminal = true;
          }
          output.push(event);
        }
        if (!terminal) fail("PI_OM_PROTOCOL_WORKER_INCOMPLETE");
      } catch (error) {
        const failure = recordFailure(error);
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: "error", errorMessage: failure.message, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } } as any);
      } finally { output.end(); }
    })();
    state.workers.add(pump);
    void pump.finally(() => state.workers.delete(pump));
    return output;
  };
  return new Proxy(registry, {
    get(target, property, receiver) {
      if (property === "find") {
        return (provider: unknown, id: unknown) => {
          if (provider !== GATEWAY_PROVIDER || id !== config.model.id) throw asHardFailure(new Error("PI_OM_MODEL_MISMATCH"), state);
          const find = target.find;
          if (typeof find !== "function") fail("PI_OM_MODEL_REGISTRY_INVALID");
          const model = find.call(target, provider, id);
          assertModel(model);
          return deepFreeze({ ...model });
        };
      }
      if (property === "streamSimple") {
        return streamWorker;
      }
      if (property === "getApiKeyAndHeaders" || property === "isUsingOAuth" || property === "hasConfiguredAuth") {
        const method = target[property];
        if (typeof method !== "function") return method;
        return (model: AnyRecord, ...args: unknown[]) => {
          assertModel(model);
          try {
            const result = method.call(target, model, ...args);
            if (property !== "getApiKeyAndHeaders") return result;
            return Promise.resolve(result).then((auth) => {
              const usable = typeof auth?.apiKey === "string" && auth.apiKey.length > 0
                || isRecord(auth?.headers) && Object.values(auth.headers).some((value) => typeof value === "string" && value.length > 0);
              if (!auth?.ok || !usable) throw asHardFailure(new Error("PI_OM_PERMISSION_AUTH_FAILED"), state);
              return auth;
            }, (error) => { throw asHardFailure(error, state); });
          } catch (error) { throw asHardFailure(error, state); }
        };
      }
      if (property === "refresh") {
        const refresh = target.refresh;
        if (typeof refresh !== "function") return refresh;
        return (options?: unknown, ...args: unknown[]) => {
          if (isRecord(options) && Array.isArray(options.providers) && options.providers.some((provider) => provider !== GATEWAY_PROVIDER)) {
            fail("PI_OM_MODEL_SCOPE_INVALID");
          }
          return refresh.call(target, options, ...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function governedContext(context: unknown, config: FrozenConfig, projectRoot: string, state: GuardState, assertConfig: () => void, requireModel = true): AnyRecord {
  if (!isRecord(context)) fail("PI_OM_CONTEXT_INVALID");
  if (!isRecord(context.modelRegistry) && !requireModel) {
    return new Proxy(context, {
      get(target, property, receiver) {
        if (property === "cwd") return projectRoot;
        if (property === "ui") return guardedUi(Reflect.get(target, property, receiver), context.mode === "rpc");
        return Reflect.get(target, property, receiver);
      },
    });
  }
  const registry = guardedRegistry(context.modelRegistry, config, state, assertConfig);
  if (requireModel) registry.find(GATEWAY_PROVIDER, config.model.id);
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "cwd") return projectRoot;
      if (property === "modelRegistry") return registry;
      if (property === "ui") return guardedUi(Reflect.get(target, property, receiver), context.mode === "rpc");
      return Reflect.get(target, property, receiver);
    },
  });
}

function asHardFailure(error: unknown, state: { hardFailure?: Error }): Error {
  if (state.hardFailure) return state.hardFailure;
  const text = error instanceof Error ? error.message.trim() : String(error).trim();
  const stableCode = /^PI_OM_[A-Z0-9_:-]+$/u.test(text) ? text : "PI_OM_HARD_FAILURE";
  const value = new Error(stableCode);
  state.hardFailure = value;
  return value;
}

function isolatedConfig(config: FrozenConfig): { agentDir: string; projectRoot: string; settingsText: string } {
  const root = mkdtempSync(join(tmpdir(), "deepsonar-om-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const settingsText = JSON.stringify({ [SETTINGS_KEY]: settingsFor(config) });
  writeFileSync(join(agentDir, "settings.json"), settingsText, { encoding: "utf8", mode: 0o400 });
  return { agentDir, projectRoot, settingsText };
}

function assertIsolation(config: FrozenConfig, isolated: { agentDir: string; projectRoot: string; settingsText: string }): void {
  const settingsPath = join(isolated.agentDir, "settings.json");
  if (!existsSync(settingsPath)) fail("PI_OM_CONFIG_DRIFT");
  let actual: string;
  try {
    actual = readFileSync(settingsPath, "utf8");
  } catch {
    fail("PI_OM_CONFIG_DRIFT");
  }
  if (actual !== isolated.settingsText || config.model.provider !== GATEWAY_PROVIDER) fail("PI_OM_CONFIG_DRIFT");
  if (existsSync(join(isolated.projectRoot, ".pi", "settings.json"))) fail("PI_OM_PROJECT_OVERRIDE");
}

/** Return a Pi extension function bound to the immutable Job snapshot. */
export function createGovernedObservationalMemoryExtension(input: unknown): (pi: unknown) => void {
  const config = validateFrozenConfig(input);
  const isolated = isolatedConfig(config);
  const state: GuardState = { workers: new Set() };

  return (pi: unknown) => {
    if (!isRecord(pi)) fail("PI_OM_EXTENSION_API_INVALID");
    let sessionId: string | undefined;
    let sessionFile: string | undefined;
    let notified = false;
    const checkConfig = () => assertIsolation(config, isolated);
    const checkSession = (context: AnyRecord) => {
      const manager = context.sessionManager;
      const id = manager?.getSessionId?.();
      const file = manager?.getSessionFile?.();
      if (!id || !file) fail("PI_OM_SNAPSHOT_SESSION_MISSING");
      sessionId ??= id;
      sessionFile ??= file;
      if (id !== sessionId || file !== sessionFile) fail("PI_OM_SNAPSHOT_SESSION_MISMATCH");
    };
    const notifyDegraded = () => {
      if (!state.degraded || notified || state.hardFailure) return;
      notified = true;
      pi.sendMessage({ customType: "deepsonar.om.status", display: true,
        content: "Observational memory worker unavailable; native Pi compaction remains active.",
        details: { code: state.degraded, fallback: "native_compaction" } }, { triggerTurn: false });
    };
    // OM 3.1.4 launches and catches its own background promise. Track that
    // *actual* task through the pinned Runtime method while invoking its hook.
    // The prototype and process environment are restored synchronously, before
    // any await, so other extensions and Pi session paths keep their settings.
    const invoke = (callback: () => unknown) => {
      checkConfig();
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      const passive = process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
      const launch = Runtime.prototype.launchConsolidationTask;
      Runtime.prototype.launchConsolidationTask = function (...args: Parameters<typeof launch>) {
        const task = launch.apply(this, args);
        state.workers.add(task);
        void task.finally(() => state.workers.delete(task));
        return task;
      };
      process.env.PI_CODING_AGENT_DIR = isolated.agentDir;
      delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
      try { return callback(); }
      finally {
        Runtime.prototype.launchConsolidationTask = launch;
        if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = agentDir;
        if (passive === undefined) delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
        else process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = passive;
      }
    };
    const wrapContext = (context: unknown, requireModel = true) => {
      if (state.hardFailure) throw state.hardFailure;
      checkConfig();
      if (!isRecord(context)) fail("PI_OM_CONTEXT_INVALID");
      checkSession(context);
      return governedContext(context, config, isolated.projectRoot, state, checkConfig, requireModel);
    };
    pi.on("agent_before_settle", async (_event: unknown, context: unknown) => {
      try {
        wrapContext(context, false);
        while (state.workers.size) await Promise.all([...state.workers]);
        if (state.hardFailure) throw state.hardFailure;
        notifyDegraded();
      } catch (error) { throw asHardFailure(error, state); }
    });
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
    const guardedPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "appendEntry" && typeof target.appendEntry === "function") {
          return (...args: unknown[]) => {
            if (state.hardFailure) throw state.hardFailure;
            checkConfig();
            return target.appendEntry(...args);
          };
        }
        if (property === "on" && typeof target.on === "function") {
          return (event: string, handler: (...args: unknown[]) => unknown) => target.on.call(target, event, async (...args: unknown[]) => {
            const contextIndex = args.length > 1 ? args.length - 1 : -1;
            const guardedArgs = [...args];
            try {
              if (contextIndex >= 0) guardedArgs[contextIndex] = wrapContext(args[contextIndex], event === "agent_start" || event === "turn_end");
              if (state.degraded) { notifyDegraded(); return undefined; }
              const result = await invoke(() => handler(...guardedArgs));
              if (state.hardFailure) throw state.hardFailure;
              notifyDegraded();
              return result;
            } catch (error) {
              throw asHardFailure(error, state);
            }
          });
        }
        if (property === "registerTool" && typeof target.registerTool === "function") {
          return (tool: AnyRecord) => {
            if (!isRecord(tool) || tool.name !== "recall" || typeof tool.execute !== "function") return target.registerTool.call(target, tool);
            const execute = tool.execute;
            const renderResult = tool.renderResult;
            return target.registerTool.call(target, {
              ...tool,
              execute: async (...args: unknown[]) => {
                try {
                  const contextIndex = args.length - 1;
                  args[contextIndex] = wrapContext(args[contextIndex], false);
                  return boundRecallResult(await invoke(() => execute(...args)));
                } catch (error) {
                  throw asHardFailure(error, state);
                }
              },
              ...(typeof renderResult === "function"
                ? {
                    renderResult: (...args: unknown[]) => renderResult.call(tool, redactRecallUiResult(args[0]), args[1]),
                  }
                : {}),
            });
          };
        }
        if (property === "registerCommand" && typeof target.registerCommand === "function") {
          return (name: string, command: AnyRecord) => {
            if (name === "om:view") {
              return target.registerCommand.call(target, name, {
                ...command,
                handler: async (...args: unknown[]) => {
                  try {
                    const context = wrapContext(args.at(-1), false);
                    if (context.mode === "rpc") {
                      pi.sendMessage({ customType: "deepsonar.om.notice", display: true,
                        content: "Observational memory view is disabled in the governed runtime." }, { triggerTurn: false });
                      return;
                    }
                    if (isRecord(context) && context.hasUI && isRecord(context.ui) && typeof context.ui.notify === "function") {
                      context.ui.notify("Observational memory view is disabled in the governed runtime; recall output is bounded and redacted", "warning");
                    }
                  } catch (error) {
                    throw asHardFailure(error, state);
                  }
                },
              });
            }
            return target.registerCommand.call(target, name, {
              ...command,
              handler: typeof command?.handler === "function"
                ? async (...args: unknown[]) => {
                  try {
                    return await invoke(() => command.handler(...args.slice(0, -1), wrapContext(args.at(-1), false)));
                  } catch (error) {
                    throw asHardFailure(error, state);
                  }
                }
                : command?.handler,
            });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      observationalMemory(guardedPi as any);
    } catch (error) {
      throw asHardFailure(error, state);
    }
  };
}
