import { createHash } from "node:crypto";
import { canonicalTaskOutcomeSnapshot, type TaskOutcomeRuleSnapshot } from "@deepsonar/shared-types";

/** Content identity of operator-supplied rules; never a claim of official provenance. */
export function taskOutcomeSnapshotDigest(snapshot: TaskOutcomeRuleSnapshot): string {
  return `sha256:${createHash("sha256").update(canonicalTaskOutcomeSnapshot(snapshot)).digest("hex")}`;
}
