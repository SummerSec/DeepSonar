import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OPENSANDBOX_UPLOAD_CIRCUIT_OPEN,
  UPLOAD_CIRCUIT_JOBS_TO_TRIP,
  UPLOAD_CIRCUIT_WAVES_TO_TRIP,
  classifyOpenSandboxUploadFailure,
  closeOpenSandboxUploadCircuit,
  createOpenSandboxUploadCircuitError,
  openSandboxUploadCircuitAllowsDispatch,
  openSandboxUploadCircuitStatus,
  probeOpenSandboxUploadBeforeDispatch,
  recordOpenSandboxJobOutcome,
  resetOpenSandboxUploadCircuitForTests,
  sealOpenSandboxUploadWave,
  setOpenSandboxUploadCircuitTestHooks,
  shouldProbeOpenSandboxUpload,
  tripOpenSandboxUploadCircuit,
} from "./opensandbox-upload-circuit.js";

const uploadErr = Object.assign(new Error("Upload failed (status=500)"), {
  statusCode: 500,
  code: "UNEXPECTED_RESPONSE",
});

test("upload failure classifier matches transient upload 5xx and rejects auth errors", () => {
  resetOpenSandboxUploadCircuitForTests();
  assert.equal(classifyOpenSandboxUploadFailure(uploadErr), true);
  assert.equal(
    classifyOpenSandboxUploadFailure(Object.assign(new Error("forbidden"), { statusCode: 403 })),
    false,
  );
  assert.equal(classifyOpenSandboxUploadFailure(createOpenSandboxUploadCircuitError()), false);
});

test("two consecutive all-upload waves trip the circuit and block dispatch", async () => {
  resetOpenSandboxUploadCircuitForTests();
  let now = 1_000_000;
  const alerts: string[] = [];
  setOpenSandboxUploadCircuitTestHooks({
    now: () => now,
    dockerRestart: async () => {
      throw new Error("restart must stay gated");
    },
    alertSink: (line) => {
      alerts.push(line);
    },
  });

  const scope = { projectId: "p1", canvasId: "c1" };
  for (let i = 0; i < UPLOAD_CIRCUIT_WAVES_TO_TRIP; i++) {
    await recordOpenSandboxJobOutcome({ ...scope, ok: false, error: uploadErr });
    await recordOpenSandboxJobOutcome({ ...scope, ok: false, error: uploadErr });
    await sealOpenSandboxUploadWave(scope);
    now += 5 * 60 * 1000;
  }

  const status = openSandboxUploadCircuitStatus();
  assert.equal(status.state, "open");
  assert.equal(openSandboxUploadCircuitAllowsDispatch(status), false);
  assert.match(status.lastTripReason ?? "", /consecutive_upload_waves|upload_failures/);
  assert.ok(alerts.some((line) => line.includes("ALERT opensandbox_upload_persistent")));
  assert.match(
    createOpenSandboxUploadCircuitError(status).message,
    new RegExp(OPENSANDBOX_UPLOAD_CIRCUIT_OPEN),
  );
});

test("absolute upload failure count inside the window trips without waiting for waves", async () => {
  resetOpenSandboxUploadCircuitForTests();
  let now = 2_000_000;
  setOpenSandboxUploadCircuitTestHooks({ now: () => now });

  for (let i = 0; i < UPLOAD_CIRCUIT_JOBS_TO_TRIP; i++) {
    await recordOpenSandboxJobOutcome({
      projectId: "p2",
      canvasId: "c2",
      ok: false,
      error: uploadErr,
    });
    now += 1_000;
  }

  assert.equal(openSandboxUploadCircuitStatus().state, "open");
  assert.equal(openSandboxUploadCircuitAllowsDispatch(), false);
});

