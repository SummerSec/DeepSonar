import { ControlToolInputSchemasJson } from "@deepsonar/shared-types";

/** JSON Schema shape used by the dynamic Job-scoped OpenAPI projection. */
export type ControlJsonSchema = Record<string, unknown>;

export interface PlatformOperationDefinition {
  operationId: string;
  summary: string;
  description: string;
  inputSchema: ControlJsonSchema;
  readOnly: boolean;
  eventType: string | null;
}

const OPERATION_DESCRIPTIONS: Record<string, { summary: string; description: string; readOnly: boolean; eventType: string | null }> = {
  list_available_roles: {
    summary: "List roles available to the current Hub Job",
    description: "Return the Scheduler-governed role catalog visible to this Job.",
    readOnly: true,
    eventType: null,
  },
  list_available_runtime_images: {
    summary: "List runtime images available to the current Hub Job",
    description: "Return the project-enabled, trusted, CLI-compatible runtime image catalog (image_key plus compatible_agent_clis) visible to this Hub Job.",
    readOnly: true,
    eventType: null,
  },
  list_shared_assets: {
    summary: "List shared assets available to the current Job",
    description: "Return the frozen read-only shared asset catalog for this Job.",
    readOnly: true,
    eventType: null,
  },
  publish_shared_asset: {
    summary: "Publish a shared asset proposal",
    description: "Submit a shared asset proposal for Scheduler validation and persistence.",
    readOnly: false,
    eventType: "shared_asset_publish",
  },
  emit_progress: {
    summary: "Emit incremental progress",
    description: "Submit an incremental progress event to the current Job.",
    readOnly: false,
    eventType: "progress",
  },
  emit_fact: {
    summary: "Emit a fact proposal",
    description: "Submit a fact proposal to the current Job canvas.",
    readOnly: false,
    eventType: "fact",
  },
  emit_finding: {
    summary: "Emit a finding proposal",
    description: "Submit a finding proposal to the current Job canvas.",
    readOnly: false,
    eventType: "finding",
  },
  submit_hub_decision: {
    summary: "Submit a Hub decision proposal",
    description: "Submit the current Hub round's complete or intent decision.",
    readOnly: false,
    eventType: "hub_decision",
  },
  mark_job_done: {
    summary: "Mark the current Job done",
    description: "Submit the final Job summary and optional verification verdict.",
    readOnly: false,
    eventType: "done",
  },
  request_human: {
    summary: "Request human intervention",
    description: "Request human intervention for an authorization or high-risk block.",
    readOnly: false,
    eventType: "human",
  },
  ack_human_message: {
    summary: "Acknowledge an injected human message",
    description: "Explicitly acknowledge a human message targeted to the current Job. Text output never implies acknowledgement.",
    readOnly: false,
    eventType: "human_message_ack",
  },
};

function cloneSchema(value: ControlJsonSchema): ControlJsonSchema {
  // The shared JSON schemas are also used by the local MCP server. Never hand
  // those objects to an HTTP response where a caller could mutate the module
  // singleton and change a later Job's projection.
  return JSON.parse(JSON.stringify(value)) as ControlJsonSchema;
}

const definitions = Object.fromEntries(
  Object.entries(ControlToolInputSchemasJson).map(([operationId, inputSchema]) => {
    const metadata = OPERATION_DESCRIPTIONS[operationId] ?? {
      summary: operationId,
      description: "DeepSonar platform control operation.",
      readOnly: false,
      eventType: null,
    };
    return [
      operationId,
      Object.freeze({
        operationId,
        summary: metadata.summary,
        description: metadata.description,
        inputSchema: cloneSchema(inputSchema as ControlJsonSchema),
        readOnly: metadata.readOnly,
        eventType: metadata.eventType,
      } satisfies PlatformOperationDefinition),
    ];
  }),
) as Record<string, PlatformOperationDefinition>;

/** Canonical API operation registry. It is intentionally independent of the
 * existing MCP server implementation; both consume shared-types schemas. */
export const PLATFORM_OPERATION_REGISTRY: Readonly<Record<string, PlatformOperationDefinition>> = Object.freeze(definitions);

