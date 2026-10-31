import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { normalizeTaskContract } from "@deepsonar/shared-types";
import {
  REFERENCE_TARGET_ACTIONS,
  referenceTargetConfig,
  targetBinding,
  targetAuthorizationWriteRequested,
  type TargetAuthorizationResponse,
} from "./index.js";
import { executeReferenceTargetFixture, TARGET_FIXTURE_CREDENTIAL } from "./target-client.fixture.js";
import { taskContractPreflight } from "../../task-contract-preflight.js";

const now = new Date("2026-10-31T03:00:00.000Z");
const secret = "target-auth-fixture-value";
const env = { FIXTURE_AUTHORITY_SECRET: secret } as NodeJS.ProcessEnv;
const config = referenceTargetConfig({
  authorityUrl: "http://127.0.0.1:38167/authorize",
  authorityId: "fixture-authority",
  secretRef: "FIXTURE_AUTHORITY_SECRET",
  requestedActions: REFERENCE_TARGET_ACTIONS,
  maxAgeSeconds: 60,
  timeoutMs: 100,
  maxBodyBytes: 4096,
});

const contract = (extra: Record<string, unknown> = {}) => normalizeTaskContract({
  schema_version: 1,
  template_id: "blackbox",
  template_version: 1,
  objective: "Exercise the approved fixture lifecycle",
  targets: ["reference-http/v1:test-tenant/save-publish-trigger"],
  scope: ["save then publish then trigger"],
  acceptance: ["The fixture records the exact authorized action chain"],
  evidence: ["Authority response and target fixture state"],
  stop_conditions: ["Stop outside the test tenant"],
  allowed_actions: ["read", "write"],
  required_actions: ["read", "write"],
  identity: { tenant: "test-tenant", role: "editor", resource: "save-publish-trigger" },
  prerequisites: [{ id: "fixture-ready", required: true, state: "declared", description: "The isolated fixture is ready" }],
  ...extra,
});

function db() {
  return async (parts: TemplateStringsArray) => {
    assert.match(parts.join("?"), /FROM projects/);
    return [{ id: "project-1", status: "active", config_json: {} }];
  };
}

function allowedResponse(request: Record<string, any>, authorityRevision = "policy-1"): TargetAuthorizationResponse {
  return {
    protocol: "deepsonar.target-authorization/v1",
    authority_id: request.authority_id,
    config_identity: request.config_identity,
    decision: "allow",
    authority_revision: authorityRevision,
    expires_at: new Date(now.getTime() + 30_000).toISOString(),
    scope: {
      project_id: request.project_id,
      target: request.target,
      principal_id: request.principal.id,
      tenant: request.identity.tenant,
      role: request.identity.role,
      resource: request.identity.resource,
    },
    actions: request.requested_actions.map((action: string) => ({ action, effect: "allow" as const })),
    prerequisites: request.prerequisites.map((item: { id: string }) => ({ id: item.id, status: "satisfied" as const })),
    binding: request.binding,
  };
}

