import { immutablePublishedImageRef } from "./oci-image-size.mjs";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Turn one release destination inspection into auditable evidence.
 *
 * This function is intentionally pure: it never fetches a registry and it
 * never treats a string assembled from the build digest as publication
 * evidence. Available records require a destination ref and the digest
 * returned by a real inspect call; unavailable optional channels carry no ref.
 */
export function buildRegistryRecord({
  channel,
  configured,
  reference,
  canonicalDigest,
  inspectedDigest,
  inspectError,
  unavailableReason,
}) {
  if (typeof channel !== "string" || channel.trim() === "") throw new Error("registry channel is required");
  if (typeof canonicalDigest !== "string" || !DIGEST_RE.test(canonicalDigest)) {
    throw new Error(`${channel} canonical digest is invalid`);
  }
  const hasReference = typeof reference === "string" && reference.trim() !== "";
  if (configured !== true) {
    if (hasReference) throw new Error(`${channel} unavailable must not provide a reference`);
    const reason = typeof unavailableReason === "string" && unavailableReason.trim() !== ""
      ? unavailableReason.trim()
      : `${channel}_not_configured`;
    return { available: false, provenance: "unavailable", reason };
  }
  if (!hasReference) throw new Error(`${channel} configured but missing destination reference`);
  if (inspectError) throw new Error(`${channel} destination inspect failed`, { cause: inspectError });
  if (typeof inspectedDigest !== "string" || !DIGEST_RE.test(inspectedDigest)) {
    throw new Error(`${channel} destination inspect did not return a digest`);
  }
  if (inspectedDigest !== canonicalDigest) {
    throw new Error(`${channel} destination inspect digest ${inspectedDigest} does not equal canonical ${canonicalDigest}`);
  }
  return {
    available: true,
    ref: immutablePublishedImageRef(reference, inspectedDigest),
    inspect_digest: inspectedDigest,
    provenance: channel === "github" ? "build-push+inspect" : "cross-registry-copy+inspect",
  };
}
