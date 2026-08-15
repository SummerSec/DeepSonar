export const SCANNER_NAMES = ["cosign", "syft", "trivy", "clamav"] as const;
export type ScannerName = (typeof SCANNER_NAMES)[number];
export type ScannerImages = Record<ScannerName, string>;

const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/;

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
