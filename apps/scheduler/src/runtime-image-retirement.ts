import { isRetiredRuntimeImageKey, RETIRED_RUNTIME_IMAGE_KEYS } from "@deepsonar/shared-types";
import type { RuntimeImageRegistry } from "./runtime-image-registry-contract.js";

/** Validate the original catalog first. This is a server policy projection,
 * not a rewritten/signed release asset; retain provenance and name exclusions. */
export function currentRuntimeImageRegistry(registry: RuntimeImageRegistry): RuntimeImageRegistry {
  return {
    ...registry,
    images: registry.images.filter((image) => !isRetiredRuntimeImageKey(image.image_key)),
    excluded_retired_image_keys: [...RETIRED_RUNTIME_IMAGE_KEYS],
  };
}
