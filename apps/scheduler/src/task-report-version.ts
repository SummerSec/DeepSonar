export interface TaskReportVersionPlan {
  alreadySucceeded: boolean;
  reuseVersion: boolean;
  version: number;
}

/** 根据最新版本和冻结输入摘要决定幂等返回、复用失败版本或追加新版本。 */
export function planTaskReportVersion(
  existing: { version: number; status: string; input_sha256: string } | null,
  inputSha256: string,
): TaskReportVersionPlan {
  const alreadySucceeded = Boolean(existing?.status === "succeeded" && existing.input_sha256 === inputSha256);
  const reuseVersion = Boolean(
    existing && ["failed", "pending", "generating"].includes(existing.status) && existing.input_sha256 === inputSha256,
  );
  return {
    alreadySucceeded,
    reuseVersion,
    version: reuseVersion ? Number(existing?.version) : Number(existing?.version ?? 0) + 1,
  };
}
