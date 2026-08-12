import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ControlToolPayloadSchemas } from "@deepsonar/shared-types";
import {
  authenticateJobCapabilityToken,
  CapabilityTokenError,
  type CapabilityPrincipal,
} from "./tokens.js";
import {
  buildCapabilitiesProjection,
  buildPlatformOpenApiDocument,
  getPlatformOperation,
  type PlatformOperationDefinition,
} from "./operations.js";
import {
  invokeRuntimeHandler,
  PlatformRuntimeHandlerError,
  type PlatformRuntimeHandlerContext,
} from "./registry.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CapabilityRequest extends FastifyRequest {
  params: { jobId: string; operationId?: string };
}

interface StoredInvocationResult {
  statusCode: number;
  body: unknown;
  cacheable: boolean;
}

interface StoredInvocation {
  operationId: string;
  inputHash: string;
  result: Promise<StoredInvocationResult>;
}

/**
 * API idempotency is intentionally process-local for this first slice. A
 * restart loses the cache, while the durable event/fingerprint gates remain
 * owned by the runtime handler's existing Scheduler path.
 */
const idempotencyCache = new Map<string, StoredInvocation>();

export function clearPlatformApiIdempotencyCache(): void {
  idempotencyCache.clear();
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function sendError(reply: FastifyReply, statusCode: number, errorCode: string, error: string) {
  return reply.code(statusCode).send({ error, error_code: errorCode });
}

function genericCapabilityError(error: CapabilityTokenError): { statusCode: number; errorCode: string; message: string } {
  if (error.code === "CAPABILITY_JOB_NOT_ACTIVE") {
    return { statusCode: 409, errorCode: error.code, message: "Job is no longer active" };
  }
  if (error.code === "CAPABILITY_TOKEN_EXPIRED") {
    return { statusCode: 401, errorCode: error.code, message: "Capability token is expired" };
  }
  if (error.code === "CAPABILITY_TOKEN_REVOKED") {
    return { statusCode: 401, errorCode: error.code, message: "Capability token is revoked" };
  }
  if (error.code === "CAPABILITY_JOB_NOT_FOUND") {
    return { statusCode: 404, errorCode: error.code, message: "Job not found" };
  }
  return { statusCode: error.statusCode === 409 ? 409 : 401, errorCode: "CAPABILITY_TOKEN_INVALID", message: "Capability token is invalid" };
}

async function authenticateRequest(req: CapabilityRequest, reply: FastifyReply): Promise<CapabilityPrincipal | null> {
  const jobId = req.params?.jobId;
  if (!isUuid(jobId)) {
    sendError(reply, 400, "INVALID_JOB_ID", "Invalid Job id");
    return null;
  }
  const authorization = headerValue(req, "authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.slice(7).trim().length === 0) {
    sendError(reply, 401, "CAPABILITY_TOKEN_REQUIRED", "Capability token is required");
    return null;
  }
  try {
    return await authenticateJobCapabilityToken(jobId, authorization.slice(7).trim());
  } catch (error) {
    const safe = error instanceof CapabilityTokenError
      ? genericCapabilityError(error)
      : { statusCode: 401, errorCode: "CAPABILITY_TOKEN_INVALID", message: "Capability token is invalid" };
    sendError(reply, safe.statusCode, safe.errorCode, safe.message);
    return null;
  }
}

function operationForRequest(req: CapabilityRequest): PlatformOperationDefinition | null {
  const operationId = req.params?.operationId;
  return typeof operationId === "string" ? getPlatformOperation(operationId) : null;
}

function isAllowed(principal: CapabilityPrincipal, operationId: string): boolean {
  return principal.operationIds.includes(operationId);
}

function operationDescription(definition: PlatformOperationDefinition): Record<string, unknown> {
  return {
    operation_id: definition.operationId,
    summary: definition.summary,
    description: definition.description,
    read_only: definition.readOnly,
    event_type: definition.eventType,
    input_schema: definition.inputSchema,
  };
}

function parseOperationInput(req: CapabilityRequest, definition: PlatformOperationDefinition, fallbackEventId?: string): {
  input: unknown;
  eventId: string;
  error?: { statusCode: number; errorCode: string; message: string };
} {
  const raw = req.body;
  let input: unknown = raw === undefined ? {} : raw;
  let eventId = headerValue(req, "x-deepsonar-event-id") ?? headerValue(req, "x-event-id");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as Record<string, unknown>;
    const hasInputWrapper = Object.prototype.hasOwnProperty.call(object, "input") || Object.prototype.hasOwnProperty.call(object, "arguments");
    if (hasInputWrapper) {
      input = Object.prototype.hasOwnProperty.call(object, "input") ? object.input : object.arguments;
      if (!eventId && typeof object.event_id === "string") eventId = object.event_id;
    }
  }
  eventId ??= fallbackEventId ?? randomUUID();
  if (!isUuid(eventId)) {
    return {
      input,
      eventId,
      error: { statusCode: 400, errorCode: "INVALID_EVENT_ID", message: "Event id must be a UUID" },
    };
  }
  const schema = ControlToolPayloadSchemas[definition.operationId as keyof typeof ControlToolPayloadSchemas];
  if (!schema) {
    return {
      input,
      eventId,
      error: { statusCode: 400, errorCode: "UNKNOWN_OPERATION", message: "Operation is not registered" },
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      input,
      eventId,
      error: { statusCode: 400, errorCode: "INVALID_INPUT", message: "Operation input is invalid" },
    };
  }
  return { input: parsed.data, eventId };
}

function idempotencyKey(req: CapabilityRequest): string | undefined {
  return headerValue(req, "idempotency-key");
}

