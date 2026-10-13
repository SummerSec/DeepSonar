import { FrozenCliCapability, FrozenCliCapabilityPack } from "@deepsonar/shared-types";
import { cliConfigFingerprint, cliPackFingerprint, findCliCapability, freezeCliCapability } from "./catalog.js";

/** Validate the immutable selection before provision; never repair from current config. */
export function assertFrozenCliCapabilities(snapshot: unknown): void {
  const value = snapshot as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new Error("CLI_CAPABILITY_SNAPSHOT_INVALID");
  if (value.cli_capabilities === undefined && value.cli_capability_pack === undefined) return;
  const capabilities = FrozenCliCapability.array().max(32).safeParse(value.cli_capabilities);
  const pack = FrozenCliCapabilityPack.safeParse(value.cli_capability_pack);
  if (!capabilities.success || !pack.success) throw new Error("CLI_CAPABILITY_SNAPSHOT_INVALID");
  const image = value.runtime_image as Record<string, unknown> | undefined;
  const imageKey = image?.image_key;
  if (pack.data.image_key !== imageKey || new Set(capabilities.data.map((item) => item.id)).size !== capabilities.data.length) {
    throw new Error("CLI_CAPABILITY_SNAPSHOT_IMAGE_OR_DUPLICATE");
  }
  for (const item of [...capabilities.data, ...pack.data.capabilities]) {
    const module = findCliCapability(item.id);
    if (!module?.default_available || !module.compatible_images.includes(String(imageKey)) || item.image_key !== imageKey) {
      throw new Error("CLI_CAPABILITY_SNAPSHOT_UNAVAILABLE");
    }
    if (item.config_fingerprint !== cliConfigFingerprint(item)
      || item.config_fingerprint !== freezeCliCapability({ module, imageKey: String(imageKey) }).config_fingerprint) {
      throw new Error("CLI_CAPABILITY_SNAPSHOT_FINGERPRINT_MISMATCH");
    }
  }
  const fingerprint = cliPackFingerprint(capabilities.data);
  if (pack.data.pack_fingerprint !== fingerprint || cliPackFingerprint(pack.data.capabilities) !== fingerprint) {
    throw new Error("CLI_CAPABILITY_PACK_FINGERPRINT_MISMATCH");
  }
}
