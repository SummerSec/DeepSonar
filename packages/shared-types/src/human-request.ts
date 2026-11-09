import { z } from "zod";

/** User-facing, actionable instructions attached to a new human intervention request. */
export const HumanRequestGuidance = z.object({
  question: z.string().trim().min(8).max(240),
  required_action: z.string().trim().min(8).max(2000),
  reply_instructions: z.string().trim().min(8).max(2000),
  after_reply: z.string().trim().min(8).max(1000),
}).strict();

export type HumanRequestGuidance = z.infer<typeof HumanRequestGuidance>;
