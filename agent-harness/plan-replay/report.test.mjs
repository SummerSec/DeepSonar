import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildReplayReport } from "./report.mjs";

const bytes = readFileSync(new URL("./baseline-v2.json", import.meta.url), "utf8");
const baseline = JSON.parse(bytes);
const provenance = {
  commit: baseline.baseline_commit,
  exit_code: 0,
  fixture_completed: true,
  real_sql_http: true,
  database_isolated: true,
};
const positiveIds = {
  job_id: "00000000-0000-4000-8000-000000000001",
  attempt_id: "00000000-0000-4000-8000-000000000002",
  artifact_id: "00000000-0000-4000-8000-000000000003",
  event_id: "00000000-0000-4000-8000-000000000004",
};
const positiveUri = `attempts/${positiveIds.attempt_id}/execution.txt`;
const positiveBytes = Buffer.from("Offline fixture retained execution evidence");
const positiveSha256 = createHash("sha256").update(positiveBytes).digest("hex");
const positiveManifest = Buffer.from(JSON.stringify({
  job_id: positiveIds.job_id,
  finalized_at: "2026-01-01T00:00:00.000Z",
  files: [{ path: positiveUri, bytes: positiveBytes.length, sha256: positiveSha256 }],
}));
const rows = [
  ...baseline.cases.map((item, index) => ({
    mode: "control_http",
    id: item.id,
    observed: structuredClone(item.expected),
    trace: index === 0 ? {
      job_id: positiveIds.job_id,
      job_status: "succeeded",
      attempt_id: positiveIds.attempt_id,
      attempt_status: "succeeded",
      event_count: 3,
      artifact_id: positiveIds.artifact_id,
      event_id: positiveIds.event_id,
      evidence: {
        uri: positiveUri,
        attempt_id: positiveIds.attempt_id,
        path_attempt_id: positiveIds.attempt_id,
        bytes: positiveBytes.length,
        sha256: positiveSha256,
        bytes_base64: positiveBytes.toString("base64"),
        manifest_bytes: positiveBytes.length,
        manifest_sha256: positiveSha256,
        manifest_finalized_at: "2026-01-01T00:00:00.000Z",
        manifest_raw_bytes_base64: positiveManifest.toString("base64"),
        manifest_raw_sha256: createHash("sha256").update(positiveManifest).digest("hex"),
        artifact_id: positiveIds.artifact_id,
        source_event_id: positiveIds.event_id,
        source_event_attempt_id: positiveIds.attempt_id,
        source_operation: "emit_fact",
      },
    } : { job_id: `job-${index}` },
  })),
  { kind: "meta", schema: "deepsonar.plan-offline-observations/v2", fixture_completed: true, real_sql_http: true, database_isolated: true, case_count: baseline.cases.length },
];

test("v2 baseline is independent, pinned and has the full denominator", () => {
  assert.equal(baseline.schema, "deepsonar.plan-offline-baseline/v2");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "a273a930b1cdfa16444787c639e7a8c11b99ad2995cd56afce9b3295a128bb6b");
  assert.equal(baseline.cases.length, 17);
  const report = buildReplayReport(bytes, rows, provenance);
  assert.equal(report.passed, true);
  assert.deepEqual(report.denominator, { expected: 17, observed: 17, matched: 17, missing: 0 });
  assert.equal(report.control_observations.execution_output_association.retained_attempt_trace, 1);
  assert.equal(report.control_observations.execution_output_association.retained_evidence_trace, 1);
  assert.equal(report.control_observations.operator_authorized_completion.positively_authorized, 1);
});

test("missing, duplicate, unexpected and failed prerequisites cannot pass", () => {
  for (const observations of [
    [],
    rows.slice(1),
    [...rows, rows[0]],
    [...rows, { mode: "control_http", id: "invented", observed: {}, trace: {} }],
  ]) {
    const report = buildReplayReport(bytes, observations, provenance);
    assert.equal(report.passed, false);
  }
  assert.equal(buildReplayReport(bytes, rows, { ...provenance, exit_code: 1 }).prerequisite_failure, true);
});

test("actual differences remain attached to their SQL/HTTP/evidence trace", () => {
  const changed = structuredClone(rows);
  const tamperedBytes = Buffer.from("tampered fixture bytes");
  const tamperedSha256 = createHash("sha256").update(tamperedBytes).digest("hex");
  const tamperedManifest = Buffer.from(JSON.stringify({
    job_id: positiveIds.job_id,
    finalized_at: "2026-01-01T00:00:00.000Z",
    files: [{ path: positiveUri, bytes: tamperedBytes.length, sha256: tamperedSha256 }],
  }));
  changed[0].observed.evidence_bytes = tamperedBytes.length;
  changed[0].observed.evidence_sha256 = tamperedSha256;
  Object.assign(changed[0].trace.evidence, {
    bytes: tamperedBytes.length,
    sha256: tamperedSha256,
    bytes_base64: tamperedBytes.toString("base64"),
    manifest_bytes: tamperedBytes.length,
    manifest_sha256: tamperedSha256,
    manifest_raw_bytes_base64: tamperedManifest.toString("base64"),
    manifest_raw_sha256: createHash("sha256").update(tamperedManifest).digest("hex"),
  });
  const report = buildReplayReport(bytes, changed, provenance);
  assert.equal(report.passed, false);
  assert.equal(report.denominator.matched, 16);
  assert.equal(report.cases[0].status, "different");
  assert.equal(report.cases[0].trace.evidence.bytes, tamperedBytes.length);
});

