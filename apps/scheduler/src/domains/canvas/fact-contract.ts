import { z } from "zod";
import { FactVerificationStatus } from "@deepsonar/shared-types";

const commaList = <T extends z.ZodType<string, string>>(item: T, max = 20) => z
  .string()
  .transform((value) => [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))])
  .pipe(z.array(item).min(1).max(max));

export const FactListQuery = z
  .object({
    limit: z.string().regex(/^[1-9][0-9]*$/u).transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
    after: z.string().min(8).max(512).optional(),
    verification_status: commaList(FactVerificationStatus).optional(),
    evidence_kind: commaList(z.enum(["review", "test"])).optional(),
    finding_id: commaList(z.string().uuid(), 50).optional(),
    job_id: commaList(z.string().uuid(), 50).optional(),
  })
  .strict();

export const FactVerificationPatch = z
  .object({
    status: z.enum(["verified", "rejected", "needs_human"]),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
