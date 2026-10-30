import { createHash } from "node:crypto";
import { canonicalTaskContract, type TaskContract } from "@deepsonar/shared-types";

/** Content identity of operator-supplied rules; never a claim of official provenance. */
export function taskContractDigest(contract: TaskContract): string {
  return `sha256:${createHash("sha256").update(canonicalTaskContract(contract)).digest("hex")}`;
}
