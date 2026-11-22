import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFIER_MODES,
  CLASSIFIER_STATUSES,
  classifyPullRequest,
  classifyRecords,
  isDocsOnlyPath,
  parseGitNameStatusZ,
  parseGitDiffRecords,
  parseGitRawZ,
} from "./classify-ci-changes.mjs";

const pr = { eventName: "pull_request", base: "base-sha", head: "head-sha" };
// #1221 review：文档放行要求真实普通文件模式；默认给夹具 100644，模式相关用例单独构造。
const record = (status, ...paths) => ({ status, paths, oldMode: "100644", newMode: "100644" });
const nameStatusRecord = (status, ...paths) => ({ status, paths });

test("parses Git's NUL-delimited names with Unicode and spaces intact", () => {
  const raw = Buffer.from([
    "M", "docs/README.md", "M", "docs/说明 文档.md",
  ].join("\0") + "\0", "utf8");
  assert.deepEqual(parseGitNameStatusZ(raw), [
    nameStatusRecord("M", "docs/README.md"),
    nameStatusRecord("M", "docs/说明 文档.md"),
  ]);
});

test("recognizes a rename record and never treats either side as docs-only", () => {
  const raw = Buffer.from(["R100", "docs/README.md", "docs/README-renamed.md"].join("\0") + "\0", "utf8");
  const parsed = parseGitNameStatusZ(raw);
  assert.deepEqual(parsed, [nameStatusRecord("R100", "docs/README.md", "docs/README-renamed.md")]);
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

test("#992 the exact #994 two-document shape is safe, not a Markdown directory exemption", () => {
  const documents = [record("M", "CHANGELOG.md"), record("M", "docs/PI_RPC_PAYLOAD_LIMITS.md")];
  assert.deepEqual(classifyRecords(documents, pr), {
    mode: CLASSIFIER_MODES.DOCS_ONLY, status: CLASSIFIER_STATUSES.OK,
    reason: "all_paths_allowlisted", changedCount: 2,
  });
  for (const path of [
    "docs/PI_RPC_PAYLOAD_LIMITS.md.bak", "docs/PI_RPC_PAYLOAD_LIMITS_UNKNOWN.md",
    "docs/runtime/prompt.md", "skills/audit/SKILL.md", "deploy/Dockerfile.agent",
    "packages/runtime-sandbox/src/runtime-agent.ts", ".github/workflows/ci.yml",
  ]) {
    assert.equal(classifyRecords([...documents, record("M", path)], pr).mode, CLASSIFIER_MODES.FULL, path);
  }
  for (const status of ["D", "R100", "C100", "T"]) {
    const paths = /^[RC]/u.test(status)
      ? ["docs/PI_RPC_PAYLOAD_LIMITS.md", "docs/README.md"] : ["docs/PI_RPC_PAYLOAD_LIMITS.md"];
    assert.equal(classifyRecords([record(status, ...paths)], pr).mode, CLASSIFIER_MODES.FULL, status);
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

test("#1221 root DESIGN.md and plain plan documents are safe docs, not a directory exemption", () => {
  assert.equal(isDocsOnlyPath("DESIGN.md"), true);
  assert.equal(isDocsOnlyPath("docs/superpowers/plans/2026-11-22-project-knowledge-library.md"), true);
  for (const path of [
    "docs/superpowers/plans/notes.txt",
    "docs/superpowers/plans/sub/dir.md",
    "docs/superpowers/plans/.hidden.md",
    "docs/superpowers/plans/plan.md.bak",
    "docs/superpowers/plans/说明.md",
    "docs/superpowers/specs/new-spec.md",
    "docs/superpowers/plans",
  ]) {
    assert.equal(isDocsOnlyPath(path), false, path);
  }
  // 新增与修改都是安全的说明性改动；删除/重命名/复制/类型变更在更早的分支就 fail closed。
  assert.deepEqual(classifyRecords([
    record("M", "DESIGN.md"),
    record("A", "docs/superpowers/plans/2026-12-01-new-design.md"),
  ], pr), {
    mode: CLASSIFIER_MODES.DOCS_ONLY, status: CLASSIFIER_STATUSES.OK,
    reason: "all_paths_allowlisted", changedCount: 2,
  });
  for (const records of [
    [record("M", "DESIGN.md"), record("M", "apps/web/src/App.tsx")],
    [record("A", "docs/superpowers/plans/2026-12-01-new-design.md"), record("M", "skills/audit/SKILL.md")],
    [record("D", "docs/superpowers/plans/2026-12-01-new-design.md")],
    [record("M", "docs/superpowers/plans/notes.txt")],
  ]) {
    assert.equal(classifyRecords(records, pr).mode, CLASSIFIER_MODES.FULL);
  }
  for (const status of ["D", "R100", "C100", "T"]) {
    const paths = /^[RC]/u.test(status)
      ? ["docs/superpowers/plans/2026-12-01-new-design.md", "docs/superpowers/plans/other.md"]
      : ["docs/superpowers/plans/2026-12-01-new-design.md"];
    assert.equal(classifyRecords([record(status, ...paths)], pr).mode, CLASSIFIER_MODES.FULL, status);
  }
});

test("#1221 raw diff parsing keeps blob modes so docs-only cannot ride a symlink", () => {
  const raw = Buffer.from([
    ":100644 100644 " + "a".repeat(40) + " " + "b".repeat(40) + " M", "DESIGN.md",
    ":000000 120000 " + "0".repeat(7) + " " + "c".repeat(40) + " A", "docs/superpowers/plans/link.md",
    ":120000 100644 " + "d".repeat(40) + " " + "e".repeat(40) + " T", "docs/superpowers/plans/swap.md",
  ].join("\0") + "\0", "utf8");
  const parsed = parseGitRawZ(raw);
  assert.deepEqual(parsed.map((entry) => [entry.status, entry.paths[0], entry.oldMode, entry.newMode]), [
    ["M", "DESIGN.md", "100644", "100644"],
    ["A", "docs/superpowers/plans/link.md", "000000", "120000"],
    ["T", "docs/superpowers/plans/swap.md", "120000", "100644"],
  ]);
  assert.throws(() => parseGitRawZ(Buffer.from(":100644 100644 a b M\0DESIGN.md", "utf8")), /unterminated/);
  // 同一份字节既能被自动识别成 raw，也不影响旧的 name-status 解析。
  assert.equal(parseGitDiffRecords(raw).length, 3);
  assert.deepEqual(parseGitDiffRecords(Buffer.from("M\0docs/README.md\0", "utf8")), [nameStatusRecord("M", "docs/README.md")]);
});

test("#1221 missing or non-regular blob modes fail closed instead of trusting the name", () => {
  const prEvent = { eventName: "pull_request", base: "a", head: "b" };
  const noModes = { status: "M", paths: ["DESIGN.md"] };
  assert.equal(classifyRecords([noModes], prEvent).mode, CLASSIFIER_MODES.FULL);
  assert.equal(classifyRecords([noModes], prEvent).reason, "unsafe_file_mode");
  for (const record of [
    { status: "A", paths: ["docs/superpowers/plans/new.md"], oldMode: "000000", newMode: "120000" },
    { status: "M", paths: ["DESIGN.md"], oldMode: "120000", newMode: "100644" },
    { status: "M", paths: ["DESIGN.md"], oldMode: "100644", newMode: "100755" },
    { status: "A", paths: ["docs/superpowers/plans/new.md"], oldMode: "000000", newMode: "160000" },
  ]) {
    assert.equal(classifyRecords([record], prEvent).mode, CLASSIFIER_MODES.FULL, JSON.stringify(record));
    assert.equal(classifyRecords([record], prEvent).reason, "unsafe_file_mode");
  }
  // 普通文件模式（新增为 000000）仍然放行。
  assert.equal(classifyRecords([
    { status: "A", paths: ["docs/superpowers/plans/new.md"], oldMode: "000000", newMode: "100644" },
  ], prEvent).mode, CLASSIFIER_MODES.DOCS_ONLY);
});
