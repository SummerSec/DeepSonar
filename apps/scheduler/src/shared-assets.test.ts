import assert from "node:assert/strict";
import test from "node:test";
import { ListSharedAssetsPayload, PublishSharedAssetPayload } from "@deepsonar/shared-types";
import { mountPathFor, normalizeAssetKey, validateAssetContentType } from "./domains/shared-assets/index.js";
import { MAX_RELATED_FINDING_IDS, parseRelatedFindingIds } from "./core.js";

test("shared asset keys and mount paths reject traversal and host paths", () => {
  assert.equal(normalizeAssetKey("scripts/reproduce.sh"), "scripts/reproduce.sh");
  assert.equal(normalizeAssetKey("/docs/range.md"), "docs/range.md");
  for (const value of ["../secret", "a/../b", "a//b", ".", "C:\\secret", "a\0b"]) {
    assert.throws(() => normalizeAssetKey(value), /invalid_asset_key/);
  }
  assert.equal(
    mountPathFor("finding", "123e4567-e89b-12d3-a456-426614174000", "poc/run.sh"),
    "/workspace/.deepsonar/shared/finding/123e4567-e89b-12d3-a456-426614174000/poc/run.sh",
  );
});

test("Agent publish schema is strict and cannot publish platform or shared-mount files", () => {
  assert.equal(PublishSharedAssetPayload.parse({ scope: "project", source_path: "/workspace/dist/app.jar", key: "dist/app.jar" }).scope, "project");
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "platform", source_path: "/workspace/a", key: "a" }));
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path: "/workspace/.deepsonar/shared/project/a", key: "a" }));
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path: "/etc/passwd", key: "a" }));
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path: "/workspace/a", key: "a", extra: true }));
});

test("shared asset MIME and extension allowlists agree and reject disguised executables", () => {
  assert.equal(validateAssetContentType("application/x-sh", "scripts/run.sh"), "application/x-sh");
  assert.equal(validateAssetContentType("text/x-python; charset=utf-8", "poc/reproduce.py"), "text/x-python");
  assert.equal(validateAssetContentType("text/javascript", "tools/check.mjs"), "text/javascript");
  assert.throws(() => validateAssetContentType("text/plain", "payload.exe"), /asset_content_type_not_allowed/);
  assert.throws(() => validateAssetContentType("application/zip", "payload.txt"), /asset_content_type_not_allowed/);
});

test("shared asset catalog queries are explicitly paginated", () => {
  assert.deepEqual(ListSharedAssetsPayload.parse({ limit: 25, offset: 50 }), { limit: 25, offset: 50 });
  assert.throws(() => ListSharedAssetsPayload.parse({ limit: 501 }));
  assert.throws(() => ListSharedAssetsPayload.parse({ offset: -1 }));
});

test("related Finding declarations are bounded, canonical, and normalized before snapshot selection", () => {
  const ids = [
    "123E4567-E89B-12D3-A456-426614174000",
    "223e4567-e89b-12d3-a456-426614174000",
  ];
  assert.deepEqual(parseRelatedFindingIds({ related_finding_ids: ids }), ids.map((id) => id.toLowerCase()));
  assert.deepEqual(parseRelatedFindingIds({}), []);
  assert.throws(() => parseRelatedFindingIds({ related_finding_ids: "not-an-array" }), /related_finding_ids_invalid/);
  assert.throws(
    () => parseRelatedFindingIds({ related_finding_ids: Array.from({ length: MAX_RELATED_FINDING_IDS + 1 }, () => ids[0]) }),
    /related_finding_ids_invalid/,
  );
  assert.throws(() => parseRelatedFindingIds({ related_finding_ids: [ids[0], ids[0].toLowerCase()] }), /related_finding_ids_duplicate/);
  assert.throws(() => parseRelatedFindingIds({ related_finding_ids: [" 123e4567-e89b-12d3-a456-426614174000"] }), /related_finding_ids_invalid/);
});
