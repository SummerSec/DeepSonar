import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimeManualLabel,
  RUNTIME_MANUAL_CONTRACT,
  RUNTIME_MANUAL_INDEX_PATH,
  validateRuntimeManualPair,
} from "./runtime-manual.js";

const metadata = {
  contract: RUNTIME_MANUAL_CONTRACT,
  path: RUNTIME_MANUAL_INDEX_PATH,
  version: "2026.09.17",
  sha256: "a".repeat(64),
  count: 1,
};

const index = {
  contract: RUNTIME_MANUAL_CONTRACT,
  image_key: "deepsonar-base",
  manual_version: metadata.version,
  path: RUNTIME_MANUAL_INDEX_PATH,
  entries: [{ id: "jq", doc: "tools/jq.md" }],
  manual_sha256: metadata.sha256,
};

test("official image manual label and index metadata are validated together", () => {
  assert.doesNotThrow(() => assertRuntimeManualLabel({ "io.deepsonar.manuals": RUNTIME_MANUAL_INDEX_PATH }, true));
  assert.deepEqual(validateRuntimeManualPair(metadata, index), metadata);
});

test("official image without the canonical manual label fails closed", () => {
  assert.throws(() => assertRuntimeManualLabel({}, true), /missing the runtime manual label/);
  assert.throws(() => assertRuntimeManualLabel({ "io.deepsonar.manuals": "/tmp/index.json" }, false), /must point/);
  assert.throws(() => validateRuntimeManualPair(metadata, { ...index, manual_sha256: "b".repeat(64) }), /does not match metadata/);
  assert.throws(() => validateRuntimeManualPair(metadata, index, "deepsonar-mobile"), /image_key does not match/);
});
