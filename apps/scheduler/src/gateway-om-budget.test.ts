import assert from "node:assert/strict";
import test from "node:test";
import {
  assertObservationalMemoryFrozenJobModel,
  assertObservationalMemoryProvider,
  assertObservationalMemoryRequestScope,
  gatewayRouteForProtocol,
  GatewayWorkloadPolicyError,
  resolveObservationalMemoryBudget,
  resolveObservationalMemoryGatewayScope,
} from "./gateway-om-budget.js";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_provider: "anthropic-route",
    source_model: "claude-memory",
    model: { provider: "__deepsonar_observational_memory", id: "claude-memory", thinking: "low" },
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof GatewayWorkloadPolicyError && error.code === code);
}

test("absent budget is unlimited only for an unlimited frozen Job and never invents shares", () => {
  assert.deepEqual(resolveObservationalMemoryBudget({ config: config(), jobTokenMaxRequests: 0 }), {
    total_requests: 0,
    main_requests: 0,
    background_requests: 0,
    background_max_tokens: null,
    request_budget_present: false,
  });
  expectCode(() => resolveObservationalMemoryBudget({ config: config(), jobTokenMaxRequests: 10 }), "PI_OM_REQUEST_ALLOCATION_REQUIRED");
});

test("finite allocation is frozen to the Job total and uses the explicit min background cap", () => {
  const plan = resolveObservationalMemoryBudget({
    config: config({
      request_budget: { total_requests: 10, main_requests: 7, background_requests: 3 },
      background_limits: { max_requests: 2, max_tokens: 900 },
    }),
    jobTokenMaxRequests: 10,
  });
  assert.deepEqual(plan, {
    total_requests: 10,
    main_requests: 7,
    background_requests: 2,
    background_max_tokens: 900,
    request_budget_present: true,
  });
  expectCode(() => resolveObservationalMemoryBudget({
    config: config({ request_budget: { total_requests: 9, main_requests: 7, background_requests: 2 } }),
    jobTokenMaxRequests: 10,
  }), "PI_OM_BUDGET_TOTAL_MISMATCH");
  expectCode(() => resolveObservationalMemoryBudget({
    config: config({ request_budget: { total_requests: 10, main_requests: 8, background_requests: 3 } }),
    jobTokenMaxRequests: 10,
  }), "PI_OM_BUDGET_SUM_EXCEEDS_TOTAL");
  assert.equal(resolveObservationalMemoryBudget({
    config: config({
      request_budget: { total_requests: 10, main_requests: 7, background_requests: 3 },
      background_limits: { max_requests: 99, max_tokens: 0 },
    }),
    jobTokenMaxRequests: 10,
  }).background_requests, 3);
});

test("budget objects are strict and zero is only the background unlimited sentinel", () => {
  expectCode(() => resolveObservationalMemoryBudget({
    config: config({ request_budget: { total_requests: 10, main_requests: 0, background_requests: 10 } }),
    jobTokenMaxRequests: 10,
  }), "PI_OM_BUDGET_INVALID");
  expectCode(() => resolveObservationalMemoryBudget({
    config: config({ background_limits: { max_requests: 1, max_tokens: 0, extra: true } }),
    jobTokenMaxRequests: 0,
  }), "PI_OM_BUDGET_FIELD_UNKNOWN");
});

test("unlimited Jobs honor explicit background-only limits without allocating main shares", () => {
  for (const jobTokenMaxRequests of [undefined, null, 0]) {
    assert.deepEqual(resolveObservationalMemoryBudget({
      config: config({ background_limits: { max_requests: 2, max_tokens: 0 } }), jobTokenMaxRequests,
    }), { total_requests: 0, main_requests: 0, background_requests: 2, background_max_tokens: null, request_budget_present: false });
  }
  for (const jobTokenMaxRequests of [-1, 1.5, Infinity, "2"]) {
    expectCode(() => resolveObservationalMemoryBudget({ config: config(), jobTokenMaxRequests }), "PI_OM_BUDGET_INVALID");
  }
});

