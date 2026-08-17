import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SCANNER_IMAGES, resolveScannerImages, validateScannerImages } from "./scanner-config.js";

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

test("official scanner defaults are themselves immutable digest refs", () => {
  assert.deepEqual(validateScannerImages(DEFAULT_SCANNER_IMAGES), DEFAULT_SCANNER_IMAGES);
});

test("blank or whitespace scanner env falls back to official defaults", () => {
  assert.deepEqual(resolveScannerImages({}), DEFAULT_SCANNER_IMAGES);
  assert.deepEqual(
    resolveScannerImages({
      DEEPSONAR_COSIGN_IMAGE: "",
      DEEPSONAR_SYFT_IMAGE: "   ",
      DEEPSONAR_TRIVY_IMAGE: "\t",
      DEEPSONAR_CLAMAV_IMAGE: "\n",
    }),
    DEFAULT_SCANNER_IMAGES,
  );
});

test("explicit immutable scanner override wins over the official default", () => {
  const override = `registry.example/custom-trivy@sha256:${"b".repeat(64)}`;
  const resolved = resolveScannerImages({ DEEPSONAR_TRIVY_IMAGE: `  ${override}  ` });
  assert.equal(resolved.trivy, override);
  assert.equal(resolved.cosign, DEFAULT_SCANNER_IMAGES.cosign);
  assert.equal(resolved.syft, DEFAULT_SCANNER_IMAGES.syft);
  assert.equal(resolved.clamav, DEFAULT_SCANNER_IMAGES.clamav);
});

test("invalid or tag-only scanner override still fail-closed", () => {
  assert.throws(
    () => resolveScannerImages({ DEEPSONAR_SYFT_IMAGE: "anchore/syft:latest" }),
    /DEEPSONAR_SYFT_IMAGE/,
  );
  assert.throws(
    () => resolveScannerImages({
      ...Object.fromEntries(
        Object.entries(DEFAULT_SCANNER_IMAGES).map(([name, image]) => [
          `DEEPSONAR_${name.toUpperCase()}_IMAGE`,
          image,
        ]),
      ),
      DEEPSONAR_CLAMAV_IMAGE: "clamav/clamav:stable",
    }),
    /DEEPSONAR_CLAMAV_IMAGE/,
  );
});
