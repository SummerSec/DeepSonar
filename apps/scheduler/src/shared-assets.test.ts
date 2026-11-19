import assert from "node:assert/strict";
import test from "node:test";
import { ListSharedAssetsPayload, PublishSharedAssetPayload } from "@deepsonar/shared-types";
import {
  findSharedAssetPathConflict,
  mountPathFor,
  normalizeAssetKey,
  sharedAssetPathConflictMessage,
  validateAssetContentType,
} from "./domains/shared-assets/index.js";
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

test("#1144 同一挂载命名空间内的文件/目录前缀冲突在发布期即可判定", () => {
  // 子路径先到：`a/b.json/c.csv` 命中已发布文件 `a/b.json`。
  const descendant = findSharedAssetPathConflict("a/b.json/c.csv", ["a/b.json", "other/x.csv"]);
  assert.deepEqual(descendant, { key: "a/b.json", direction: "ancestor" });
  assert.match(sharedAssetPathConflictMessage("a/b.json/c.csv", descendant!), /shared_asset_path_conflict/);
  assert.match(sharedAssetPathConflictMessage("a/b.json/c.csv", descendant!), /a\/b\.json/);

  // 文件后到：新键 `a/b.json` 会成为既有 `a/b.json/c.csv` 的目录。
  const ancestor = findSharedAssetPathConflict("a/b.json", ["a/b.json/c.csv"]);
  assert.deepEqual(ancestor, { key: "a/b.json/c.csv", direction: "descendant" });
  assert.match(sharedAssetPathConflictMessage("a/b.json", ancestor!), /a\/b\.json\/c\.csv/);

  // 同键（版本追加场景）、仅仅共享字符串前缀、以及不同命名空间的同名前缀都不算冲突。
  assert.equal(findSharedAssetPathConflict("a/b.json", ["a/b.json"]), null);
  assert.equal(findSharedAssetPathConflict("a/b.json", ["a/b.json2", "a/b.json.bak"]), null);
  assert.equal(findSharedAssetPathConflict("project/a/b.json", ["finding/x/a/b.json"]), null);
  assert.equal(findSharedAssetPathConflict("a", ["b/c"]), null);
});

test("Agent publish schema is strict and cannot publish platform-owned runtime files", () => {
  assert.equal(PublishSharedAssetPayload.parse({ scope: "project", source_path: "/workspace/dist/app.jar", key: "dist/app.jar" }).scope, "project");
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "platform", source_path: "/workspace/a", key: "a" }));
  for (const source_path of [
    "/workspace/.deepsonar/runtime-manifest.json",
    "/workspace/.deepsonar-home/.claude/session.jsonl",
    "/workspace/.deepsonar/shared/project/a",
    "/workspace/.claude/settings.json",
    "/workspace/.codex/config.toml",
    "/workspace/.opencode/config.json",
  ]) {
    assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path, key: "a" }));
  }
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path: "/etc/passwd", key: "a" }));
  assert.throws(() => PublishSharedAssetPayload.parse({ scope: "project", source_path: "/workspace/a", key: "a", extra: true }));
});

test("shared asset content_type is format-agnostic and only normalizes the MIME token", () => {
  assert.equal(validateAssetContentType("application/x-sh", "scripts/run.sh"), "application/x-sh");
  assert.equal(validateAssetContentType("text/x-shellscript", "scripts/run.sh"), "text/x-shellscript");
  assert.equal(validateAssetContentType("text/x-python; charset=utf-8", "poc/reproduce.py"), "text/x-python");
  assert.equal(validateAssetContentType("text/x-c++", "poc/harness.cpp"), "text/x-c++");
  assert.equal(validateAssetContentType("application/octet-stream", "payload.exe"), "application/octet-stream");
  assert.equal(validateAssetContentType("application/zip", "payload.txt"), "application/zip");
  assert.equal(validateAssetContentType("application/vnd.android.package-archive", "app.apk"), "application/vnd.android.package-archive");
  assert.equal(validateAssetContentType("", "no-type.bin"), "application/octet-stream");
  assert.throws(() => validateAssetContentType("not a mime", "a.bin"), /invalid_asset_content_type/);
  assert.throws(() => validateAssetContentType("text/plain\n", "a.txt"), /invalid_asset_content_type/);
});

test("shared asset catalog queries are explicitly paginated", () => {
  assert.deepEqual(ListSharedAssetsPayload.parse({ limit: 25, offset: 50 }), { limit: 25, offset: 50 });
  assert.throws(() => ListSharedAssetsPayload.parse({ limit: 101 }));
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
