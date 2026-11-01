/**
 * Pure policy for the Scheduler-issued observational-memory Gateway token.
 *
 * The extension configuration is deliberately accepted as unknown here.  The
 * shared-types package owns the public Zod shape; this module owns the
 * kernel-side invariants that relate that shape to a frozen Job.
 */

export const GATEWAY_WORKLOADS = ["main", "observational_memory"] as const;
export type GatewayWorkload = (typeof GATEWAY_WORKLOADS)[number];

const MAX_REQUESTS = 1_000_000;
const MAX_PRE_REQUEST_CAUSE_DEPTH = 8;
const MAX_PRE_REQUEST_CAUSE_NODES = 32;
const MAX_PRE_REQUEST_AGGREGATE_WIDTH = 8;

export type ObservationalMemoryBudgetPlan = {
  total_requests: number;
  main_requests: number;
  background_requests: number;
  background_max_tokens: number | null;
  request_budget_present: boolean;
};

export type ObservationalMemoryGatewayScope = {
  provider: string;
  model: string;
  route: "v1/messages" | "v1/chat/completions" | "v1/responses";
};

export class GatewayWorkloadPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GatewayWorkloadPolicyError";
  }
}

type ReadErrorProperty = { ok: true; present: boolean; value?: unknown } | { ok: false };

function readErrorProperty(value: object, key: string): ReadErrorProperty {
  try {
    if (!(key in value)) return { ok: true, present: false };
    return { ok: true, present: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function exactErrorString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function provesPreRequestTransportFailure(value: object, nameValue: string | null): boolean {
  if (!(value instanceof Error) || nameValue !== "Error") return false;
  const code = readErrorProperty(value, "code");
  const syscall = readErrorProperty(value, "syscall");
  if (!code.ok || !syscall.ok) return false;
  const codeValue = exactErrorString(code.value);
  const syscallValue = exactErrorString(syscall.value);
  return (codeValue === "ECONNREFUSED" && syscallValue === "connect")
    || ((codeValue === "ENOTFOUND" || codeValue === "EAI_AGAIN") && syscallValue === "getaddrinfo");
}

/**
 * Classify only a Node transport error proven to have failed before connect.
 *
 * Fetch wraps these errors in a TypeError whose `cause` is the Node error.  A
 * bounded cause walk is deliberate: provider prose, timeout wrappers, mixed
 * AggregateErrors, cycles and attacker-sized error graphs must all fail closed.
 */
export function isKnownObservationalMemoryPreRequestFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > MAX_PRE_REQUEST_CAUSE_DEPTH) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    nodes += 1;
    if (nodes > MAX_PRE_REQUEST_CAUSE_NODES) return false;

    const name = readErrorProperty(value, "name");
    const code = readErrorProperty(value, "code");
    if (!name.ok || !code.ok) return false;
    const nameValue = exactErrorString(name.value);
    const codeValue = exactErrorString(code.value);
    if (nameValue === "AbortError" || nameValue === "TimeoutError" || codeValue === "ABORT_ERR") return false;
    if (code.present && code.value !== undefined
      && !["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(codeValue ?? "")) return false;

    const aggregate = value instanceof AggregateError;
    const errors = readErrorProperty(value, "errors");
    if (!errors.ok || (!aggregate && errors.present)) return false;
    let hasBranch = false;
    if (aggregate) {
      if (!errors.ok || !errors.present || !Array.isArray(errors.value)
        || errors.value.length === 0 || errors.value.length > MAX_PRE_REQUEST_AGGREGATE_WIDTH) return false;
      hasBranch = true;
      for (const leaf of errors.value) {
        if (!visit(leaf, depth + 1)) return false;
      }
    }

    const cause = readErrorProperty(value, "cause");
    if (!cause.ok) return false;
    if (cause.present) {
      hasBranch = true;
      // Native undici fetch exposes a TypeError -> cause chain. Do not let an
      // arbitrary permission/protocol/config wrapper inherit a transport
      // leaf merely because it happens to carry `cause`.
      if (!(value instanceof AggregateError) && nameValue !== "TypeError") return false;
      if (!visit(cause.value, depth + 1)) return false;
    }

    return hasBranch ? true : provesPreRequestTransportFailure(value, nameValue);
  };

  return visit(error, 0);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_FIELD_UNKNOWN", `${label} contains unsupported field ${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_FIELD_REQUIRED", `${label}.${key} is required`);
    }
  }
}

function positiveInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > MAX_REQUESTS) {
    throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_INVALID", `${field} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_INVALID", `${field} must be a nonnegative integer`);
  }
  return Number(value);
}

function optionalNonNegativeInt(value: unknown, field: string, max?: number): number {
  if (value === undefined) return 0;
  return nonNegativeInt(value, field, max);
}

