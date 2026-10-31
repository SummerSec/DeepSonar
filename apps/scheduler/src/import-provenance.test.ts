import assert from "node:assert/strict";
import test from "node:test";
import {
  importedResumeBlockedReason,
  JOB_IMPORTED_READONLY,
  jobProvenance,
  parseImportOrigin,
} from "./import-provenance.js";
import { archiveJobStatus } from "./transfer/sanitize.js";

test("import origin marks historical readonly provenance", () => {
  assert.equal(parseImportOrigin({}), null);
  const imported = jobProvenance("failed", {
    import_origin: { source_job_id: "src-1", original_status: "failed" },
  });
  assert.deepEqual(imported, {
    source: "import",
    execution_class: "historical",
    import_origin: { source_job_id: "src-1", original_status: "failed" },
    default_readonly: true,
    resumable_status: true,
  });
  assert.equal(importedResumeBlockedReason(imported, "failed"), null);

  const native = jobProvenance("failed", {});
  assert.equal(native.source, "native");
  assert.equal(native.execution_class, "live");
  assert.equal(native.default_readonly, false);
  assert.equal(importedResumeBlockedReason(native, "failed"), null);
});

test("imported active Jobs archive to cancelled and stay resume-blocked", () => {
  const archived = archiveJobStatus("running");
  assert.deepEqual(archived, { status: "cancelled", original_status: "running" });
  const provenance = jobProvenance(archived.status, {
    import_origin: { source_job_id: "src-2", original_status: archived.original_status },
  });
  const reason = importedResumeBlockedReason(provenance, archived.status);
  assert.ok(reason);
  assert.match(reason, /只读展示/);
  assert.equal(JOB_IMPORTED_READONLY, "JOB_IMPORTED_READONLY");
});

test("imported terminal Jobs that are not resumable stay blocked", () => {
  const succeeded = jobProvenance("succeeded", {
    import_origin: { source_job_id: "src-3", original_status: "succeeded" },
  });
  assert.equal(succeeded.resumable_status, false);
  assert.match(importedResumeBlockedReason(succeeded, "succeeded") ?? "", /不允许续跑/);
});