test("parser-only synthetic fault validator stays labeled and fails the gate", () => {
  // This is a report-parser unit check only.  It does not stand in for the
  // real negative.mjs matrix, which must capture an actual faulted fixture.
  const faultRows = structuredClone(rows);
  faultRows[2].trace.fault_injection = { name: "scope_cross_project_accepted", actual_path: "test_fixture_handler_or_blob_or_sql" };
  faultRows[2].observed.http_status = 200;
  faultRows[2].observed.error_code = null;
  const report = buildReplayReport(bytes, faultRows, { ...provenance, fault: "scope_cross_project_accepted" });
  assert.equal(report.passed, false);
  assert.equal(report.ordinary_pass, false);
  assert.equal(report.fault_checks.length, 1);
  assert.equal(report.fault_checks[0].status, "different");
  assert.equal(report.fault_checks[0].observed.http_status, 200);
});

test("parser-only synthetic trace loss/inconsistency fails despite matching observations", () => {
  const variants = [
    {
      name: "missing captured evidence bytes",
      reason: "positive_trace:evidence_bytes_not_decodable",
      mutate: (variant) => { delete variant[0].trace.evidence.bytes_base64; },
    },
    {
      name: "evidence Attempt/path mismatch",
      reason: "positive_trace:evidence_attempt_mismatch",
      mutate: (variant) => {
        variant[0].trace.evidence.attempt_id = "00000000-0000-4000-8000-000000000099";
        variant[0].trace.evidence.path_attempt_id = "00000000-0000-4000-8000-000000000099";
      },
    },
    {
      name: "captured bytes and manifest SHA inconsistency",
      reason: "positive_trace:evidence_sha_mismatch",
      mutate: (variant) => {
        variant[0].trace.evidence.bytes_base64 = Buffer.alloc(variant[0].trace.evidence.bytes, 0x78).toString("base64");
        variant[0].trace.evidence.manifest_sha256 = "0".repeat(64);
      },
    },
  ];
  for (const variant of variants) {
    const observations = structuredClone(rows);
    variant.mutate(observations);
    const report = buildReplayReport(bytes, observations, provenance);
    assert.equal(report.passed, false, variant.name);
    assert.deepEqual(report.denominator, { expected: 17, observed: 17, matched: 17, missing: 0 }, variant.name);
    assert.equal(report.cases[0].status, "match", variant.name);
    assert.equal(report.trace_integrity.positive_output_association.ok, false, variant.name);
    assert.ok(report.invalid.includes(variant.reason), `${variant.name}: missing ${variant.reason}`);
  }
});

test("v1 baseline cannot be accidentally used for the current-v2 gate", () => {
  const historical = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  assert.throws(() => buildReplayReport(JSON.stringify(historical), [], provenance), /Invalid frozen v2 baseline/);
});

test("malformed v2 baselines and duplicate identities fail before reporting", () => {
  for (const value of [
    { ...baseline, cases: [] },
    { ...baseline, cases: [...baseline.cases, baseline.cases[0]] },
    { ...baseline, modes: ["control_http", "control_http"] },
    { ...baseline, modes: ["inline"] },
  ]) {
    assert.throws(() => buildReplayReport(JSON.stringify(value), rows, provenance), /Invalid frozen v2 baseline/);
  }
});

test("a failed rerun removes a stale green artifact before prerequisite checks", async () => {
  const { access, copyFile, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "plan-runner-v2-failure-"));
  try {
    const scripts = join(root, "agent-harness", "plan-replay");
    const artifact = join(root, "artifacts", "plan-replay", "report.json");
    await mkdir(scripts, { recursive: true });
    await mkdir(join(root, "artifacts", "plan-replay"), { recursive: true });
    for (const file of ["run.mjs", "report.mjs", "baseline-v2.json"]) {
      await copyFile(new URL(`./${file}`, import.meta.url), join(scripts, file));
    }
    await writeFile(artifact, JSON.stringify({ passed: true }));
    const env = { ...process.env };
    delete env.TEST_DATABASE_URL;
    delete env.PLAN_REPLAY_FAULT;
    const result = spawnSync(process.execPath, [join(scripts, "run.mjs")], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /TEST_DATABASE_URL is required/);
    await assert.rejects(access(artifact), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