test("mixed non-upload failure resets consecutive upload waves", async () => {
  resetOpenSandboxUploadCircuitForTests();
  let now = 3_000_000;
  setOpenSandboxUploadCircuitTestHooks({ now: () => now });
  const scope = { projectId: "p3", canvasId: "c3" };

  await recordOpenSandboxJobOutcome({ ...scope, ok: false, error: uploadErr });
  await recordOpenSandboxJobOutcome({ ...scope, ok: false, error: uploadErr });
  await sealOpenSandboxUploadWave(scope);
  assert.equal(openSandboxUploadCircuitStatus().consecutiveUploadWaves, 1);

  now += 5 * 60 * 1000;
  await recordOpenSandboxJobOutcome({ ...scope, ok: false, error: new Error("model 401") });
  await sealOpenSandboxUploadWave(scope);
  assert.equal(openSandboxUploadCircuitStatus().consecutiveUploadWaves, 0);
  assert.equal(openSandboxUploadCircuitStatus().state, "closed");
});

test("successful job closes an open circuit", async () => {
  resetOpenSandboxUploadCircuitForTests();
  await tripOpenSandboxUploadCircuit("test");
  assert.equal(openSandboxUploadCircuitAllowsDispatch(), false);
  await recordOpenSandboxJobOutcome({ projectId: "p4", canvasId: "c4", ok: true });
  assert.equal(openSandboxUploadCircuitStatus().state, "closed");
  assert.equal(openSandboxUploadCircuitAllowsDispatch(), true);
});

test("probe failure trips circuit fail-closed; probe success closes half-open", async () => {
  resetOpenSandboxUploadCircuitForTests();
  let now = 4_000_000;
  setOpenSandboxUploadCircuitTestHooks({
    now: () => now,
    uploadProbe: async () => {
      throw Object.assign(new Error("Upload failed (status=500)"), {
        statusCode: 500,
        code: "UNEXPECTED_RESPONSE",
      });
    },
  });
  await tripOpenSandboxUploadCircuit("seed");
  now += 11 * 60 * 1000;
  assert.equal(shouldProbeOpenSandboxUpload(), true);
  const failed = await probeOpenSandboxUploadBeforeDispatch();
  assert.equal(failed.ok, false);
  assert.equal(openSandboxUploadCircuitStatus().state, "open");

  resetOpenSandboxUploadCircuitForTests();
  now = 5_000_000;
  let probed = 0;
  setOpenSandboxUploadCircuitTestHooks({
    now: () => now,
    uploadProbe: async () => {
      probed += 1;
    },
  });
  await tripOpenSandboxUploadCircuit("seed2");
  now += 11 * 60 * 1000;
  const ok = await probeOpenSandboxUploadBeforeDispatch();
  assert.equal(ok.ok, true);
  assert.equal(probed, 1);
  assert.equal(openSandboxUploadCircuitStatus().state, "closed");
});

test("auto-restart stays gated unless DEEPSONAR_OPENSANDBOX_AUTO_RESTART is enabled via config", async () => {
  resetOpenSandboxUploadCircuitForTests();
  let restarted = 0;
  setOpenSandboxUploadCircuitTestHooks({
    dockerRestart: async () => {
      restarted += 1;
    },
  });
  await tripOpenSandboxUploadCircuit("gate_check");
  assert.equal(restarted, 0);
  assert.match(openSandboxUploadCircuitStatus().healResult ?? "", /skipped_auto_restart_disabled/);
});

test("dispatcher and readiness gate on upload circuit", () => {
  const dispatcher = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const readiness = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");
  assert.match(dispatcher, /openSandboxUploadCircuitAllowsDispatch/);
  assert.match(dispatcher, /recordOpenSandboxJobOutcome/);
  assert.match(dispatcher, /probeOpenSandboxUploadBeforeDispatch|shouldProbeOpenSandboxUpload/);
  assert.match(readiness, /OPENSANDBOX_UPLOAD_CIRCUIT_OPEN|opensandbox_upload_circuit_open/);
});

test("close helper is exported for recovery paths", () => {
  resetOpenSandboxUploadCircuitForTests();
  closeOpenSandboxUploadCircuit("manual");
  assert.equal(openSandboxUploadCircuitStatus().state, "closed");
});