function fetchFixture(responseFactory: (request: Record<string, any>) => unknown, capture?: { request?: Record<string, any>; headers?: Record<string, string> }) {
  return async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const request = JSON.parse(init.body) as Record<string, any>;
    if (capture) {
      capture.request = request;
      capture.headers = init.headers;
    }
    return new Response(JSON.stringify(responseFactory(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("reference adapter accepts only the exact save-publish-trigger action chain", () => {
  for (const requestedActions of [
    REFERENCE_TARGET_ACTIONS.slice(0, 2),
    [...REFERENCE_TARGET_ACTIONS].reverse(),
    [...REFERENCE_TARGET_ACTIONS, "reference-http.save"],
  ]) {
    assert.throws(() => referenceTargetConfig({ ...config, requestedActions }), /authority configuration is invalid/);
  }
  assert.deepEqual(config.requestedActions, REFERENCE_TARGET_ACTIONS);
});

test("positive trusted target chain binds project, exact actions, principal, scope, prerequisites and content revision", async () => {
  const capture: { request?: Record<string, any>; headers?: Record<string, string> } = {};
  const result = await taskContractPreflight(db(), "project-1", contract(), false, {
    detailed: true,
    principalId: "principal-1",
    content: "save -> publish -> trigger fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request), capture),
    now: () => now,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.targetAuthorization);
  assert.ok(result.authorizedActions?.includes("write"));
  assert.equal(result.targetAuthorization.project_id, "project-1");
  assert.deepEqual(result.targetAuthorization.requested_actions, [...REFERENCE_TARGET_ACTIONS]);
  assert.equal(result.targetAuthorization.principal_id, "principal-1");
  assert.equal(result.targetAuthorization.tenant, "test-tenant");
  assert.equal(result.targetAuthorization.role, "editor");
  assert.equal(result.targetAuthorization.resource, "save-publish-trigger");
  assert.equal(result.targetAuthorization.authority_revision, "policy-1");
  assert.ok(capture.request);
  assert.deepEqual(capture.request?.requested_actions, [...REFERENCE_TARGET_ACTIONS]);
  assert.equal(capture.request?.binding.content_sha256, targetBinding("save -> publish -> trigger fixture", contract()).content_sha256);
  assert.equal(capture.headers?.authorization, `Bearer ${secret}`);
  assert.doesNotMatch(JSON.stringify(capture.request), /target-auth-fixture-value/);
  assert.doesNotMatch(JSON.stringify(result.targetAuthorization), /38167|FIXTURE_AUTHORITY_SECRET/);
});

test("authority deny blocks wrong principal, tenant, resource and unavailable prerequisite without converting read into write", async () => {
  const denied = (reason_code: "scope_mismatch" | "prerequisite_unavailable"): TargetAuthorizationResponse => ({
    ...allowedResponse({
      authority_id: "fixture-authority",
      config_identity: config.configIdentity,
      project_id: "project-1",
      target: { adapter: "reference-http/v1", target_id: "test-tenant/save-publish-trigger" },
      principal: { id: "wrong-principal" },
      identity: { tenant: "wrong-tenant", role: "viewer", resource: "wrong-resource" },
      requested_actions: [...REFERENCE_TARGET_ACTIONS],
      prerequisites: [{ id: "fixture-ready" }],
      binding: targetBinding("wrong", contract()),
    }),
    decision: "deny",
    reason_code,
    actions: [],
    prerequisites: [],
  });
  for (const [name, wrong] of [
    ["principal", { principalId: "wrong-principal" }],
    ["tenant", { contract: contract({ identity: { tenant: "wrong-tenant", role: "editor", resource: "save-publish-trigger" } }) }],
    ["resource", { contract: contract({ identity: { tenant: "test-tenant", role: "editor", resource: "wrong-resource" } }) }],
  ] as const) {
    const candidate = wrong.contract ?? contract();
    const blockers = await taskContractPreflight(db(), "project-1", candidate, false, {
      principalId: wrong.principalId ?? "principal-1",
      content: "save -> publish -> trigger fixture",
      targetAuthorizationConfig: config,
      targetAuthorizationEnv: env,
      targetAuthorizationFetch: fetchFixture(() => denied("scope_mismatch")),
      now: () => now,
    });
    assert.ok(blockers.some((item) => item.code === "target_authorization_scope_mismatch" || item.code === "target_authorization_denied"), name);
  }
  const prerequisiteBlockers = await taskContractPreflight(db(), "project-1", contract(), false, {
    principalId: "principal-1",
    content: "save -> publish -> trigger fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture(() => denied("prerequisite_unavailable")),
    now: () => now,
  });
  assert.ok(prerequisiteBlockers.some((item) => item.code === "target_authorization_prerequisite_blocked"));

  const readOnly = normalizeTaskContract({
    schema_version: 1, template_id: "engineering", template_version: 1,
    objective: "Read fixture", targets: ["repository:fixture"], scope: ["metadata"],
    acceptance: ["Report metadata"], evidence: ["Response"],
    required_actions: ["read"], allowed_actions: ["read"],
  });
  let calls = 0;
  assert.deepEqual(await taskContractPreflight(db(), "project-1", readOnly, false, {
    targetAuthorizationConfig: config,
    targetAuthorizationFetch: async () => { calls += 1; throw new Error("must not call authority"); },
  }), []);
  assert.equal(calls, 0);
});

test("policy revision, action expansion and content binding changes fail closed", async () => {
  const baseOptions = {
    detailed: true as const,
    principalId: "principal-1",
    content: "save -> publish -> trigger fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    now: () => now,
  };
  const first = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request, "policy-1")),
  });
  assert.equal(first.blockers.length, 0);
  const frozen = first.targetAuthorization;
  assert.ok(frozen);
  const revisionChanged = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    frozenTargetAuthorization: frozen,
    requireFrozenTargetAuthorization: true,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request, "policy-2")),
  });
  assert.ok(revisionChanged.blockers.some((item) => item.code === "target_authorization_policy_changed"));
  const bindingChanged = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    content: "changed after create",
    frozenTargetAuthorization: frozen,
    requireFrozenTargetAuthorization: true,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request, "policy-1")),
  });
  assert.ok(bindingChanged.blockers.some((item) => item.code === "target_authorization_snapshot_binding_changed"));
  const actionsExpanded = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    targetAuthorizationFetch: fetchFixture((request) => ({
      ...allowedResponse(request),
      actions: [...allowedResponse(request).actions, { action: "reference-http.extra", effect: "allow" }],
    })),
  });
  assert.ok(actionsExpanded.blockers.some((item) => item.code === "target_authorization_action_denied"));
  const actionMissing = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    targetAuthorizationFetch: fetchFixture((request) => ({
      ...allowedResponse(request),
      actions: allowedResponse(request).actions.slice(1),
    })),
  });
  assert.ok(actionMissing.blockers.some((item) => item.code === "target_authorization_action_denied"));

  const actionReordered = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...baseOptions,
    targetAuthorizationFetch: fetchFixture((request) => ({
      ...allowedResponse(request),
      actions: [...allowedResponse(request).actions].reverse(),
    })),
  });
  assert.ok(actionReordered.blockers.some((item) => item.code === "target_authorization_action_denied"));
});

