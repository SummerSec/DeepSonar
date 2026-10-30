import assert from "node:assert/strict";
import test from "node:test";
import { parseFeatureRebuildInput } from "./rebuild-input.js";

const projectId = "77000000-0000-0000-0000-000000000001";
const databaseUrl = "postgres://postgres@127.0.0.1:55472/deepsonar_test";

test("feature rebuild requires an explicit database and exact project UUID", () => {
  assert.deepEqual(parseFeatureRebuildInput(["--project-id", projectId], databaseUrl), { projectId, databaseUrl, mode: "rebuild" });
  assert.deepEqual(parseFeatureRebuildInput(["--", "--project-id", projectId], databaseUrl), { projectId, databaseUrl, mode: "rebuild" });
  for (const value of [undefined, "", "   "]) {
    assert.throws(() => parseFeatureRebuildInput(["--project-id", projectId], value), /DATABASE_URL_REQUIRED/);
  }
  for (const args of [[], ["--project-id"], ["--project-id", "all"], ["--project-id", projectId, "--force"], ["--project", projectId]]) {
    assert.throws(() => parseFeatureRebuildInput(args, databaseUrl), /INVALID_REBUILD_ARGUMENTS/);
  }
});

test("feature rebuild rejects invalid URL without reflecting input or defaulting database", () => {
  for (const value of ["private-invalid-value", "https://127.0.0.1/database", "postgres://127.0.0.1"]) {
    assert.throws(() => parseFeatureRebuildInput(["--project-id", projectId], value), (error: Error) => {
      assert.equal(error.message, "INVALID_DATABASE_URL");
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});


test("feature pruning is explicit, bounded by its store operation, and exclusive of rebuilding", () => {
  assert.equal(parseFeatureRebuildInput(["--project-id", projectId, "--prune-inactive"], databaseUrl).mode, "prune_inactive");
  assert.equal(parseFeatureRebuildInput(["--prune-inactive", "--project-id", projectId], databaseUrl).mode, "prune_inactive");
  for (const args of [
    ["--project-id", projectId, "--prune-inactive", "--prune-inactive"],
    ["--project-id", projectId, "--prune-inactive", "--rebuild"],
    ["--project-id", projectId, "--project-id", projectId],
    ["--prune-inactive"],
  ]) assert.throws(() => parseFeatureRebuildInput(args, databaseUrl), /INVALID_REBUILD_ARGUMENTS/);
});