export const PLATFORM_OPERATION_IDS = Object.freeze(Object.keys(PLATFORM_OPERATION_REGISTRY));

export function getPlatformOperation(operationId: string): PlatformOperationDefinition | null {
  const definition = PLATFORM_OPERATION_REGISTRY[operationId];
  if (!definition) return null;
  return {
    ...definition,
    inputSchema: cloneSchema(definition.inputSchema),
  };
}

export function isReadOnlyPlatformOperation(operationId: string): boolean {
  return PLATFORM_OPERATION_REGISTRY[operationId]?.readOnly === true;
}

export function operationIdsFromSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const values = (snapshot as Record<string, unknown>).platform_tools;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!PLATFORM_OPERATION_REGISTRY[value] || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface PlatformCapabilitiesProjection {
  job_id: string;
  project_id: string;
  canvas_id: string | null;
  expires_at: string;
  operation_ids: string[];
  operations: Array<{
    operation_id: string;
    summary: string;
    description: string;
    read_only: boolean;
    event_type: string | null;
    input_schema: ControlJsonSchema;
    input_schema_url: string;
    invoke_url: string;
  }>;
  openapi_url: string;
}

const JOB_PATH = "/control/v1/jobs/{jobId}";
const CAPABILITIES_PATH = `${JOB_PATH}/capabilities`;
const OPENAPI_PATH = `${JOB_PATH}/openapi.json`;

function errorSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      accepted: { type: "boolean" },
      error: { type: "string" },
      error_code: { type: "string" },
      retryable: { type: "boolean" },
      path: { type: "string" },
    },
    required: ["error"],
  };
}

function operationSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation_id", "summary", "description", "read_only", "input_schema", "input_schema_url", "invoke_url"],
    properties: {
      operation_id: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      read_only: { type: "boolean" },
      event_type: { type: "string", nullable: true },
      input_schema: { type: "object", additionalProperties: true },
      input_schema_url: { type: "string" },
      invoke_url: { type: "string" },
    },
  };
}

export function buildCapabilitiesProjection(input: {
  jobId: string;
  projectId: string;
  canvasId: string | null;
  expiresAt: Date | string;
  operationIds: readonly string[];
}): PlatformCapabilitiesProjection {
  const base = `/control/v1/jobs/${encodeURIComponent(input.jobId)}`;
  const operations = input.operationIds
    .map((operationId) => getPlatformOperation(operationId))
    .filter((definition): definition is PlatformOperationDefinition => definition !== null)
    .map((definition) => ({
      operation_id: definition.operationId,
      summary: definition.summary,
      description: definition.description,
      read_only: definition.readOnly,
      event_type: definition.eventType,
      input_schema: cloneSchema(definition.inputSchema),
      input_schema_url: `${base}/operations/${encodeURIComponent(definition.operationId)}`,
      invoke_url: `${base}/operations/${encodeURIComponent(definition.operationId)}`,
    }));
  return {
    job_id: input.jobId,
    project_id: input.projectId,
    canvas_id: input.canvasId,
    expires_at: new Date(input.expiresAt).toISOString(),
    operation_ids: operations.map((operation) => operation.operation_id),
    operations,
    openapi_url: `${base}/openapi.json`,
  };
}

