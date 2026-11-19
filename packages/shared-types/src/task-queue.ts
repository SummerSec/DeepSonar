import { z } from "zod";

export const ProjectTaskQueueYieldInput = z.object({
  mutation_id: z.string().uuid(),
  canvas_id: z.string().min(1).max(200),
  expected_item_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  request_id: z.string().uuid(),
  expected_revision: z.number().int().nonnegative().max(2147483647),
}).strict();

export type ProjectTaskQueueYieldInput = z.infer<typeof ProjectTaskQueueYieldInput>;
