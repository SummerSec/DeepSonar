import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SANDBOX_CRD,
  readAgentSandboxCrd,
  readGvisorNatProbe,
  runOpenSandboxGvisorPoc,
  shouldRunOpenSandboxGvisorPoc,
} from "./opensandbox-gvisor-poc.js";

test("gVisor PoC is skip-safe until explicitly enabled", () => {
  assert.equal(shouldRunOpenSandboxGvisorPoc({}), false);
  assert.equal(shouldRunOpenSandboxGvisorPoc({ OPEN_SANDBOX_POC: "1" }), false);
  assert.equal(shouldRunOpenSandboxGvisorPoc({ OPEN_SANDBOX_POC: "1", OPEN_SANDBOX_POC_GVISOR: "1" }), true);
});

test("gVisor nat probe recognizes the egress sidecar failure", () => {
  assert.deepEqual(readGvisorNatProbe("iptables: Failed to initialize nft: Protocol not supported\n", 1), {
    natUnsupported: true,
  });
  assert.deepEqual(readGvisorNatProbe("iptables v1.8.9 (legacy): can't initialize iptables table 'nat': Table does not exist\n", 1), {
    natUnsupported: true,
  });
  assert.deepEqual(readGvisorNatProbe("Chain PREROUTING\n", 0), { natUnsupported: false });
});

test("agent-sandbox CRD probe does not infer availability from docs", () => {
  assert.equal(readAgentSandboxCrd({ metadata: { name: AGENT_SANDBOX_CRD } }), true);
  assert.equal(readAgentSandboxCrd({ metadata: { name: "batchsandboxes.sandbox.opensandbox.io" } }), false);
  assert.equal(readAgentSandboxCrd({}), false);
});

test("gVisor PoC fail-closes a working nat table and unknown errors", async () => {
  await assert.rejects(
    () => runOpenSandboxGvisorPoc(async (args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "runsc version release-20251006.0\n", stderr: "" };
      return { exitCode: 0, stdout: "Chain PREROUTING\n", stderr: "" };
    }),
    /OPENSANDBOX_POC_GVISOR_EGRESS_UNEXPECTED/,
  );
  await assert.rejects(
    () => runOpenSandboxGvisorPoc(async (args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "runsc version release-20251006.0\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "permission denied" };
    }),
    /OPENSANDBOX_POC_GVISOR_EGRESS_UNKNOWN/,
  );
});

test("gVisor PoC records incompatible leftover-free evidence", async () => {
  const result = await runOpenSandboxGvisorPoc(async (args) => {
    if (args[0] === "--version") return { exitCode: 0, stdout: "runsc version release-20251006.0\n", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "iptables: Failed to initialize nft: Protocol not supported\n" };
  });
  assert.deepEqual(result, {
    compatible: false,
    natUnsupported: true,
    leftovers: 0,
    runscVersion: "runsc version release-20251006.0",
  });
});