/**
 * Resolve one immutable budget for both service-issued workload tokens.
 * A missing request_budget is unlimited only when the frozen Job is also
 * unlimited.  It never invents a main/background percentage split.
 */
export function resolveObservationalMemoryBudget(input: {
  config: unknown;
  jobTokenMaxRequests: unknown;
}): ObservationalMemoryBudgetPlan {
  const config = objectRecord(input.config);
  if (!config) throw new GatewayWorkloadPolicyError("PI_OM_CONFIG_INVALID", "observational-memory config is not an object");

  const frozenTotal = input.jobTokenMaxRequests === undefined || input.jobTokenMaxRequests === null
    ? 0
    : nonNegativeInt(input.jobTokenMaxRequests, "runtime_knobs.job_token_max_requests", MAX_REQUESTS);

  const rawBackground = config.background_limits;
  let explicitBackgroundRequests = 0;
  let backgroundMaxTokens: number | null = null;
  if (rawBackground !== undefined) {
    const background = objectRecord(rawBackground);
    if (!background) throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_INVALID", "background_limits must be an object");
    requireExactKeys(background, ["max_requests", "max_tokens"], "background_limits");
    explicitBackgroundRequests = optionalNonNegativeInt(background.max_requests, "background_limits.max_requests", MAX_REQUESTS);
    const tokenLimit = optionalNonNegativeInt(background.max_tokens, "background_limits.max_tokens");
    backgroundMaxTokens = tokenLimit === 0 ? null : tokenLimit;
  }

  const rawRequestBudget = config.request_budget;
  if (rawRequestBudget === undefined) {
    if (frozenTotal > 0) {
      throw new GatewayWorkloadPolicyError(
        "PI_OM_REQUEST_ALLOCATION_REQUIRED",
        "finite Job request budget requires explicit observational-memory request_budget allocation",
      );
    }
    return {
      total_requests: 0,
      main_requests: 0,
      background_requests: explicitBackgroundRequests,
      background_max_tokens: backgroundMaxTokens,
      request_budget_present: false,
    };
  }

  const requestBudget = objectRecord(rawRequestBudget);
  if (!requestBudget) throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_INVALID", "request_budget must be an object");
  requireExactKeys(requestBudget, ["total_requests", "main_requests", "background_requests"], "request_budget");
  const total = positiveInt(requestBudget.total_requests, "request_budget.total_requests");
  const main = positiveInt(requestBudget.main_requests, "request_budget.main_requests");
  const background = positiveInt(requestBudget.background_requests, "request_budget.background_requests");
  if (main + background > total) {
    throw new GatewayWorkloadPolicyError("PI_OM_BUDGET_SUM_EXCEEDS_TOTAL", "request_budget allocations exceed total_requests");
  }
  if (frozenTotal !== total) {
    throw new GatewayWorkloadPolicyError(
      "PI_OM_BUDGET_TOTAL_MISMATCH",
      `request_budget.total_requests must equal frozen job_token_max_requests (${frozenTotal})`,
    );
  }
  return {
    total_requests: total,
    main_requests: main,
    background_requests: explicitBackgroundRequests > 0 ? Math.min(background, explicitBackgroundRequests) : background,
    background_max_tokens: backgroundMaxTokens,
    request_budget_present: true,
  };
}

export function gatewayRouteForProtocol(value: unknown): ObservationalMemoryGatewayScope["route"] {
  switch (value) {
    case "anthropic-messages": return "v1/messages";
    case "openai-completions": return "v1/chat/completions";
    case "openai-responses": return "v1/responses";
    default:
      throw new GatewayWorkloadPolicyError("PI_OM_PROVIDER_ROUTE_UNSUPPORTED", `unsupported frozen provider protocol ${String(value)}`);
  }
}

function providerProfileFromSnapshot(input: {
  sourceProvider: string;
  settingsConfig?: unknown;
  configFiles?: unknown;
}): Record<string, unknown> | null {
  const files = Array.isArray(input.configFiles) ? input.configFiles : [];
  const modelFile = files.find((item) => {
    const row = objectRecord(item);
    return row?.path === ".pi/agent/models.json";
  });
  if (modelFile) {
    const content = objectRecord(modelFile)?.content;
    if (typeof content === "string") {
      try {
        const parsed = objectRecord(JSON.parse(content));
        const providers = objectRecord(parsed?.providers);
        const profile = objectRecord(providers?.[input.sourceProvider]);
        if (profile) return profile;
      } catch {
        throw new GatewayWorkloadPolicyError("PI_OM_PROVIDER_ROUTE_INVALID", "frozen Pi models.json is not valid JSON");
      }
    }
    throw new GatewayWorkloadPolicyError("PI_OM_PROVIDER_ROUTE_MISSING", "frozen Pi models.json has no matching provider route");
  }
  const settings = objectRecord(input.settingsConfig);
  const providers = objectRecord(settings?.providers);
  const namedProfile = objectRecord(providers?.[input.sourceProvider]);
  if (namedProfile) return namedProfile;
  if (settings?.provider === input.sourceProvider && (settings.api !== undefined || settings.protocol !== undefined)) {
    return settings;
  }
  return null;
}

