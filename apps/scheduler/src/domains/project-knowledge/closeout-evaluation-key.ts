import { sha256, canonical } from "./types.js";

export const CLOSEOUT_EVALUATION_PREFIX = "knowledge:closeout-evaluation:";
export const closeoutEvaluationKey = (rootId: string, fingerprint: string) => `${CLOSEOUT_EVALUATION_PREFIX}${rootId}:${fingerprint}`;
export const isCloseoutEvaluation = (key: unknown) => typeof key === "string" && key.startsWith(CLOSEOUT_EVALUATION_PREFIX);
export function closeoutEvaluationSelection(key: unknown) {
  if (!isCloseoutEvaluation(key)) return undefined;
  const [rootId, fingerprint] = String(key).slice(CLOSEOUT_EVALUATION_PREFIX.length).split(":");
  return rootId && fingerprint ? { rootId, fingerprint } : undefined;
}
export const closeoutDraftRef = (candidateHash: string, bases: unknown) =>
  `closeout-draft:${candidateHash}:${sha256(canonical(bases))}`;