test("authority scope and binding field order is not part of the authorization identity", async () => {
  const result = await taskContractPreflight(db(), "project-1", contract(), false, {
    detailed: true,
    principalId: "principal-1",
    content: "save -> publish -> trigger fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture((request) => {
      const response = allowedResponse(request);
      return {
        ...response,
        scope: {
          resource: response.scope.resource,
          role: response.scope.role,
          tenant: response.scope.tenant,
          principal_id: response.scope.principal_id,
          target: {
            target_id: response.scope.target.target_id,
            adapter: response.scope.target.adapter,
          },
          project_id: response.scope.project_id,
        },
        binding: {
          revision: response.binding.revision,
          task_contract_sha256: response.binding.task_contract_sha256,
          content_sha256: response.binding.content_sha256,
        },
      };
    }),
    now: () => now,
  });
  assert.deepEqual(result.blockers, []);
});

test("identity-only read contracts never receive a write grant from the reference chain", async () => {
  const readIdentity = normalizeTaskContract({
    schema_version: 1, template_id: "blackbox", template_version: 1,
    objective: "Read fixture", targets: ["reference-http/v1:test-tenant/save-publish-trigger"],
    scope: ["metadata"], acceptance: ["Report metadata"], evidence: ["Response"],
    allowed_actions: ["read"], required_actions: ["read"],
    identity: { tenant: "test-tenant", role: "editor", resource: "save-publish-trigger" },
  });
  const result = await taskContractPreflight(db(), "project-1", readIdentity, false, {
    detailed: true,
    principalId: "principal-1",
    content: "read fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request)),
    now: () => now,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.targetAuthorization);
  assert.equal(targetAuthorizationWriteRequested(readIdentity), false);
  assert.ok(!result.authorizedActions?.includes("write"));
  // The shared dispatch facts are not exposed in the result. Requiring a
  // write action with the same authority response must still perform a new
  // exact authorization check; it cannot inherit the read-only decision.
  const writeIdentity = normalizeTaskContract({
    ...readIdentity, allowed_actions: ["read", "write"], required_actions: ["read", "write"],
  });
  const write = await taskContractPreflight(db(), "project-1", writeIdentity, false, {
    detailed: true,
    principalId: "principal-1",
    content: "read fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request)),
    now: () => now,
  });
  assert.deepEqual(write.blockers, []);
  assert.ok(write.targetAuthorization);
  assert.ok(write.authorizedActions?.includes("write"));
});

test("test-only target transport requires loopback, a fake credential and the exact actions, and never replays a timeout", async () => {
  const authorized = await taskContractPreflight(db(), "project-1", contract(), false, {
    detailed: true,
    principalId: "principal-1",
    content: "bounded target fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    targetAuthorizationFetch: fetchFixture((request) => allowedResponse(request)),
    now: () => now,
  });
  assert.ok(authorized.targetAuthorization);
  const input = {
    jobId: "job-1",
    fixtureBaseUrl: "http://127.0.0.1:38168",
    fixtureCredential: TARGET_FIXTURE_CREDENTIAL,
  };
  for (const fixtureBaseUrl of ["http://192.168.3.10:38168", "https://127.0.0.1:38168", "http://127.0.0.1:38168/target", "http://fixture:fixture@127.0.0.1:38168"]) {
    await assert.rejects(executeReferenceTargetFixture(authorized.targetAuthorization, { ...input, fixtureBaseUrl }), { code: "target_fixture_invalid" });
  }
  await assert.rejects(executeReferenceTargetFixture(authorized.targetAuthorization, {
    ...input, fixtureCredential: secret as typeof TARGET_FIXTURE_CREDENTIAL,
  }), { code: "target_fixture_invalid" });
  const forgedActions = {
    ...authorized.targetAuthorization,
    requested_actions: [...REFERENCE_TARGET_ACTIONS.slice(0, 2)],
  };
  await assert.rejects(
    executeReferenceTargetFixture(forgedActions, input),
    (error: unknown) => error instanceof Error
      && (error as { code?: unknown }).code === "target_execution_snapshot_invalid",
  );
  let calls = 0;
  const server = createServer(() => { calls += 1; });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(executeReferenceTargetFixture(authorized.targetAuthorization, {
      ...input, fixtureBaseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100,
    }), { code: "target_execution_timeout" });
    assert.equal(calls, 1, "an unknown first action must not be replayed or advance the chain");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("authority timeout, malformed and oversized replies are bounded and do not expose secrets", async () => {
  const options = {
    principalId: "principal-1",
    content: "save -> publish -> trigger fixture",
    targetAuthorizationConfig: config,
    targetAuthorizationEnv: env,
    now: () => now,
  };
  const malformed = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationFetch: async () => new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.ok(malformed.some((item) => item.code === "target_authorization_malformed"));
  const oversized = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationFetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "999999" } }),
  });
  assert.ok(oversized.some((item) => item.code === "target_authorization_response_too_large"));
  const timedOut = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationConfig: referenceTargetConfig({ ...config, timeoutMs: 50 }),
    // The transport intentionally ignores AbortSignal. The Scheduler client
    // must still return at its own deadline and fail closed.
    targetAuthorizationFetch: async () => await new Promise<Response>(() => {}),
  });
  assert.ok(timedOut.some((item) => item.code === "target_authorization_timeout"));
  assert.doesNotMatch(JSON.stringify(timedOut), /target-auth-fixture-value/);

  const stalledBody = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationConfig: referenceTargetConfig({ ...config, timeoutMs: 50 }),
    targetAuthorizationFetch: async () => new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });
  assert.ok(stalledBody.some((item) => item.code === "target_authorization_timeout"));

  const expired = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    detailed: true,
    targetAuthorizationFetch: fetchFixture((request) => ({
      ...allowedResponse(request),
      expires_at: new Date(now.getTime() - 1).toISOString(),
    })),
  });
  assert.ok(expired.blockers.some((item) => item.code === "target_authorization_expired"));

  const redirect = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationFetch: async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:38168/other" },
    }),
  });
  assert.ok(redirect.some((item) => item.code === "target_authorization_redirect_rejected"));

  const redirectError = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationFetch: async () => {
      const error = new TypeError("redirect mode rejected") as TypeError & { cause?: { code: string } };
      error.cause = { code: "UND_ERR_REDIRECT" };
      throw error;
    },
  });
  assert.ok(redirectError.some((item) => item.code === "target_authorization_redirect_rejected"));

  const unavailable = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationFetch: async () => { throw new TypeError("authority connection failed"); },
  });
  assert.ok(unavailable.some((item) => item.code === "target_authorization_unavailable"));

  const missingSecret = await taskContractPreflight(db(), "project-1", contract(), false, {
    ...options,
    targetAuthorizationEnv: {},
    targetAuthorizationFetch: async () => { throw new Error("must not call authority without a secret"); },
  });
  assert.ok(missingSecret.some((item) => item.code === "target_authorization_secret_unavailable"));
});
