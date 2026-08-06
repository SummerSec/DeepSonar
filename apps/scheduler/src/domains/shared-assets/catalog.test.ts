import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARED_ASSETS_READONLY_ROOT,
  SHARED_ASSETS_WORKSPACE_CATALOG,
  buildJobSharedAssetCatalog,
} from "./catalog.js";

test("buildJobSharedAssetCatalog strips blob_uri and adds read_path + access guide", () => {
  const catalog = buildJobSharedAssetCatalog({
    revision: "abc",
    assets: [{
      key: "scripts/repro.sh",
      mount_path: `${SHARED_ASSETS_READONLY_ROOT}/project/scripts/repro.sh`,
      blob_uri: "shared-assets/sha256/aa/" + "a".repeat(64),
      sha256: "a".repeat(64),
      scope: "project",
    }],
  });
  assert.equal(catalog.version, 1);
  assert.equal(catalog.revision, "abc");
  assert.equal(catalog.readonly, true);
  assert.equal(catalog.readonly_root, SHARED_ASSETS_READONLY_ROOT);
  assert.equal(catalog.access.how, "read_mount_path");
  assert.equal(catalog.assets.length, 1);
  assert.equal(catalog.assets[0]?.key, "scripts/repro.sh");
  assert.equal(catalog.assets[0]?.read_path, catalog.assets[0]?.mount_path);
  assert.equal("blob_uri" in (catalog.assets[0] as object), false);
  assert.match(SHARED_ASSETS_WORKSPACE_CATALOG, /\.deepsonar\/shared-assets-catalog\.json$/);
});
