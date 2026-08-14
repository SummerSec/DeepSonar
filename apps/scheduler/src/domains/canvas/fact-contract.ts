import { z } from "zod";
import { FactVerificationStatus } from "@deepsonar/shared-types";

export const FactListQuery = z
  .object({
    limit: z.string().regex(/^[1-9][0-9]*$/u).transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
    after: z.string().min(8).max(512).optional(),
    verification_status: FactVerificationStatus.optional(),
    evidence_kind: z.enum(["review", "test"]).optional(),
    finding_id: z.string().uuid().optional(),
    job_id: z.string().uuid().optional(),
  })
  .strict();

export const FactVerificationPatch = z
  .object({
    status: z.enum(["verified", "rejected", "needs_human"]),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
