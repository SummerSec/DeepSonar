import { DonePayload } from "@deepsonar/shared-types";
import { ControlInputError } from "./control-input.js";

/** Pure completion preparation: no state mutation, event append or Job settlement. */
export function prepareCompletionPayload(payload: unknown, isVerify: boolean): DonePayload {
  const parsed = DonePayload.safeParse(payload);
  if (!parsed.success) throw new ControlInputError("invalid_done", "mark_job_done 参数非法");
  const value = parsed.data;
  if (isVerify && !value.verdict) throw new ControlInputError("invalid_done", "verify 必须提供 verdict", "verdict");
  if (!isVerify && (value.verdict || value.missing_evidence)) {
    throw new ControlInputError("invalid_done", "非 verify Job 不得提供 verdict 或 missing_evidence");
  }
  if (isVerify && value.verdict === "rework" && !value.missing_evidence?.length) {
    throw new ControlInputError("invalid_done", "verdict=rework 必须列出 missing_evidence", "missing_evidence");
  }
  return value;
}
