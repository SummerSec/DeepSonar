import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { missingFindingJobWarning, warningsForOrphanedFindings } from "./import.js";

test("orphaned findings produce import warnings instead of staying silent", () => {
  const warnings = warningsForOrphanedFindings(
    [
      { source_id: "f-ok", source_job_id: "job-1" },
      { source_id: "f-missing", source_job_id: "job-gone" },
      { source_id: "f-empty", source_job_id: "" },
    ],
    [{ source_id: "job-1" }],
  );
  assert.deepEqual(warnings, [
    missingFindingJobWarning("f-missing", "job-gone"),
    missingFindingJobWarning("f-empty", ""),
  ]);
  assert.match(warnings[0] ?? "", /f-missing/);
  assert.match(warnings[0] ?? "", /job-gone/);
});

test("import apply records a warning when a finding has no mapped job", () => {
  const source = readFileSync(new URL("./import.ts", import.meta.url), "utf8");
  assert.match(source, /warnings\.push\(missingFindingJobWarning\(f\.source_id, f\.source_job_id\)\)/);
  assert.doesNotMatch(source, /const jobId = id_map\.jobs\[String\(f\.source_job_id\)\];\s*if \(!jobId\) continue;/);
});
