import assert from "node:assert/strict";
import test from "node:test";
import { formatHealthOpenSandbox, healthOpenSandboxDegraded } from "./health-status";

test("OpenSandbox health copy stays hidden when the probe is skipped", () => {
  assert.equal(formatHealthOpenSandbox(undefined), null);
  assert.equal(formatHealthOpenSandbox({ level: "skipped", domain: "127.0.0.1:8080", ready: true }), null);
  assert.equal(healthOpenSandboxDegraded({ level: "skipped", ready: true }), false);
});

test("OpenSandbox health copy reports ready and fail-closed states without probe text", () => {
  assert.equal(formatHealthOpenSandbox({ level: "ok", domain: "127.0.0.1:8080", ready: true }), "OpenSandbox 就绪");
  assert.equal(formatHealthOpenSandbox({ level: "error", domain: "127.0.0.1:8080", ready: false }), "OpenSandbox 不可达");
  assert.equal(formatHealthOpenSandbox({ level: "unconfigured", domain: "", ready: false }), "OpenSandbox 未配置");
  assert.equal(healthOpenSandboxDegraded({ level: "ok", ready: true }), false);
  assert.equal(healthOpenSandboxDegraded({ level: "error", ready: false }), true);
  assert.equal(healthOpenSandboxDegraded({ level: "unconfigured", ready: false }), true);
});
