import type { ArtifactInput } from "@deepsonar/shared-types";
import { invalidControlPayload } from "./control-input.js";

/** Only the host can construct review records; generic Artifact extensions are not an authority. */
export function assertNoGoalReviewAuthority(input: ArtifactInput | undefined): void {
  if (input?.kind === "task.goal_evaluation" || input?.artifact_key?.startsWith("goal-review:") || input?.extensions?.task_goal_review !== undefined) {
    throw invalidControlPayload("目标评审记录必须通过冻结评审 Job 的 artifact.goal_review 提交，不能伪造宿主命名空间。", "artifact");
  }
}
