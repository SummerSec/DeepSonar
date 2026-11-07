import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../../db.js";
import { readRuntimeArtifact, RuntimeArtifactReadError } from "../../runtime-evidence.js";

const RuntimeReadQuery = z.object({
  path: z.string().min(1).max(256),
  attempt_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pointer: z.string().max(4096).optional(),
  bytes: z.string().regex(/^(0|[1-9][0-9]*)$/u).transform(Number).pipe(z.number().int().nonnegative().safe()).optional(),
}).strict();

export function registerRuntimeEvidenceRoutes(app: FastifyInstance): void {
  app.get("/jobs/:id/evidence/runtime", async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id: unknown }).id);
    const query = RuntimeReadQuery.safeParse(req.query);
    if (!id.success || !query.success) return reply.code(400).send({ error: "Invalid runtime archive selector", error_code: "PI_RPC_READ_INVALID" });
    const [job] = await sql`SELECT id FROM jobs WHERE id=${id.data}`;
    if (!job) return reply.code(404).send({ error: "job not found", error_code: "PI_RPC_ARCHIVE_NOT_FOUND" });
    try { return await readRuntimeArtifact(id.data, query.data); }
    catch (error) {
      if (error instanceof RuntimeArtifactReadError) return reply.code(error.status).send({ error: error.code, error_code: error.code });
      return reply.code(500).send({ error: "Runtime archive read failed", error_code: "PI_RPC_READ_FAILED" });
    }
  });
}
