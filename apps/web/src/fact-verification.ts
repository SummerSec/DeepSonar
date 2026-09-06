import type { FactVerificationStatus } from "./api";

export type HumanFactVerificationStatus = "verified" | "rejected" | "needs_human";

export function factHumanActions(status: FactVerificationStatus): HumanFactVerificationStatus[] {
  if (status === "verified") return ["rejected", "needs_human"];
  if (status === "rejected") return ["needs_human"];
  if (status === "needs_human") return ["verified", "rejected"];
  return ["verified", "rejected", "needs_human"];
}
