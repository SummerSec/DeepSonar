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

// #869: the banner used to claim the host upgrade was "not implemented" and told
// the operator to run a bare `deploy.sh upgrade`, which has no action and is
// rejected as INVALID_MAINTENANCE_ACTION. The guidance must track the real CLI
// and must not pin a release version in source.
test("upgrade guidance names the real host CLI instead of claiming it is unimplemented", () => {
  const prompt = platformUpdatePrompt({
    ...base,
    update_available: true,
    available_version: "0.5.7",
  });
  const detail = prompt?.detail ?? "";
  assert.doesNotMatch(detail, /尚未落地/u, "the host upgrade shipped in v0.6.0; the banner must not deny it");
  assert.doesNotMatch(detail, /#740/u, "issue references are not operator guidance");
  assert.match(detail, /upgrade check --to v0\.5\.7/u, "guidance must start from a reviewable check");
  assert.match(detail, /upgrade apply --to v0\.5\.7/u, "guidance must name the apply step");
  assert.match(detail, /--approve-plan-hash/u, "risky plans need the reviewed plan hash");
  assert.match(detail, /deploy\/README\.md/u, "the controlled-upgrade documentation must be reachable from the prompt");
  // Dynamic target: the version comes from status, never from a literal in source.
  const other = platformUpdatePrompt({ ...base, update_available: true, available_version: "1.2.3" });
  assert.match(other?.detail ?? "", /upgrade check --to v1\.2\.3/u);
  assert.doesNotMatch(other?.detail ?? "", /0\.5\.7/u);
});

test("no-update and error states carry no upgrade guidance", () => {
  assert.equal(platformUpdatePrompt(base), null);
  const error = platformUpdatePrompt({ ...base, check_error: "registry 404" });
  assert.equal(error?.kind, "error");
  assert.doesNotMatch(error?.detail ?? "", /upgrade apply/u);
});

test("schema rebuild hint survives alongside the upgrade guidance", () => {
  const prompt = platformUpdatePrompt({
    ...base,
    update_available: true,
    available_version: "0.6.6",
    schema_rebuild_needed: true,
    available_schema_version: 68,
  });
  assert.match(prompt?.detail ?? "", /schema 重建/u);
  assert.match(prompt?.detail ?? "", /upgrade apply --to v0\.6\.6/u);
});
