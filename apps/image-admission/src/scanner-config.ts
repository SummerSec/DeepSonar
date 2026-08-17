export const SCANNER_NAMES = ["cosign", "syft", "trivy", "clamav"] as const;
export type ScannerName = (typeof SCANNER_NAMES)[number];
export type ScannerImages = Record<ScannerName, string>;

const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/;

/**
 * Official pinned scanner images used when DEEPSONAR_*_IMAGE is unset or blank.
 * Digests resolved 2026-08-17 from registry Docker-Content-Digest for current
 * official releases: ghcr.io/sigstore/cosign/cosign:v3.1.3, anchore/syft:v1.51.0,
 * aquasec/trivy:0.74.0, clamav/clamav:1.5.4 (same digest as :stable).
 */
export const DEFAULT_SCANNER_IMAGES: ScannerImages = {
  cosign: "ghcr.io/sigstore/cosign/cosign@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8",
  syft: "docker.io/anchore/syft@sha256:678bfa565b60f747aac0f8e964fe5588a24445b8d0a480e91f6efd70020dfbb0",
  trivy: "docker.io/aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969",
  clamav: "docker.io/clamav/clamav@sha256:78810772a92b4a9168115bc6b2e0ffd702640893b9577f8c3d0432762d2655c4",
};

export function validateScannerImages(images: ScannerImages): ScannerImages {
  const invalid = SCANNER_NAMES.filter((name) => !IMMUTABLE_IMAGE.test(images[name]));
  if (invalid.length > 0) {
    throw new Error(
      `image-admission requires immutable scanner images: ${invalid
        .map((name) => `DEEPSONAR_${name.toUpperCase()}_IMAGE`)
        .join(", ")}`,
    );
  }
  return images;
}

function envImage(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

/** Unset/blank env falls back to official pins; a set value must still be an immutable digest. */
export function resolveScannerImages(env: NodeJS.ProcessEnv = process.env): ScannerImages {
  return validateScannerImages({
    cosign: envImage(env.DEEPSONAR_COSIGN_IMAGE) ?? DEFAULT_SCANNER_IMAGES.cosign,
    syft: envImage(env.DEEPSONAR_SYFT_IMAGE) ?? DEFAULT_SCANNER_IMAGES.syft,
    trivy: envImage(env.DEEPSONAR_TRIVY_IMAGE) ?? DEFAULT_SCANNER_IMAGES.trivy,
    clamav: envImage(env.DEEPSONAR_CLAMAV_IMAGE) ?? DEFAULT_SCANNER_IMAGES.clamav,
  });
}
