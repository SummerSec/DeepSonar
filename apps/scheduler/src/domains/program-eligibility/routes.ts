import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { sql } from "../../db.js";
import { actorHasScope } from "../../auth.js";
import {
  canRegisterMaterial,
  canReviewEligibility,
  type ProgramMaterialView,
} from "./model.js";
import {
  loadProgramEligibilityDetail,
  loadProgramMaterials,
  ProgramEligibilityStoreError,
  registerProgramMaterial,
  revokeProgramMaterial,
  submitProgramEligibilityReview,
} from "./store.js";
import {
  ProgramEligibilityReviewRequest,
  ProgramMaterialRegistrationRequest,
  ProgramMaterialRevokeRequest,
} from "@deepsonar/shared-types";

type Db = typeof sql;
const uuid = z.string().uuid();

function actorProject(req: FastifyRequest): string | undefined {
  return req.actor?.projectId ?? undefined;
}

function authError(reply: FastifyReply, code: string, message: string, status = 403) {
  return reply.code(status).send({ error: message, error_code: code });
}

function validationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "invalid program eligibility request",
    error_code: "PROGRAM_ELIGIBILITY_INVALID_PAYLOAD",
    issues: error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
  });
}

function storeError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ProgramEligibilityStoreError)) throw error;
  return reply.code(error.statusCode).send({ error: error.message, error_code: error.code });
}

function ensureProjectScope(req: FastifyRequest, projectId: string | null | undefined): boolean {
  return !req.actor?.projectId || !projectId || req.actor.projectId === projectId;
}

function materialCanBeRead(req: FastifyRequest, material: ProgramMaterialView): boolean {
  if (!req.actor?.projectId) return true;
  return material.request.scope.kind === "platform" || material.request.scope.project_id === req.actor.projectId;
}

/**
 * Program eligibility is a management/read projection over immutable audit
 * records. The registrar is intentionally separate from Job/Control API
 * routes: no Agent can invoke these handlers with a Job token.
 */
export function registerProgramEligibilityRoutes(app: FastifyInstance, db: Db = sql): void {
  app.get("/program-materials", async (req, reply) => {
    const query = req.query as { project_id?: string; include_history?: string };
    const projectId = query.project_id?.trim() || actorProject(req);
    if (projectId && !uuid.safeParse(projectId).success) return authError(reply, "INVALID_ID", "invalid project id", 400);
    if (!ensureProjectScope(req, projectId)) return authError(reply, "PROJECT_MISMATCH", "project scope mismatch");
    const loaded = await loadProgramMaterials(db, projectId);
    const items = loaded.materials.filter((material) => materialCanBeRead(req, material)
      && (query.include_history === "true" || material.status === "active"));
    return { schema_version: 1, items, invalid_history_count: loaded.invalid, history_incomplete: loaded.incomplete };
  });

  app.get("/program-materials/:id", async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? "");
    if (!uuid.safeParse(id).success) return authError(reply, "INVALID_ID", "invalid program material id", 400);
    const loaded = await loadProgramMaterials(db, actorProject(req));
    const material = loaded.materials.find((item) => item.material_id === id);
    if (!material || !materialCanBeRead(req, material)) return authError(reply, "NOT_FOUND", "program material not found", 404);
    return { schema_version: 1, material, invalid_history_count: loaded.invalid, history_incomplete: loaded.incomplete };
  });

  app.post("/program-materials", async (req, reply) => {
    const actor = req.actor;
    if (!actor || !actorHasScope(actor, "admin") && !actorHasScope(actor, "projects:write")) {
      return authError(reply, "PROGRAM_MATERIAL_PERMISSION_REQUIRED", "trusted program material admission requires an authorized operator");
    }
    const parsed = ProgramMaterialRegistrationRequest.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    if (!canRegisterMaterial(actor, parsed.data.scope)) {
      return authError(reply, "PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized for this material scope");
    }
    try {
      const result = await registerProgramMaterial(db, actor, parsed.data);
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.post("/program-materials/:id/revoke", async (req, reply) => {
    const actor = req.actor;
    const materialId = String((req.params as { id?: string }).id ?? "");
    if (!uuid.safeParse(materialId).success) return authError(reply, "INVALID_ID", "invalid program material id", 400);
    if (!actor || !actorHasScope(actor, "admin") && !actorHasScope(actor, "projects:write")) {
      return authError(reply, "PROGRAM_MATERIAL_PERMISSION_REQUIRED", "trusted program material revocation requires an authorized operator");
    }
    const parsed = ProgramMaterialRevokeRequest.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    const loaded = await loadProgramMaterials(db, actor.projectId ?? undefined);
    const material = loaded.materials.find((item) => item.material_id === materialId);
    if (!material) return authError(reply, "PROGRAM_MATERIAL_NOT_FOUND", "program material not found", 404);
    if (!canRegisterMaterial(actor, material.request.scope)) {
      return authError(reply, "PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized for this material scope");
    }
    try {
      const result = await revokeProgramMaterial(db, actor, materialId, parsed.data);
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.post("/findings/:id/program-eligibility/reviews", async (req, reply) => {
    const actor = req.actor;
    if (!canReviewEligibility(actor)) return authError(reply, "PROGRAM_ELIGIBILITY_REVIEW_PERMISSION_REQUIRED", "only an authenticated authorized operator may review eligibility");
    const findingId = String((req.params as { id?: string }).id ?? "");
    if (!uuid.safeParse(findingId).success) return authError(reply, "INVALID_ID", "invalid finding id", 400);
    const parsed = ProgramEligibilityReviewRequest.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error);
    if (parsed.data.finding_id !== findingId) return authError(reply, "FINDING_BINDING_MISMATCH", "request finding_id does not match the path", 409);
    try {
      const result = await submitProgramEligibilityReview(db, actor!, parsed.data);
      if (result.record.status === "blocked") {
        return reply.code(409).send({ error: "eligibility prerequisites are not currently satisfied", error_code: "PROGRAM_ELIGIBILITY_BLOCKED", ...result });
      }
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      return storeError(reply, error);
    }
  });

  app.get("/findings/:id/program-eligibility/reviews", async (req, reply) => {
    const findingId = String((req.params as { id?: string }).id ?? "");
    if (!uuid.safeParse(findingId).success) return authError(reply, "INVALID_ID", "invalid finding id", 400);
    const detail = await loadProgramEligibilityDetail(db, actorProject(req), findingId);
    if (!detail) return authError(reply, "NOT_FOUND", "finding not found", 404);
    return { schema_version: 1, finding_id: findingId, projection: detail.projection, reviews: detail.reviews, material: detail.material,
      invalid_history_count: detail.invalid_history_count, history_incomplete: detail.history_incomplete };
  });

  app.get("/findings/:id/program-eligibility", async (req, reply) => {
    const findingId = String((req.params as { id?: string }).id ?? "");
    if (!uuid.safeParse(findingId).success) return authError(reply, "INVALID_ID", "invalid finding id", 400);
    const detail = await loadProgramEligibilityDetail(db, actorProject(req), findingId);
    if (!detail) return authError(reply, "NOT_FOUND", "finding not found", 404);
    return { schema_version: 1, ...detail.projection, reviews: detail.reviews, material: detail.material,
      invalid_history_count: detail.invalid_history_count, history_incomplete: detail.history_incomplete };
  });
}
