import type { FastifyInstance } from "fastify";
import { sql } from "../../db.js";
import { isUuid } from "../../project-scope.js";
import {
  StrongRelationStoreError,
  readCanvasStrongRelations,
  readStrongRelationPage,
  registerIdentityMapping,
  registerIdentitySource,
  remapIdentityMapping,
  revokeIdentityMapping,
  revokeIdentitySource,
  reviseIdentitySource,
  type IdentityMappingActor,
} from "./relation-store.js";
import {
  CanvasRelationsQuery,
  FindingRelationsQuery,
  IdentitySourceBody as SourceBody,
  IdentitySourceRevisionBody as SourceRevisionBody,
  IdentitySourceRevokeBody as SourceRevokeBody,
  IdentityMappingBody as MappingBody,
  IdentityMappingRevokeBody as MappingRevokeBody,
  IdentityMappingRemapBody as RemapBody,
} from "./relation-schemas.js";

function actor(request: { actor?: IdentityMappingActor }): IdentityMappingActor | null {
  return request.actor ?? null;
}

async function findingProject(findingId: string): Promise<string | null> {
  const [row] = await sql`SELECT project_id FROM findings WHERE id = ${findingId}::uuid`;
  return row ? String(row.project_id) : null;
}

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (!(error instanceof StrongRelationStoreError)) throw error;
  const forbidden = new Set(["IDENTITY_SOURCE_FORBIDDEN", "IDENTITY_MAPPING_FORBIDDEN", "PROJECT_SCOPE_MISMATCH"]);
  const missing = new Set(["FINDING_NOT_FOUND", "IDENTITY_SOURCE_NOT_FOUND", "IDENTITY_MAPPING_NOT_FOUND"]);
  const conflict = new Set([
    "CURSOR_GAP", "CURSOR_SCOPE_MISMATCH", "IDENTITY_SOURCE_CAS_CONFLICT",
    "IDENTITY_MAPPING_CAS_CONFLICT", "IDENTITY_MAPPING_REMAP_REQUIRED", "IDENTITY_MAPPING_SOURCE_CONFLICT",
  ]);
  const status = forbidden.has(error.code) ? 403 : missing.has(error.code) ? 404 : conflict.has(error.code) ? 409
    : error.code.endsWith("_WRITE_FAILED") ? 500 : 400;
  return reply.code(status).send({ error: error.message, error_code: error.code });
}

async function sourceProjectOr404(id: string, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  const projectId = await findingProject(id);
  if (!projectId) return reply.code(404).send({ error: "finding not found", error_code: "FINDING_NOT_FOUND" });
  return projectId;
}

/** Registered only after the root authentication and project ownership hooks. */
export function registerFindingRelationRoutes(app: FastifyInstance): void {
  app.get("/findings/:id/relations", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = FindingRelationsQuery.safeParse(request.query);
    if (!query.success) {
      const code = query.error.issues.some((issue) => issue.path[0] === "cursor") ? "INVALID_CURSOR" : "INVALID_QUERY";
      return reply.code(400).send({ error: "invalid relation query", error_code: code });
    }
    if (!isUuid(id)) return reply.code(400).send({ error: "invalid finding id", error_code: "INVALID_ID" });
    try {
      const result = await readStrongRelationPage(id, query.data.cursor, undefined, request.actor?.projectId);
      if (!result) return reply.code(404).send({ error: "finding not found", error_code: "FINDING_NOT_FOUND" });
      reply.header("Cache-Control", "no-store");
      return result;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/canvases/:id/finding-relations", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    if (!CanvasRelationsQuery.safeParse(request.query).success) {
      return reply.code(400).send({ error: "invalid relation query", error_code: "INVALID_QUERY" });
    }
    try {
      const result = await readCanvasStrongRelations(id, undefined, request.actor?.projectId);
      if (!result) return reply.code(404).send({ error: "canvas not found", error_code: "NOT_FOUND" });
      reply.header("Cache-Control", "no-store");
      return result;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-sources", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SourceBody.safeParse(request.body);
    if (!isUuid(id) || !parsed.success) return reply.code(400).send({ error: "invalid identity source", error_code: "INVALID_IDENTITY_SOURCE" });
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const result = await registerIdentitySource(projectId, id, parsed.data, actor(request) ?? { type: "anonymous" });
      return reply.code(201).send(result);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-sources/:sourceId/revisions", async (request, reply) => {
    const { id, sourceId } = request.params as { id: string; sourceId: string };
    const parsed = SourceRevisionBody.safeParse(request.body);
    if (!isUuid(id) || !isUuid(sourceId) || !parsed.success) {
      return reply.code(400).send({ error: "invalid identity source revision", error_code: "INVALID_IDENTITY_SOURCE" });
    }
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const { expected_source_revision, ...manifest } = parsed.data;
      const result = await reviseIdentitySource(projectId, id, sourceId, expected_source_revision, manifest, actor(request) ?? { type: "anonymous" });
      return reply.code(201).send(result);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-sources/:sourceId/revoke", async (request, reply) => {
    const { id, sourceId } = request.params as { id: string; sourceId: string };
    const parsed = SourceRevokeBody.safeParse(request.body);
    if (!isUuid(id) || !isUuid(sourceId) || !parsed.success) {
      return reply.code(400).send({ error: "invalid identity source revocation", error_code: "INVALID_IDENTITY_SOURCE" });
    }
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const result = await revokeIdentitySource(projectId, id, sourceId, parsed.data.expected_source_revision, parsed.data.reason, actor(request) ?? { type: "anonymous" });
      return result;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-mappings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = MappingBody.safeParse(request.body);
    if (!isUuid(id) || !parsed.success || parsed.data.expected_mapping_version !== null) {
      return reply.code(400).send({ error: "invalid identity mapping", error_code: "INVALID_IDENTITY_MAPPING" });
    }
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const result = await registerIdentityMapping(projectId, id, parsed.data, actor(request) ?? { type: "anonymous" });
      return reply.code(201).send(result);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-mappings/remap", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RemapBody.safeParse(request.body);
    if (!isUuid(id) || !parsed.success) return reply.code(400).send({ error: "invalid identity mapping remap", error_code: "INVALID_IDENTITY_MAPPING" });
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const { reason, ...mapping } = parsed.data;
      const result = await remapIdentityMapping(projectId, id, mapping, reason, actor(request) ?? { type: "anonymous" });
      return reply.code(201).send(result);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post("/findings/:id/identity-mappings/revoke", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = MappingRevokeBody.safeParse(request.body);
    if (!isUuid(id) || !parsed.success) {
      return reply.code(400).send({ error: "invalid identity mapping revocation", error_code: "INVALID_IDENTITY_MAPPING" });
    }
    try {
      const projectId = await sourceProjectOr404(id, reply);
      if (typeof projectId !== "string") return projectId;
      const result = await revokeIdentityMapping(projectId, id, parsed.data.field, parsed.data.expected_mapping_version, parsed.data.reason, actor(request) ?? { type: "anonymous" });
      if (!result) return reply.code(404).send({ error: "identity mapping not found", error_code: "IDENTITY_MAPPING_NOT_FOUND" });
      return result;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
}