export function buildPlatformOpenApiDocument(input: {
  jobId: string;
  operationIds: readonly string[];
}): Record<string, unknown> {
  const allowed = input.operationIds
    .map((operationId) => getPlatformOperation(operationId))
    .filter((definition): definition is PlatformOperationDefinition => definition !== null);
  const operationSchemas = Object.fromEntries(
    allowed.map((definition) => [definition.operationId, definition.inputSchema]),
  );
  const paths: Record<string, unknown> = {
    [CAPABILITIES_PATH]: {
      get: {
        operationId: "discoverJobCapabilities",
        summary: "Discover the current Job capability projection",
        security: [{ capabilityBearer: [] }],
        responses: {
          "200": {
            description: "Allowed operations for this Job",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["job_id", "project_id", "expires_at", "operation_ids", "operations", "openapi_url"],
                  properties: {
                    job_id: { type: "string", format: "uuid" },
                    project_id: { type: "string", format: "uuid" },
                    canvas_id: { type: "string", nullable: true },
                    expires_at: { type: "string", format: "date-time" },
                    operation_ids: { type: "array", items: { type: "string" } },
                    operations: { type: "array", items: operationSummarySchema() },
                    openapi_url: { type: "string" },
                  },
                },
              },
            },
          },
          "401": { description: "Capability token is missing, invalid, expired, or revoked", content: { "application/json": { schema: errorSchema() } } },
          "409": { description: "Job is no longer active", content: { "application/json": { schema: errorSchema() } } },
        },
      },
    },
    [OPENAPI_PATH]: {
      get: {
        operationId: "discoverJobOpenApi",
        summary: "Discover the current Job OpenAPI projection",
        security: [{ capabilityBearer: [] }],
        responses: {
          "200": { description: "Dynamic Job-scoped OpenAPI document", content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
  };

  for (const definition of allowed) {
    const concretePath = `${JOB_PATH}/operations/${definition.operationId}`;
    paths[concretePath] = {
      get: {
        operationId: `describe_${definition.operationId}`,
        summary: `Describe ${definition.operationId}`,
        security: [{ capabilityBearer: [] }],
        parameters: [
          { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "Operation contract",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["operation_id", "summary", "description", "input_schema", "read_only"],
                  properties: {
                    operation_id: { type: "string", const: definition.operationId },
                    summary: { type: "string" },
                    description: { type: "string" },
                    read_only: { type: "boolean" },
                    event_type: { type: "string", nullable: true },
                    input_schema: definition.inputSchema,
                  },
                },
              },
            },
          },
          "403": { description: "Operation is not in the token allowlist", content: { "application/json": { schema: errorSchema() } } },
        },
      },
      post: {
        // The POST operationId is deliberately identical to the existing MCP
        // tool name so adapters can choose either transport by logical name.
        operationId: definition.operationId,
        summary: definition.summary,
        description: definition.description,
        security: [{ capabilityBearer: [] }],
        parameters: [
          { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" } },
          { name: "X-DeepSonar-Event-Id", in: "header", required: false, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: definition.inputSchema,
            },
          },
        },
        responses: {
          "200": { description: "Handler result", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          "400": { description: "Input or idempotency key is invalid", content: { "application/json": { schema: errorSchema() } } },
          "403": { description: "Operation is not in the token allowlist", content: { "application/json": { schema: errorSchema() } } },
          "409": { description: "Idempotency key conflicts or Job is no longer active", content: { "application/json": { schema: errorSchema() } } },
          "422": { description: "Scheduler semantic validation rejected the operation", content: { "application/json": { schema: errorSchema() } } },
          "429": { description: "Scheduler semantic-event budget is temporarily exhausted", content: { "application/json": { schema: errorSchema() } } },
          "503": { description: "Runtime handler is not registered", content: { "application/json": { schema: errorSchema() } } },
        },
      },
    };
  }

  // The operation schema is only reachable through the allowlisted operation
  // path. Keep a compact vendor extension for clients that want to inspect all
  // schemas without exposing a management API.
  return {
    openapi: "3.0.3",
    info: { title: "DeepSonar Job Control API", version: "1" },
    paths,
    components: {
      securitySchemes: {
        capabilityBearer: { type: "http", scheme: "bearer", bearerFormat: "deepsonarcap_*" },
      },
      schemas: operationSchemas,
    },
    "x-deepsonar-job-id": input.jobId,
    "x-deepsonar-allowed-operation-ids": [...input.operationIds].filter((operationId) => Boolean(PLATFORM_OPERATION_REGISTRY[operationId])),
  };
}

export const PLATFORM_CONTROL_ROUTE_PATHS = Object.freeze({
  capabilities: "/control/v1/jobs/:jobId/capabilities",
  openapi: "/control/v1/jobs/:jobId/openapi.json",
  operation: "/control/v1/jobs/:jobId/operations/:operationId",
});
