import assert from "node:assert/strict";
import test from "node:test";
import { ControlToolInputSchemasJson } from "@deepsonar/shared-types";
import {
  buildCapabilitiesProjection,
  buildPlatformOpenApiDocument,
  PLATFORM_CONTROL_ROUTE_PATHS,
} from "./operations.js";
import {
  capabilityExpiryForJob,
  generateCapabilityToken,
  hashJobSnapshot,
  parseCapabilityToken,
} from "./tokens.js";
import { canonicalPlatformInputHash } from "./routes.js";
import {
  PlatformRuntimeHandlerError,
  registerRuntimeHandler,
  unregisterRuntimeHandler,
  invokeRuntimeHandler,
  listRuntimeHandlers,
} from "./registry.js";

test("Platform API routes use the same-level Job-scoped contract", () => {
  assert.deepEqual(PLATFORM_CONTROL_ROUTE_PATHS, {
    capabilities: "/control/v1/jobs/:jobId/capabilities",
    openapi: "/control/v1/jobs/:jobId/openapi.json",
    operation: "/control/v1/jobs/:jobId/operations/:operationId",
  });
});

test("dynamic OpenAPI only projects allowlisted concrete operations", () => {
  const document = buildPlatformOpenApiDocument({
    jobId: "00000000-0000-4000-8000-000000000001",
    operationIds: ["emit_progress", "list_available_roles"],
  });
  const paths = document.paths as Record<string, Record<string, any>>;
  assert.ok(paths["/control/v1/jobs/{jobId}/operations/emit_progress"]?.post);
  assert.ok(paths["/control/v1/jobs/{jobId}/operations/list_available_roles"]?.post);
  assert.equal(paths["/control/v1/jobs/{jobId}/operations/emit_progress"].post.operationId, "emit_progress");
  assert.equal(paths["/control/v1/jobs/{jobId}/operations/emit_finding"], undefined);
  assert.deepEqual(
    paths["/control/v1/jobs/{jobId}/operations/emit_progress"].post.requestBody.content["application/json"].schema,
    ControlToolInputSchemasJson.emit_progress,
  );
  assert.equal(paths["/control/v1/jobs/{jobId}/operations/emit_progress"].post.parameters.find((p: any) => p.name === "Idempotency-Key").required, true);
});

test("capabilities projection does not expose a token and points to same-level operation URLs", () => {
  const projection = buildCapabilitiesProjection({
    jobId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    canvasId: null,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    operationIds: ["emit_fact"],
  });
  assert.equal(projection.openapi_url, "/control/v1/jobs/00000000-0000-4000-8000-000000000001/openapi.json");
  assert.equal(projection.operations[0]?.invoke_url, "/control/v1/jobs/00000000-0000-4000-8000-000000000001/operations/emit_fact");
  assert.equal("token" in projection, false);
});

test("capability token generation stores only a safe prefix/hash representation", () => {
  const generated = generateCapabilityToken();
  assert.match(generated.plaintext, /^deepsonarcap_[0-9a-f]{8}_[A-Za-z0-9_-]{32,}$/);
  assert.equal(parseCapabilityToken(generated.plaintext)?.prefix, generated.prefix);
  assert.equal(parseCapabilityToken("deepsonar_test_secret"), null);
  assert.equal(hashJobSnapshot({ b: 2, a: 1 }), hashJobSnapshot({ a: 1, b: 2 }));
  assert.notEqual(generated.hash, generated.plaintext);
});

test("capability expiry covers the Job deadline but explicit TTL can only shorten it", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const deadline = capabilityExpiryForJob({ now, startedAt: now, timeoutSec: 7200 });
  assert.equal(deadline.toISOString(), "2030-01-01T02:00:00.000Z");
  const shortened = capabilityExpiryForJob({ now, startedAt: now, timeoutSec: 7200, ttlSec: 600 });
  assert.equal(shortened.toISOString(), "2030-01-01T00:10:00.000Z");
  const capped = capabilityExpiryForJob({ now, startedAt: now, timeoutSec: 600, ttlSec: 7200 });
  assert.equal(capped.toISOString(), "2030-01-01T00:10:00.000Z");
});

test("canonical input hashing distinguishes changed idempotent payloads", () => {
  assert.equal(canonicalPlatformInputHash({ b: 2, a: 1 }), canonicalPlatformInputHash({ a: 1, b: 2 }));
  assert.notEqual(canonicalPlatformInputHash({ message: "one" }), canonicalPlatformInputHash({ message: "two" }));
});

test("runtime handler registry supports JSON read results and lifecycle operations", async () => {
  const jobId = "00000000-0000-4000-8000-000000000003";
  unregisterRuntimeHandler(jobId);
  let calls = 0;
  registerRuntimeHandler(jobId, async (context) => {
    calls += 1;
    return { operation: context.operationId, event_id: context.eventId, input: context.input };
  });
  assert.deepEqual(listRuntimeHandlers(jobId), ["*"]);
  const result = await invokeRuntimeHandler({
    jobId,
    projectId: "00000000-0000-4000-8000-000000000004",
    canvasId: null,
    operationId: "list_available_roles",
    input: {},
    eventId: "00000000-0000-4000-8000-000000000005",
    tokenId: "00000000-0000-4000-8000-000000000006",
    idempotencyKey: "00000000-0000-4000-8000-000000000007",
  });
  assert.deepEqual(result, {
    operation: "list_available_roles",
    event_id: "00000000-0000-4000-8000-000000000005",
    input: {},
  });
  assert.equal(calls, 1);
  assert.equal(unregisterRuntimeHandler(jobId), true);
  await assert.rejects(
    () => invokeRuntimeHandler({
      jobId,
      projectId: "00000000-0000-4000-8000-000000000004",
      canvasId: null,
      operationId: "list_shared_assets",
      input: {},
      eventId: "00000000-0000-4000-8000-000000000005",
      tokenId: "00000000-0000-4000-8000-000000000006",
      idempotencyKey: null,
    }),
    (error: unknown) => error instanceof PlatformRuntimeHandlerError && error.code === "HANDLER_NOT_REGISTERED",
  );
});

test("runtime handler registry preserves safe semantic rejection metadata", async () => {
  const jobId = "00000000-0000-4000-8000-000000000013";
  registerRuntimeHandler(jobId, async () => {
    throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", "rejected", {
      statusCode: 422,
      errorCode: "invalid_payload",
      retryable: true,
      path: "message",
    });
  });
  await assert.rejects(
    () => invokeRuntimeHandler({
      jobId,
      projectId: "00000000-0000-4000-8000-000000000014",
      canvasId: null,
      operationId: "emit_progress",
      input: {},
      eventId: "00000000-0000-4000-8000-000000000015",
      tokenId: "00000000-0000-4000-8000-000000000016",
      idempotencyKey: "00000000-0000-4000-8000-000000000017",
    }),
    (error: unknown) => error instanceof PlatformRuntimeHandlerError
      && error.code === "OPERATION_REJECTED"
      && error.rejection?.errorCode === "invalid_payload",
  );
  unregisterRuntimeHandler(jobId);
});