function idempotencyCacheKey(jobId: string, key: string): string {
  // A Job-scoped key must remain stable across short-lived capability token
  // rotation and process-local token re-minting. The durable event_id is the
  // idempotency key for mutation calls.
  return `${jobId}:${key}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export const canonicalPlatformInputHash = inputHash;

async function executeInvocation(
  principal: CapabilityPrincipal,
  jobId: string,
  operationId: string,
  input: unknown,
  eventId: string,
  key: string | null,
): Promise<StoredInvocationResult> {
  const context: PlatformRuntimeHandlerContext = {
    jobId,
    projectId: principal.projectId,
    canvasId: principal.canvasId,
    operationId,
    input,
    eventId,
    tokenId: principal.tokenId,
    idempotencyKey: key,
  };
  try {
    const result = await invokeRuntimeHandler(context);
    return { statusCode: 200, body: result === undefined ? null : result, cacheable: true };
  } catch (error) {
    if (error instanceof PlatformRuntimeHandlerError) {
      if (error.code === "HANDLER_NOT_REGISTERED" || error.code === "OPERATION_HANDLER_NOT_REGISTERED") {
        return { statusCode: 503, body: { error: "Runtime handler is not registered", error_code: "HANDLER_UNAVAILABLE" }, cacheable: false };
      }
      if (error.code === "OPERATION_REJECTED" && error.rejection) {
        return {
          statusCode: error.rejection.statusCode,
          body: {
            accepted: false,
            error: "Platform operation was rejected",
            error_code: error.rejection.errorCode,
            retryable: error.rejection.retryable,
            ...(error.rejection.path ? { path: error.rejection.path } : {}),
          },
          // Rate-limit rejection happens before the durable event write and
          // may be retried later with the same Job-scoped idempotency key.
          cacheable: error.rejection.statusCode !== 429,
        };
      }
    }
    // Do not return handler messages: they may contain input, credentials, or
    // a capability token accidentally included by a downstream adapter.
    return { statusCode: 500, body: { error: "Platform operation failed", error_code: "HANDLER_FAILED" }, cacheable: true };
  }
}

async function invokeOperation(req: CapabilityRequest, reply: FastifyReply, principal: CapabilityPrincipal, definition: PlatformOperationDefinition) {
  const jobId = req.params.jobId;
  if (!isAllowed(principal, definition.operationId)) {
    return sendError(reply, 403, "OPERATION_NOT_ALLOWED", "Operation is not allowed for this Job");
  }
  const key = idempotencyKey(req);
  if (!key) return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
  if (!isUuid(key)) return sendError(reply, 400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be a UUID");
  const parsed = parseOperationInput(req, definition, key);
  if (parsed.error) return sendError(reply, parsed.error.statusCode, parsed.error.errorCode, parsed.error.message);

  const cacheKey = idempotencyCacheKey(jobId, key);
  const requestHash = inputHash(parsed.input);
  const previous = idempotencyCache.get(cacheKey);
  if (previous) {
    if (previous.operationId !== definition.operationId) {
      return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for another operation");
    }
    if (previous.inputHash !== requestHash) {
      return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used with different input");
    }
    const result = await previous.result;
    return reply.code(result.statusCode).send(result.body);
  }
  const resultPromise = executeInvocation(principal, jobId, definition.operationId, parsed.input, parsed.eventId, key);
  const stored: StoredInvocation = { operationId: definition.operationId, inputHash: requestHash, result: resultPromise };
  idempotencyCache.set(cacheKey, stored);
  const result = await resultPromise;
  if (!result.cacheable && idempotencyCache.get(cacheKey) === stored) idempotencyCache.delete(cacheKey);
  return reply.code(result.statusCode).send(result.body);
}

export function registerPlatformControlRoutes(app: FastifyInstance): void {
  const sendCapabilities = async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await authenticateRequest(req as CapabilityRequest, reply);
    if (!principal) return;
    return reply.header("cache-control", "no-store").send(buildCapabilitiesProjection({
      jobId: principal.jobId,
      projectId: principal.projectId,
      canvasId: principal.canvasId,
      expiresAt: principal.expiresAt,
      operationIds: principal.operationIds,
    }));
  };

  app.get("/control/v1/jobs/:jobId/capabilities", sendCapabilities);
  app.get("/control/v1/jobs/:jobId/agent/capabilities_list", sendCapabilities);

  app.get("/control/v1/jobs/:jobId/openapi.json", async (req, reply) => {
    const principal = await authenticateRequest(req as CapabilityRequest, reply);
    if (!principal) return;
    return reply.header("cache-control", "no-store").type("application/json; charset=utf-8").send(buildPlatformOpenApiDocument({
      jobId: principal.jobId,
      operationIds: principal.operationIds,
    }));
  });

  app.get("/control/v1/jobs/:jobId/operations/:operationId", async (req, reply) => {
    const typed = req as CapabilityRequest;
    const principal = await authenticateRequest(typed, reply);
    if (!principal) return;
    const definition = operationForRequest(typed);
    if (!definition) return sendError(reply, 404, "OPERATION_NOT_FOUND", "Operation is not registered");
    if (!isAllowed(principal, definition.operationId)) return sendError(reply, 403, "OPERATION_NOT_ALLOWED", "Operation is not allowed for this Job");
    return reply.header("cache-control", "no-store").send(operationDescription(definition));
  });

  app.post("/control/v1/jobs/:jobId/operations/:operationId", async (req, reply) => {
    const typed = req as CapabilityRequest;
    const principal = await authenticateRequest(typed, reply);
    if (!principal) return;
    const definition = operationForRequest(typed);
    if (!definition) return sendError(reply, 404, "OPERATION_NOT_FOUND", "Operation is not registered");
    return invokeOperation(typed, reply, principal, definition);
  });
}

export const registerPlatformApiRoutes = registerPlatformControlRoutes;
