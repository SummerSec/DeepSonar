import assert from "node:assert/strict";
import test from "node:test";
import type { FindingSummary } from "./api";
import {
  composeRetryErrorMessage,
  composeSeedTaskUrl,
  filterComposeSeedCandidates,
  isComposeSeedCandidate,
  MAX_COMPOSE_SEEDS,
  parseComposeSeedQuery,
} from "./composeTaskModel";

function finding(overrides: Partial<FindingSummary> = {}): FindingSummary {
  return {
    id: "finding-1",
    project_id: "project-1",
    job_id: "job-1",
    node_id: "node-1",
    fingerprint: "fp-1",
    title: "Writable cache primitive",
    severity: "high",
    profile: "security.vulnerability",
    category: "injection",
    tags_json: ["chain", "auth"],
    evidence_refs_json: [],
    scoring_json: {},
    location: "src/cache.ts:10",
    summary: "Can be combined with an auth bypass",
    verify_status: "confirmed",
    disposition: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    canvas_id: "canvas-1",
    canvas_title: "Origin audit",
    ...overrides,
  };
}

test("compose candidate eligibility is confirmed plus an allowed disposition", () => {
  assert.equal(isComposeSeedCandidate(finding()), true);
  assert.equal(isComposeSeedCandidate(finding({ disposition: "accepted" })), true);
  assert.equal(isComposeSeedCandidate(finding({ disposition: "confirmed_vuln" })), true);
  assert.equal(isComposeSeedCandidate(finding({ verify_status: "pending" })), false);
  assert.equal(isComposeSeedCandidate(finding({ disposition: "rejected_fp" })), false);
  assert.equal(isComposeSeedCandidate(finding({ disposition: "resolved" })), false);
  assert.equal(isComposeSeedCandidate(finding({ disposition: "archived" })), false);
});

test("compose candidate filters cover every severity, disposition, profile, origin task, and free text", () => {
  const rows = [
    finding(),
    finding({ id: "finding-2", severity: "medium", profile: "quality.bug", disposition: "accepted", canvas_id: "canvas-2", canvas_title: "Parser audit", summary: "Parser quality issue", tags_json: ["parser"] }),
    finding({ id: "finding-3", title: "Low impact information leak", severity: "low", disposition: "confirmed_vuln", canvas_id: "canvas-3", canvas_title: "Metadata audit", summary: "Limited metadata exposure", tags_json: ["metadata"] }),
    finding({ id: "finding-4", disposition: "rejected_fp" }),
  ];
  assert.deepEqual(filterComposeSeedCandidates(rows, { severity: "high" }).map((row) => row.id), ["finding-1"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { severity: "medium" }).map((row) => row.id), ["finding-2"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { severity: "low" }).map((row) => row.id), ["finding-3"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { disposition: "accepted" }).map((row) => row.id), ["finding-2"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { profile: "quality.bug" }).map((row) => row.id), ["finding-2"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { canvasId: "canvas-1" }).map((row) => row.id), ["finding-1"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { search: "AUTH" }).map((row) => row.id), ["finding-1"]);
  assert.deepEqual(filterComposeSeedCandidates(rows, { search: "origin audit" }).map((row) => row.id), ["finding-1"]);
});

test("compose retry errors turn stale seeds into an actionable next step", () => {
  assert.equal(
    composeRetryErrorMessage(new Error("POST /tasks/id/retry -> 409: 种子必须全部属于当前项目，且当前为 confirmed")),
    "冻结种子当前已不可用。请回到 Findings 重新选择可代入项并新建组合任务。",
  );
  assert.equal(composeRetryErrorMessage(new Error("network down")), "重试失败：network down");
});

test("compose task query always carries a concrete unique bounded ID list", () => {
  const ids = Array.from({ length: MAX_COMPOSE_SEEDS + 3 }, (_, index) => `finding-${index}`);
  assert.deepEqual(parseComposeSeedQuery([ids[0], ids[0], ...ids.slice(1)].join(",")), ids.slice(0, MAX_COMPOSE_SEEDS));
  assert.equal(
    composeSeedTaskUrl("project-1", ["finding-1", "finding-1", "finding-2"]),
    "/projects/project-1/tasks?compose=finding-1,finding-2",
  );
});
