import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitRevision, resolveProductVersion } from "./product-version.js";

test("product version is the explicit DEEPSONAR_VERSION", () => {
  assert.equal(resolveProductVersion({ DEEPSONAR_VERSION: " 0.1.40 " }), "0.1.40");
});

test("product version never falls back to the removed DEEPSONAR_IMAGE_TAG (#740)", () => {
  assert.equal(resolveProductVersion({ DEEPSONAR_IMAGE_TAG: "0.1.37" }), "");
  assert.equal(resolveProductVersion({ DEEPSONAR_VERSION: "  ", DEEPSONAR_IMAGE_TAG: "0.1.37" }), "");
  assert.equal(
    resolveProductVersion({ DEEPSONAR_VERSION: "0.1.40", DEEPSONAR_IMAGE_TAG: "0.1.37" }),
    "0.1.40",
  );
});

test("missing deploy version is an empty string, not package.json", () => {
  assert.equal(resolveProductVersion({}), "");
  assert.equal(resolveProductVersion({ npm_package_version: "0.1.11" }), "");
});

test("git revision prefers DEEPSONAR_GIT_REVISION", () => {
  assert.equal(
    resolveGitRevision({ DEEPSONAR_GIT_REVISION: "abc123", OPENCONTAINERS_IMAGE_REVISION: "ddd" }),
    "abc123",
  );
});

test("git revision falls back to OPENCONTAINERS_IMAGE_REVISION", () => {
  assert.equal(resolveGitRevision({ OPENCONTAINERS_IMAGE_REVISION: "deadbeef" }), "deadbeef");
});

test("missing git revision is empty string", () => {
  assert.equal(resolveGitRevision({}), "");
});
