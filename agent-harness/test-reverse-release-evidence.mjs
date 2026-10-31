import assert from "node:assert/strict";
import test from "node:test";
import { verifyReverseReleaseEvidence } from "./verify-reverse-release-evidence.mjs";
function fixture() {
  const sourceRevision = "c".repeat(40), repository = "ghcr.io/example/deepsonar-reverse";
  const builds = ["amd64", "arm64"].map((arch, i) => ({ image_key: "deepsonar-reverse", platform: `linux/${arch}`, digest: `sha256:${String(i + 1).repeat(64)}` }));
  const measurements = builds.map((build) => ({ schema: "deepsonar.reverse.native-measurements/v1", passed: true, status: "passed", platform: build.platform,
    arch: build.platform.split("/")[1], native_execution: true, source_revision: sourceRevision, source_dirty: false, image_ref: `${repository}@${build.digest}`, image_digest: build.digest,
    image_id: `sha256:${"f".repeat(64)}`, image_size: { gzip_bytes: 100, passed: true }, checks: Object.fromEntries([
      "native_architecture", "toolchain", "reproducible_samples", "commands", "cancellation", "memory", "compressed_image_size", "container_cleanup"].map((key) => [key, true])),
  }));
  const jobReports = measurements.map((value) => ({ schema: "deepsonar.rea-job-acceptance/v1", status: "passed", source_revision: sourceRevision,
    runtime: "production-dispatcher-opensandbox", image: { requested: value.image_ref, architecture: value.arch, inspected_id: value.image_id, identity_kind: "published-manifest" },
    jobs: Object.entries({ success: "succeeded", verify: "succeeded", failure: "failed", cancel: "cancelled", timeout: "timeout" }).map(([mode, status]) => ({ mode, status, resources_remaining: 0, attempts: [{ sandbox_id: "fixture-sandbox", status: "completed" }] })),
    verify: { proposed_verdict: "confirmed", final_outcome: "rework" },
  }));
  return { sourceRevision, repository, builds, measurements, jobReports };
}
test("release native evidence binds both measured immutable children", () => {
  assert.equal(verifyReverseReleaseEvidence(fixture()).length, 2);
});
for (const [name, mutate] of [
  ["missing real Job", (f) => f.jobReports.pop()],
  ["different real Job image", (f) => { f.jobReports[0].image.requested = "not-the-tested-image"; }],
  ["local-only Job", (f) => { f.jobReports[0].image.identity_kind = "local-config-id"; }],
  ["missing cancelled Job", (f) => { f.jobReports[0].jobs = f.jobReports[0].jobs.filter((entry) => entry.mode !== "cancel"); }],
  ["residual sandbox", (f) => { f.jobReports[0].jobs[0].resources_remaining = 1; }],
  ["self-confirmed observation", (f) => { f.jobReports[0].verify.final_outcome = "confirmed"; }],
  ["missing architecture", (f) => f.measurements.pop()],
  ["duplicate architecture", (f) => { f.measurements[1] = f.measurements[0]; }],
  ["dirty release source", (f) => { f.measurements[0].source_dirty = true; }],
  ["different source revision", (f) => { f.measurements[0].source_revision = "d".repeat(40); }],
  ["local image only", (f) => { f.measurements[0].image_ref = "deepsonar-reverse:native-ci"; }],
  ["different digest", (f) => { f.measurements[0].image_digest = `sha256:${"e".repeat(64)}`; }],
  ["failed command", (f) => { f.measurements[0].checks.commands = false; }],
  ["no cancellation evidence", (f) => { delete f.measurements[0].checks.cancellation; }],
  ["unmeasured compressed size", (f) => { f.measurements[0].image_size.gzip_bytes = null; }],
  ["over budget", (f) => { f.measurements[0].image_size.gzip_bytes = 2801 * 1024 * 1024; }],
]) test(`release rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => verifyReverseReleaseEvidence(f)); });
