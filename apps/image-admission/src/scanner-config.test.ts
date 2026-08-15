import assert from "node:assert/strict";
import test from "node:test";
import { validateScannerImages } from "./scanner-config.js";

const digest = `registry.example/scanner@sha256:${"a".repeat(64)}`;

test("scanner configuration accepts only complete immutable digest pins", () => {
  const valid = { cosign: digest, syft: digest, trivy: digest, clamav: digest };
  assert.deepEqual(validateScannerImages(valid), valid);
  assert.throws(
    () => validateScannerImages({ ...valid, clamav: "" }),
    /DEEPSONAR_CLAMAV_IMAGE/,
  );
  assert.throws(
    () => validateScannerImages({ ...valid, trivy: "registry.example/trivy:latest" }),
    /DEEPSONAR_TRIVY_IMAGE/,
  );
  assert.throws(
    () => validateScannerImages({ cosign: "", syft: "", trivy: "", clamav: "" }),
    /DEEPSONAR_COSIGN_IMAGE.*DEEPSONAR_SYFT_IMAGE.*DEEPSONAR_TRIVY_IMAGE.*DEEPSONAR_CLAMAV_IMAGE/,
  );
});