/** Resolve the single route/model that an OM token is allowed to use. */
export function resolveObservationalMemoryGatewayScope(input: {
  config: unknown;
  settingsConfig?: unknown;
  configFiles?: unknown;
}): ObservationalMemoryGatewayScope {
  const config = objectRecord(input.config);
  const sourceProvider = typeof config?.source_provider === "string" ? config.source_provider.trim() : "";
  const sourceModel = typeof config?.source_model === "string" ? config.source_model.trim() : "";
  const model = objectRecord(config?.model);
  if (!sourceProvider || !sourceModel || model?.id !== sourceModel) {
    throw new GatewayWorkloadPolicyError("PI_OM_MODEL_SCOPE_INVALID", "frozen observational-memory model scope is invalid");
  }
  const profile = providerProfileFromSnapshot({
    sourceProvider,
    settingsConfig: input.settingsConfig,
    configFiles: input.configFiles,
  });
  if (!profile) {
    throw new GatewayWorkloadPolicyError("PI_OM_PROVIDER_ROUTE_MISSING", "frozen observational-memory provider route is missing");
  }
  const modelProfile = Array.isArray(profile.models)
    ? profile.models.map(objectRecord).find((item) => item?.id === sourceModel)
    : null;
  if (Array.isArray(profile.models) && !modelProfile) {
    throw new GatewayWorkloadPolicyError("PI_OM_MODEL_SCOPE_INVALID", "frozen observational-memory model is absent from its provider route");
  }
  const protocol = modelProfile?.api ?? profile.api ?? profile.protocol;
  return { provider: sourceProvider, model: sourceModel, route: gatewayRouteForProtocol(protocol) };
}

export function assertObservationalMemoryRequestScope(input: {
  workload: GatewayWorkload;
  requestModel: string | null;
  upstreamPath: string;
  expectedModel?: unknown;
  expectedRoute?: unknown;
}): void {
  if (input.workload !== "observational_memory") return;
  const expectedModel = typeof input.expectedModel === "string" ? input.expectedModel.trim() : "";
  const expectedRoute = typeof input.expectedRoute === "string" ? input.expectedRoute.replace(/^\/+|\/+$/gu, "") : "";
  if (!expectedModel || !expectedRoute) {
    throw new GatewayWorkloadPolicyError("FROZEN_WORKLOAD_SCOPE_MISSING", "observational-memory token has no frozen model/route scope");
  }
  const requestRoute = input.upstreamPath.replace(/^\/+|\/+$/gu, "");
  if (requestRoute !== expectedRoute) {
    throw new GatewayWorkloadPolicyError("FROZEN_WORKLOAD_ROUTE_MISMATCH", "observational-memory token cannot use this provider route");
  }
  if (input.requestModel !== expectedModel) {
    throw new GatewayWorkloadPolicyError("FROZEN_WORKLOAD_MODEL_MISMATCH", "observational-memory token cannot use this model");
  }
}

export function assertObservationalMemoryProvider(input: {
  workload: GatewayWorkload;
  actualProvider: string;
  expectedProvider?: unknown;
}): void {
  if (input.workload !== "observational_memory") return;
  const expected = typeof input.expectedProvider === "string" ? input.expectedProvider.trim() : "";
  if (!expected || input.actualProvider !== expected) {
    throw new GatewayWorkloadPolicyError("FROZEN_WORKLOAD_PROVIDER_MISMATCH", "observational-memory token cannot use this provider");
  }
}

/**
 * The OM worker is a workload of the frozen Job.  Its model may not be a
 * second model selected by mutable settings or by token minting arguments.
 */
export function assertObservationalMemoryFrozenJobModel(input: {
  workload: GatewayWorkload;
  frozenJobModel?: unknown;
  sourceModel?: unknown;
}): void {
  if (input.workload !== "observational_memory") return;
  const frozenJobModel = typeof input.frozenJobModel === "string" ? input.frozenJobModel.trim() : "";
  const sourceModel = typeof input.sourceModel === "string" ? input.sourceModel.trim() : "";
  if (!frozenJobModel || !sourceModel || frozenJobModel !== sourceModel) {
    throw new GatewayWorkloadPolicyError(
      "PI_OM_FROZEN_JOB_MODEL_MISMATCH",
      "observational-memory model must equal the frozen Job model",
    );
  }
}
