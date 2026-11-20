import { z } from "zod";

/** 人工决定绑定用户实际看到的技术状态、对象版本与最后轮次。 */
export const FindingVerificationControl = z.object({
  verify_status: z.string(),
  subject_revision: z.string().nullable(),
  latest_round_id: z.string().uuid().nullable(),
}).strict();

export const FindingInconclusiveBody = z.object({
  verify_status: z.literal("inconclusive"),
  reason: z.string().trim().min(1).max(2000),
  expected: FindingVerificationControl,
  mutation_id: z.string().uuid(),
}).strict();

export const FindingVerifyStatusBody = z.discriminatedUnion("verify_status", [
  z.object({
    verify_status: z.literal("needs_human"),
    reason: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
  FindingInconclusiveBody,
]);

export type FindingVerificationControl = z.infer<typeof FindingVerificationControl>;
export type FindingInconclusiveBody = z.infer<typeof FindingInconclusiveBody>;
