import assert from "node:assert/strict";
import test from "node:test";
import { platformUpdatePrompt, type PlatformUpdateStatus } from "./platform-updates";

const base: PlatformUpdateStatus = {
  checked_at: "2026-10-15T07:00:00.000Z",
  current_version: "0.5.6",
  available_version: null,
  available_commit_sha: null,
  available_schema_version: null,
  changelog_url: null,
  update_available: false,
  schema_rebuild_needed: false,
  check_error: null,
  registry_source: "remote",
  missing: false,
};

test("no prompt when missing or no update", () => {
  assert.equal(platformUpdatePrompt(null), null);
  assert.equal(platformUpdatePrompt({ ...base, missing: true }), null);
  assert.equal(platformUpdatePrompt(base), null);
});

test("available update prompt includes schema rebuild hint", () => {
  const prompt = platformUpdatePrompt({
    ...base,
    update_available: true,
    available_version: "0.5.7",
    schema_rebuild_needed: true,
    available_schema_version: 58,
    changelog_url: "https://github.com/SummerSec/DeepSonar/releases/tag/v0.5.7",
  });
  assert.equal(prompt?.kind, "available");
  assert.match(prompt?.title ?? "", /0\.5\.7/);
  assert.match(prompt?.detail ?? "", /schema 重建/);
  assert.equal(prompt?.changelog_url?.includes("v0.5.7"), true);
});

test("check error surfaces without inventing an update", () => {
  const prompt = platformUpdatePrompt({
    ...base,
    check_error: "remote registry unavailable",
    update_available: false,
  });
  assert.equal(prompt?.kind, "error");
  assert.match(prompt?.detail ?? "", /unavailable/);
});