test("frozen model protocol overrides are honored and malformed frozen routes never use settings fallback", () => {
  const file = (providers: unknown) => [{ path: ".pi/agent/models.json", content: JSON.stringify({ providers }) }];
  const input = {
    config: config(),
    settingsConfig: { providers: { "anthropic-route": { api: "anthropic-messages" } } },
  };
  assert.equal(resolveObservationalMemoryGatewayScope({ ...input, configFiles: file({
    "anthropic-route": { api: "openai-completions", models: [{ id: "claude-memory", api: "openai-responses" }] },
  }) }).route, "v1/responses");
  expectCode(() => resolveObservationalMemoryGatewayScope({ ...input, configFiles: file({}) }), "PI_OM_PROVIDER_ROUTE_MISSING");
  expectCode(() => resolveObservationalMemoryGatewayScope({ ...input, configFiles: file({
    "anthropic-route": { api: "anthropic-messages", models: [{ id: "other-model" }] },
  }) }), "PI_OM_MODEL_SCOPE_INVALID");
  expectCode(() => resolveObservationalMemoryGatewayScope({ ...input, configFiles: file({
    "anthropic-route": { api: "anthropic-messages", models: [{ id: "claude-memory", api: "unsupported" }] },
  }) }), "PI_OM_PROVIDER_ROUTE_UNSUPPORTED");
});

test("the frozen route is a single protocol path and the model/provider checks are fail closed", () => {
  assert.equal(gatewayRouteForProtocol("anthropic-messages"), "v1/messages");
  assert.equal(gatewayRouteForProtocol("openai-completions"), "v1/chat/completions");
  assert.equal(gatewayRouteForProtocol("openai-responses"), "v1/responses");
  expectCode(() => gatewayRouteForProtocol("other"), "PI_OM_PROVIDER_ROUTE_UNSUPPORTED");

  const frozen = {
    ...config(),
    request_budget: { total_requests: 10, main_requests: 7, background_requests: 3 },
  };
  const before = JSON.parse(JSON.stringify(frozen)) as Record<string, unknown>;
  const scope = resolveObservationalMemoryGatewayScope({
    config: frozen,
    settingsConfig: { providers: { "anthropic-route": { api: "anthropic-messages" } } },
  });
  assert.deepEqual(scope, { provider: "anthropic-route", model: "claude-memory", route: "v1/messages" });
  assert.deepEqual(frozen, before, "scope resolution must not rewrite the frozen snapshot object");
  assert.doesNotThrow(() => assertObservationalMemoryRequestScope({
    workload: "observational_memory",
    requestModel: "claude-memory",
    upstreamPath: "/v1/messages",
    expectedModel: scope.model,
    expectedRoute: scope.route,
  }));
  expectCode(() => assertObservationalMemoryRequestScope({
    workload: "observational_memory",
    requestModel: "other-model",
    upstreamPath: "v1/messages",
    expectedModel: scope.model,
    expectedRoute: scope.route,
  }), "FROZEN_WORKLOAD_MODEL_MISMATCH");
  expectCode(() => assertObservationalMemoryRequestScope({
    workload: "observational_memory",
    requestModel: scope.model,
    upstreamPath: "v1/responses",
    expectedModel: scope.model,
    expectedRoute: scope.route,
  }), "FROZEN_WORKLOAD_ROUTE_MISMATCH");
  expectCode(() => assertObservationalMemoryProvider({
    workload: "observational_memory",
    actualProvider: "openai",
    expectedProvider: "anthropic",
  }), "FROZEN_WORKLOAD_PROVIDER_MISMATCH");

  assert.doesNotThrow(() => assertObservationalMemoryFrozenJobModel({
    workload: "observational_memory",
    frozenJobModel: "claude-memory",
    sourceModel: "claude-memory",
  }));
  expectCode(() => assertObservationalMemoryFrozenJobModel({
    workload: "observational_memory",
    frozenJobModel: "main-model",
    sourceModel: "claude-memory",
  }), "PI_OM_FROZEN_JOB_MODEL_MISMATCH");
  expectCode(() => assertObservationalMemoryFrozenJobModel({
    workload: "observational_memory",
    frozenJobModel: null,
    sourceModel: "claude-memory",
  }), "PI_OM_FROZEN_JOB_MODEL_MISMATCH");

  assert.deepEqual(resolveObservationalMemoryGatewayScope({
    config: config({ source_provider: "openai" }),
    settingsConfig: { provider: "openai", api: "openai-responses" },
  }), { provider: "openai", model: "claude-memory", route: "v1/responses" });
});
