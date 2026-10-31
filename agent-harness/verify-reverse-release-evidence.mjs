import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ARCHES = ["amd64", "arm64"];
const CHECKS = ["native_architecture", "toolchain", "reproducible_samples", "commands", "cancellation", "memory", "compressed_image_size", "container_cleanup"];
export function verifyReverseReleaseEvidence({ sourceRevision, repository, builds, measurements, jobReports }) {
  assert.match(sourceRevision, /^[0-9a-f]{40}$/, "expected immutable source revision");
  assert.equal(builds.length, 2, "both reverse native build records are required");
  assert.equal(measurements.length, 2, "both reverse measurement records are required");
  assert.equal(jobReports.length, 2, "both real Job acceptance records are required");
  const result = [];
  for (const arch of ARCHES) {
    const matchingBuilds = builds.filter((build) => build.image_key === "deepsonar-reverse" && build.platform === `linux/${arch}`);
    assert.equal(matchingBuilds.length, 1, `one ${arch} tested child required`);
    const build = matchingBuilds[0];
    assert.match(build.digest, /^sha256:[0-9a-f]{64}$/);
    const matching = measurements.filter((value) => value.platform === `linux/${arch}`);
    assert.equal(matching.length, 1, `one ${arch} measurement required`);
    const value = matching[0];
    assert.equal(value.schema, "deepsonar.reverse.native-measurements/v1");
    assert.equal(value.passed, true); assert.equal(value.status, "passed");
    assert.equal(value.arch, arch); assert.equal(value.native_execution, true);
    assert.equal(value.source_revision, sourceRevision, "measurement source revision mismatch");
    assert.equal(value.source_dirty, false, "release measurement source checkout must be clean");
    assert.equal(value.image_ref, `${repository}@${build.digest}`, "measurement must run exact published immutable child");
    assert.equal(value.image_digest, build.digest);
    assert.match(value.image_id, /^sha256:[0-9a-f]{64}$/);
    for (const key of CHECKS) assert.equal(value.checks?.[key], true, `${arch}: missing ${key} evidence`);
    assert(value.image_size?.gzip_bytes > 0 && value.image_size.gzip_bytes <= 2800 * 1024 * 1024);
    assert.equal(value.image_size.passed, true);
    const jobs = jobReports.filter((report) => report.image?.architecture === arch);
    assert.equal(jobs.length, 1, `one ${arch} real Job report required`);
    const job = jobs[0];
    assert.equal(job.schema, "deepsonar.rea-job-acceptance/v1");
    assert.equal(job.status, "passed"); assert.equal(job.source_revision, sourceRevision);
    assert.equal(job.runtime, "production-dispatcher-opensandbox");
    assert.equal(job.image.requested, value.image_ref, "real Job must use the same tested immutable child");
    assert.equal(job.image.identity_kind, "published-manifest");
    assert.equal(job.image.inspected_id, value.image_id);
    for (const [mode, status] of Object.entries({ success: "succeeded", verify: "succeeded", failure: "failed", cancel: "cancelled", timeout: "timeout" })) {
      const records = job.jobs.filter((entry) => entry.mode === mode);
      assert.equal(records.length, 1, `${arch}: missing/duplicate ${mode} Job`);
      assert.equal(records[0].status, status); assert.equal(records[0].resources_remaining, 0);
      assert(records[0].attempts.some((attempt) => attempt.sandbox_id && attempt.status !== "active"));
    }
    assert.equal(job.verify?.proposed_verdict, "confirmed");
    assert.equal(job.verify?.final_outcome, "rework", "maker observation must not confirm itself");
    result.push({ platform: build.platform, source_digest: build.digest, image_id: value.image_id,
      gzip_bytes: value.image_size.gzip_bytes, source_revision: sourceRevision,
      job_modes: job.jobs.map((entry) => entry.mode), independent_verify: "rework" });
  }
  return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sourceRevision, repository, buildDir, evidenceDir, output] = process.argv.slice(2);
  assert(sourceRevision && repository && buildDir && evidenceDir && output, "usage: REVISION REPOSITORY BUILD_DIR EVIDENCE_DIR OUTPUT");
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const platforms = verifyReverseReleaseEvidence({ sourceRevision, repository,
    builds: ARCHES.map((arch) => read(join(buildDir, `reverse-${arch}.json`))),
    measurements: ARCHES.map((arch) => read(join(evidenceDir, `reverse-native-evidence-${arch}`, "measurements.json"))),
    jobReports: ARCHES.map((arch) => read(join(evidenceDir, `reverse-job-evidence-${arch}`, "job-acceptance.json"))),
  });
  writeFileSync(output, `${JSON.stringify({ schema: "deepsonar.reverse.release-evidence/v1", source_revision: sourceRevision, platforms }, null, 2)}\n`);
  console.log("Reverse release measurements match both native-tested immutable source digests");
}
