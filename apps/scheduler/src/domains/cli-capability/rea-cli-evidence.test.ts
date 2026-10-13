import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_UNAVAILABLE_CODE } from "@deepsonar/shared-types";
import { admitCliCapability } from "./admit.js";
import {
  buildReaCliCapabilityResult,
  isReaCliImageAdmitted,
  planReaCliCleanup,
  REA_CLI_CAPABILITY_ID,
} from "./rea-cli-evidence.js";

const baseObs = {
  job_id: "job_test_718",
  workspace: "/workspace",
  argv: ["rea", "function", "/workspace/sample_elf", "main", "--provider", "ghidra", "--json"],
  max_output_bytes: 1_048_576,
  evidence_ref: "/workspace/evidence/rea-function-main.json",
} as const;

test("success: valid JSON exit 0 is conclusive observation (still not a Finding)", () => {
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: 0,
    stdout: JSON.stringify({
      evidence_id: "ev_deadbeef",
      operation: "analyze_function",
      normalized_result: { procedure: { address: "0x10119e" }, pseudocode: "int main(){}" },
    }),
    stderr: "",
  });
  assert.equal(result.is_finding, false);
  assert.equal(result.inconclusive, false);
  assert.equal(result.truncated, false);
  assert.equal(result.unavailable_code, null);
  assert.equal(result.capability_id, REA_CLI_CAPABILITY_ID);
  assert.equal(result.tool_version, "6.4.0");
  assert.equal(result.exit_code, 0);
  assert.equal((result.result as { operation?: string }).operation, "analyze_function");
});

test("non-zero exit: inconclusive; never success", () => {
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: 1,
    stdout: JSON.stringify({ code: "UNKNOWN", message: "Unknown flag: --snapshot" }),
    stderr: "",
  });
  assert.equal(result.inconclusive, true);
  assert.equal(result.unavailable_code, CLI_UNAVAILABLE_CODE);
  assert.equal(result.unavailable_reason, "inconclusive");
  assert.equal(result.is_finding, false);
});

test("truncated stdout: marks truncated + inconclusive", () => {
  const huge = `{"pad":"${"x".repeat(200)}"}`;
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: 0,
    stdout: huge,
    stderr: "",
    max_output_bytes: 64,
    stdout_truncated: true,
  });
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.inconclusive, true);
  assert.equal(result.unavailable_reason, "truncated");
  assert.ok(result.truncation_notes.length >= 1);
});

test("partial JSON: inconclusive even with exit 0", () => {
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: 0,
    stdout: '{"evidence_id":"ev_partial","normalized_result":{',
    stderr: "",
  });
  assert.equal(result.inconclusive, true);
  assert.equal(result.unavailable_reason, "inconclusive");
  assert.match(result.truncation_notes.join(" "), /JSON incomplete/i);
});

test("timeout: unavailable_reason timeout + inconclusive", () => {
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: null,
    stdout: "",
    stderr: "deadline exceeded",
    timed_out: true,
  });
  assert.equal(result.inconclusive, true);
  assert.equal(result.unavailable_reason, "timeout");
  assert.equal(result.exit_code, null);
});

test("cancel: inconclusive; retains partial stdout if any", () => {
  const result = buildReaCliCapabilityResult({
    ...baseObs,
    exit_code: 1,
    stdout: JSON.stringify({
      error: "Analysis failed",
      code: "cancelled",
      category: "cancelled",
      message: "Analysis was cancelled. Start it again when ready.",
    }),
    stderr: "",
    cancelled: true,
  });
  assert.equal(result.inconclusive, true);
  assert.equal(result.unavailable_reason, "inconclusive");
  assert.equal(result.is_finding, false);
  assert.equal((result.result as { observation?: { code?: string } }).observation?.code, "cancelled");
  assert.equal((result.result as { cancelled?: boolean }).cancelled, true);
});

test("cleanup plan retains evidence paths and lists ephemeral deletes", () => {
  const plan = planReaCliCleanup({
    workspace: "/workspace",
    evidencePaths: [
      "/workspace/evidence/rea-function-main.json",
      "/workspace/evidence/rea-function-main.stderr.txt",
      "/workspace/evidence/rea-function-main.meta.json",
    ],
    ephemeralPaths: ["/tmp/ghidra_proj_abc", "/workspace/.rea-cache/tmp"],
  });
  assert.equal(plan.retain.length, 3);
  assert.deepEqual(plan.delete_ephemeral, ["/tmp/ghidra_proj_abc", "/workspace/.rea-cache/tmp"]);
  assert.ok(plan.notes.some((n) => /Retain raw JSON/i.test(n)));
});

test("missing capability / unadmitted image: capability_unavailable", () => {
  assert.equal(isReaCliImageAdmitted("deepsonar-reverse"), true);
  assert.equal(isReaCliImageAdmitted("deepsonar-base"), false);
  assert.equal(isReaCliImageAdmitted("deepsonar-mobile"), false);

  const onBase = admitCliCapability({
    capabilityId: REA_CLI_CAPABILITY_ID,
    imageKey: "deepsonar-base",
  });
  assert.equal(onBase.ok, false);
  if (!onBase.ok) {
    assert.equal(onBase.code, CLI_UNAVAILABLE_CODE);
    assert.equal(onBase.reason, "incompatible_image");
  }

  const missing = admitCliCapability({
    capabilityId: "binary.rea.cli.not-registered",
    imageKey: "deepsonar-reverse",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, CLI_UNAVAILABLE_CODE);
    assert.equal(missing.reason, "unregistered");
  }

  const ok = admitCliCapability({
    capabilityId: REA_CLI_CAPABILITY_ID,
    imageKey: "deepsonar-reverse",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.frozen.tool, "rea");
    assert.equal(ok.frozen.image_key, "deepsonar-reverse");
    assert.equal(ok.frozen.tool_version, "6.4.0");
  }
});


test("empty/whitespace stdout and unknown exit never become conclusive observations", () => {
  for (const stdout of ["", " \n\t"]) {
    const result = buildReaCliCapabilityResult({ ...baseObs, exit_code: 0, stdout, stderr: "" });
    assert.equal(result.inconclusive, true);
    assert.equal(result.unavailable_reason, "inconclusive");
  }
  const result = buildReaCliCapabilityResult({ ...baseObs, exit_code: null, stdout: "{}", stderr: "" });
  assert.equal(result.unavailable_code, CLI_UNAVAILABLE_CODE);
});

test("UTF-8 output caps count bytes instead of JavaScript characters", () => {
  const stdout = JSON.stringify({ text: "界".repeat(30) });
  assert.ok(stdout.length < 64 && Buffer.byteLength(stdout) > 64);
  const result = buildReaCliCapabilityResult({ ...baseObs, exit_code: 0, stdout, stderr: "", max_output_bytes: 64 });
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.inconclusive, true);
  const stderr = buildReaCliCapabilityResult({ ...baseObs, exit_code: 0, stdout: "{}", stderr: "界".repeat(30), max_output_bytes: 64 });
  assert.equal(stderr.stderr_truncated, true);
  assert.equal(stderr.inconclusive, true);
});
