import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_IDENTITY_FIELDS,
  STRONG_IDENTITY_FIELDS,
  compareAuthoritativeIdentity,
  emptyIdentitySnapshot,
  identitySnapshotDigest,
  type CurrentIdentitySnapshot,
} from "./identity.js";

function snapshot(projectId: string, findingId: string, values: Partial<Record<(typeof PLATFORM_IDENTITY_FIELDS)[number], string>> = {}, authorityVersion = "authority/v1"): CurrentIdentitySnapshot {
  const result = emptyIdentitySnapshot(findingId, projectId);
  for (const field of PLATFORM_IDENTITY_FIELDS) {
    const value = values[field];
    if (!value) continue;
    result.fields[field] = {
      field,
      status: "valid",
      identity_digest: `sha256:${value.padEnd(64, "0").slice(0, 64)}`,
      authority_versions: [authorityVersion],
      mappings: [],
      invalid_mapping_count: 0,
    };
  }
  result.fingerprint = identitySnapshotDigest(result);
  return result;
}

const all = {
  asset: "asset-a",
  tenant: "tenant-a",
  environment: "prod",
  version: "release-a",
  parameter: "query-a",
  root_cause: "cause-a",
  service: "service-a",
  permission_boundary: "boundary-a",
};

test("all six trusted identities produce same_problem without lexical input", () => {
  const decision = compareAuthoritativeIdentity(snapshot("project", "left", all), snapshot("project", "right", all));
  assert.equal(decision.kind, "same_problem");
  assert.deepEqual(decision.matched_fields, PLATFORM_IDENTITY_FIELDS);
  assert.deepEqual(decision.different_fields, []);
  assert.equal(decision.root_cause_continuation, false);
});

test("same root cause with a different instance is not same_problem", () => {
  const right = { ...all, asset: "asset-b", version: "release-b" };
  const decision = compareAuthoritativeIdentity(snapshot("project", "left", all), snapshot("project", "right", right));
  assert.equal(decision.kind, "same_root_cause_different_instance");
  assert.equal(decision.root_cause_continuation, true);
  assert.deepEqual(decision.different_fields, ["asset", "version"]);
  assert.ok(!decision.different_fields.includes("root_cause"));
});

test("root-cause authority version conflict fails closed", () => {
  const decision = compareAuthoritativeIdentity(
    snapshot("project", "left", all, "root-cause/v1"),
    snapshot("project", "right", all, "root-cause/v2"),
  );
  assert.equal(decision.kind, "insufficient_information");
  assert.equal(decision.reason, "root_cause_continuity_unknown");
  assert.deepEqual(decision.conflicts, ["root_cause"]);
});

test("missing identity, conflicting context, and cross-project pairs never become strong", () => {
  const missing = { ...all, parameter: undefined };
  assert.equal(compareAuthoritativeIdentity(snapshot("project", "left", all), snapshot("project", "right", missing)).kind, "insufficient_information");
  const contextConflict = { ...all, service: "service-b" };
  assert.equal(compareAuthoritativeIdentity(snapshot("project", "left", all), snapshot("project", "right", contextConflict)).kind, "distinct");
  assert.equal(compareAuthoritativeIdentity(snapshot("project-a", "left", all), snapshot("project-b", "right", all)).reason, "project_scope_mismatch");
});

test("only the six strong fields are required for the relation decision", () => {
  const left = snapshot("project", "left", all);
  const right = snapshot("project", "right", { ...all, service: undefined, permission_boundary: undefined });
  const decision = compareAuthoritativeIdentity(left, right);
  assert.equal(decision.kind, "same_problem");
  assert.deepEqual(decision.matched_fields, STRONG_IDENTITY_FIELDS);
});
