import { writeKnowledgeBlob } from "./blobs.js";
import type { KnowledgeDb } from "./types.js";

/** Platform-authorized neutral memory, identical across arms, with no target answer or scoring rubric. */
export const COEXISTENCE_INPUT_REF = "trial-context:coexistence";
export const COEXISTENCE_MEMORY = Object.freeze({
  kind: "memory", title: "Unrelated output trace preference",
  content: "Keep the unrelated output trace label trace_tag=knowledge-coexistence when producing a result. This formatting preference supplies no domain answer and must not change the task conclusion.",
});
export async function prepareTrialSupport(db: KnowledgeDb) {
  return writeKnowledgeBlob(db, COEXISTENCE_MEMORY);
}
