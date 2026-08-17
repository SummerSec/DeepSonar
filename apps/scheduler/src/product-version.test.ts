import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductVersion } from "./product-version.js";

test("product version prefers DEEPSONAR_VERSION over image tag", () => {
  assert.equal(
    resolveProductVersion({ DEEPSONAR_VERSION: "0.1.40", DEEPSONAR_IMAGE_TAG: "0.1.37" }),
    "0.1.40",
  );
});

test("product version falls back to DEEPSONAR_IMAGE_TAG", () => {
  assert.equal(resolveProductVersion({ DEEPSONAR_IMAGE_TAG: "0.1.37" }), "0.1.37");
});

test("blank DEEPSONAR_VERSION falls through to image tag", () => {
  assert.equal(
    resolveProductVersion({ DEEPSONAR_VERSION: "  ", DEEPSONAR_IMAGE_TAG: "0.1.37" }),
    "0.1.37",
  );
});

test("missing deploy version is an empty string, not package.json", () => {
  assert.equal(resolveProductVersion({}), "");
  assert.equal(resolveProductVersion({ npm_package_version: "0.1.11" }), "");
});
