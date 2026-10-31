import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFIER_MODES,
  CLASSIFIER_STATUSES,
  classifyPullRequest,
  classifyRecords,
  isDocsOnlyPath,
  parseGitNameStatusZ,
} from "./classify-ci-changes.mjs";

const pr = { eventName: "pull_request", base: "base-sha", head: "head-sha" };
const record = (status, ...paths) => ({ status, paths });

test("parses Git's NUL-delimited names with Unicode and spaces intact", () => {
  const raw = Buffer.from([
    "M", "docs/README.md", "M", "docs/说明 文档.md",
  ].join("\0") + "\0", "utf8");
  assert.deepEqual(parseGitNameStatusZ(raw), [
    record("M", "docs/README.md"),
    record("M", "docs/说明 文档.md"),
  ]);
});

test("recognizes a rename record and never treats either side as docs-only", () => {
  const raw = Buffer.from(["R100", "docs/README.md", "docs/README-renamed.md"].join("\0") + "\0", "utf8");
  const parsed = parseGitNameStatusZ(raw);
  assert.deepEqual(parsed, [record("R100", "docs/README.md", "docs/README-renamed.md")]);
  assert.equal(classifyRecords(parsed, pr).mode, CLASSIFIER_MODES.FULL);
  assert.equal(classifyRecords(parsed, pr).reason, "rename");
});

test("only the explicit plain-text allowlist can produce docs-only", () => {
  assert.equal(isDocsOnlyPath("README.md"), true);
  assert.equal(isDocsOnlyPath("docs/architecture/01-system-specification.md"), true);
  assert.equal(isDocsOnlyPath("docs/skills/example.md"), false);
  assert.equal(isDocsOnlyPath("notes.md"), false);
  assert.equal(isDocsOnlyPath("docs/说明 文档.md"), false);
  assert.equal(isDocsOnlyPath("apps/scheduler/src/index.ts"), false);
});

test("classifies safe docs, mixed changes, deletes, and runtime-like paths conservatively", () => {
  assert.deepEqual(classifyRecords([record("M", "docs/README.md")], pr), {
    mode: CLASSIFIER_MODES.DOCS_ONLY,
    status: CLASSIFIER_STATUSES.OK,
    reason: "all_paths_allowlisted",
    changedCount: 1,
  });
  for (const records of [
    [record("M", "docs/README.md"), record("M", "apps/web/src/App.tsx")],
    [record("D", "docs/README.md")],
    [record("M", "docs/skills/runtime-prompt.md")],
    [record("M", "config/ci.md")],
    [record("M", "prompts/release.md")],
    [record("M", "docs/说明 文档.md")],
    [record("M", "docs\\README.md")],
    [record("M", "docs/README.md ")],
    [record("M123", "docs/README.md")],
  ]) {
    assert.equal(classifyRecords(records, pr).mode, CLASSIFIER_MODES.FULL);
  }
});

test("non-PR events, missing revisions, and failed Git reads fail closed", () => {
  const missingEvent = classifyPullRequest({ ...pr, eventName: undefined });
  assert.equal(missingEvent.status, CLASSIFIER_STATUSES.FAILED);
  assert.equal(missingEvent.reason, "missing_event_name");
  assert.equal(classifyPullRequest({ eventName: "workflow_dispatch" }).mode, CLASSIFIER_MODES.FULL);
  assert.equal(classifyPullRequest({ eventName: "workflow_dispatch" }).status, CLASSIFIER_STATUSES.OK);
  const missing = classifyPullRequest({ eventName: "pull_request", base: "", head: "head" });
  assert.deepEqual(missing, {
    mode: CLASSIFIER_MODES.FULL,
    status: CLASSIFIER_STATUSES.FAILED,
    reason: "missing_pull_request_revision",
    changedCount: 0,
  });
  const failed = classifyPullRequest({ ...pr, cwd: "definitely-not-a-repository" });
  assert.equal(failed.mode, CLASSIFIER_MODES.FULL);
  assert.equal(failed.status, CLASSIFIER_STATUSES.FAILED);
});

test("malformed NUL records are rejected instead of being interpreted as a safe path", () => {
  assert.throws(() => parseGitNameStatusZ(Buffer.from("M\0", "utf8")), /malformed git diff path record/);
  assert.throws(() => parseGitNameStatusZ(Buffer.from("M\0docs/README.md", "utf8")), /unterminated/);
  assert.throws(() => parseGitNameStatusZ(Buffer.from("M123\0docs/README.md\0", "utf8")), /malformed git diff status/);
  assert.equal(classifyRecords(null, pr).status, CLASSIFIER_STATUSES.FAILED);
});
