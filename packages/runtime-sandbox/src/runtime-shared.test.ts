import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_MANUAL_CONTRACT,
  RUNTIME_MANUAL_INDEX_PATH,
  RuntimeImageContractError,
  parseRuntimeManualIndex,
  parseRuntimeManualMetadata,
  parseToolManifest,
} from "./runtime-shared.js";

const manualHash = "a".repeat(64);

function validManual() {
  return {
    contract: RUNTIME_MANUAL_CONTRACT,
    path: RUNTIME_MANUAL_INDEX_PATH,
    version: "2026.09.17",
    sha256: manualHash,
    count: 1,
  };
}

test("tool manifest keeps legacy manifests readable and parses manual metadata", () => {
  assert.equal(parseToolManifest('{"contract":"deepsonar.runtime/v1"}').manual, undefined);
  assert.deepEqual(parseToolManifest(JSON.stringify({ contract: "deepsonar.runtime/v1", manual: validManual() })).manual, validManual());
});

test("runtime manual metadata rejects a wrong path, digest, or empty count", () => {
  assert.throws(
    () => parseRuntimeManualMetadata({ ...validManual(), path: "/tmp/manual.json" }),
    (error) => error instanceof RuntimeImageContractError && /path is invalid/.test(error.message),
  );
  assert.throws(
    () => parseRuntimeManualMetadata({ ...validManual(), sha256: "A".repeat(64) }),
    (error) => error instanceof RuntimeImageContractError && /sha256 is invalid/.test(error.message),
  );
  assert.throws(
    () => parseRuntimeManualMetadata({ ...validManual(), count: 0 }),
    (error) => error instanceof RuntimeImageContractError && /count is invalid/.test(error.message),
  );
});

test("runtime manual index must agree with manifest metadata", () => {
  const index = parseRuntimeManualIndex(JSON.stringify({
    contract: RUNTIME_MANUAL_CONTRACT,
    image_key: "deepsonar-base",
    manual_version: "2026.09.17",
    path: RUNTIME_MANUAL_INDEX_PATH,
    entries: [{ id: "jq", doc: "tools/jq.md" }],
    manual_sha256: manualHash,
  }));
  assert.equal(index.entries.length, 1);
  assert.throws(
    () => parseRuntimeManualIndex(JSON.stringify({ ...index, path: "/workspace/manual.json" })),
    /runtime manual index path is invalid/,
  );
});
