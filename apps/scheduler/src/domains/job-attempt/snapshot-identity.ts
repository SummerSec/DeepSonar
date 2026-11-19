import { createHash } from "node:crypto";

export function attemptSnapshotIdentity(snapshot: unknown): Record<string, string> {
  const value = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const runtimeImage = value.runtime_image && typeof value.runtime_image === "object" && !Array.isArray(value.runtime_image)
    ? value.runtime_image as Record<string, unknown>
    : {};
  const adapter = value.agent_runtime && typeof value.agent_runtime === "object" && !Array.isArray(value.agent_runtime)
    ? value.agent_runtime as Record<string, unknown>
    : {};
  const identity = {
    ...(typeof value.agent_cli === "string" ? { agent_cli: value.agent_cli } : {}),
    ...(typeof value.snapshot_sha256 === "string" ? { snapshot_sha256: value.snapshot_sha256 } : {}),
    ...(typeof adapter.adapter_id === "string" ? { adapter_id: adapter.adapter_id } : {}),
    ...(typeof adapter.adapter_version === "string" ? { adapter_version: adapter.adapter_version } : {}),
    ...(typeof runtimeImage.image_ref === "string" ? { runtime_image_ref: runtimeImage.image_ref } : {}),
    ...(typeof runtimeImage.image_key === "string" ? { runtime_image_key: runtimeImage.image_key } : {}),
  };
  if (!identity.snapshot_sha256) {
    identity.snapshot_sha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  return identity;
}
