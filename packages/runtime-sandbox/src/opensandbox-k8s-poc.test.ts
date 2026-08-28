import assert from "node:assert/strict";
import test from "node:test";
import type { OpenSandboxClient, OpenSandboxCreateInput, OpenSandboxSession } from "./opensandbox.js";
import {
  findKataWorkload,
  findRemainingJobPods,
  probeKataCluster,
  waitForRemainingJobPods,
  readKataClusterProbe,
  runOpenSandboxK8sPoc,
  shouldRunOpenSandboxK8sPoc,
} from "./opensandbox-k8s-poc.js";

const HARD_LIMITS = "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n";

function session(overrides?: {
  isolated?: boolean;
  gatewayAllowed?: boolean;
  denyBlocked?: boolean;
  hostEscapeBlocked?: boolean;
  envStdout?: string;
  limitsStdout?: string;
}): OpenSandboxSession {
  return {
    id: "kata-1",
    async run(command) {
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime.contract/v1" }), stderr: "" };
      }
      if (command.includes("192.0.2.1")) {
        return { exitCode: overrides?.isolated === false ? 0 : 1, stdout: "", stderr: "" };
      }
      if (command.includes("deepsonar-gateway-proxy")) {
        return { exitCode: overrides?.gatewayAllowed === false ? 1 : 0, stdout: "", stderr: "" };
      }
      if (command.includes("deepsonar-egress-deny-probe")) {
        return { exitCode: overrides?.denyBlocked === false ? 0 : 1, stdout: "", stderr: "" };
      }
      if (command.includes("/var/run/docker.sock")) {
        return { exitCode: overrides?.hostEscapeBlocked === false ? 1 : 0, stdout: "", stderr: "" };
      }
      if (command.includes("sh -c 'env'")) {
        return { exitCode: 0, stdout: overrides?.envStdout ?? "", stderr: "" };
      }
      if (command.includes("CapPrm")) {
        return { exitCode: 0, stdout: overrides?.limitsStdout ?? HARD_LIMITS, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async runAsync() {
      throw new Error("unused");
    },
    async writeFile() {},
    async readFile() {
      return Buffer.from("");
    },
    async getState() {
      return "Running";
    },
    async kill() {},
    async close() {},
  };
}

function kataWorld(live: OpenSandboxSession) {
  let created: OpenSandboxCreateInput | undefined;
  let alive = true;
  live.kill = async () => {
    alive = false;
  };
  const client: OpenSandboxClient = {
    async create(input) {
      created = input;
      return live;
    },
    async connect() {
      return live;
    },
    async list() {
      return [];
    },
  };
  const kubectl = async (args: string[]) => {
    if (args[0] === "apply" || args[0] === "delete") return { kind: "Status" };
    if (args[1] === "runtimeclass") return { metadata: { name: "kata-qemu" }, handler: "kata-qemu" };
    if (args[1] === "namespace") return { metadata: { name: "deepsonar-opensandbox" } };
    if (args[1] === "resourcequota") {
      return { items: [{ metadata: { name: "deepsonar-opensandbox" }, spec: { hard: { pods: "32" } } }] };
    }
    if (args[1] === "pod" || args[1] === "service") {
      return { metadata: { name: args[2] }, status: { phase: "Running" } };
    }
    const jobId = created?.metadata["deepsonar.job"] ?? "";
    return {
      items: alive
        ? [{ metadata: { name: "kata-pod", labels: { job: jobId } }, spec: { runtimeClassName: "kata-qemu" } }]
        : [],
    };
  };
  return { client, kubectl, get created() { return created; } };
}

test("Kata cluster probe requires runtimeclass, namespace, and quota", () => {
  const ok = readKataClusterProbe({
    runtimeClass: { metadata: { name: "kata-qemu" }, handler: "kata-qemu" },
    namespace: { metadata: { name: "deepsonar-opensandbox" } },
    quota: { items: [{ metadata: { name: "deepsonar-opensandbox" }, spec: { hard: { pods: "32" } } }] },
  });
  assert.deepEqual(ok, { runtimeClass: true, namespace: true, quota: true });
  assert.equal(readKataClusterProbe({}).runtimeClass, false);
  assert.equal(shouldRunOpenSandboxK8sPoc({}), false);
  assert.equal(shouldRunOpenSandboxK8sPoc({ OPEN_SANDBOX_POC: "1", OPEN_SANDBOX_POC_K8S: "1" }), true);
});

test("Kata workload discovery fail-closes docker-mode leftovers", async () => {
  const jobId = "job-kata";
  const found = findKataWorkload({
    items: [{ metadata: { name: "pod-1", labels: { job: jobId } }, spec: { runtimeClassName: "kata-qemu" } }],
  }, jobId);
  assert.equal(found.runtimeClassName, "kata-qemu");
  assert.throws(
    () => findKataWorkload({ items: [{ metadata: { name: "pod-1" }, spec: { runtimeClassName: "runc" } }] }, jobId),
    /OPENSANDBOX_POC_KATA_WORKLOAD_MISSING/,
  );
  assert.throws(
    () => findKataWorkload({
      items: [{ metadata: { name: "pod-1", labels: { job: jobId } }, spec: { runtimeClassName: "runc" } }],
    }, jobId),
    /OPENSANDBOX_POC_KATA_RUNTIMECLASS_NOT_USED/,
  );
  assert.equal(findRemainingJobPods({ items: [{ job: jobId }, { job: "other" }] }, jobId), 1);
  const gone = await waitForRemainingJobPods(async () => ({ items: [] }), jobId, 1_000);
  assert.equal(gone, 0);
});

test("OpenSandbox Kata PoC requires a kata-qemu workload and leftover-free destroy", async () => {
  const world = kataWorld(session());
  const result = await runOpenSandboxK8sPoc(world.client, world.kubectl, { image: "img@sha256:" + "a".repeat(64) });
  assert.equal(result.kata, true);
  assert.equal(result.isolated, true);
  assert.equal(result.hostEscapeBlocked, true);
  assert.equal(result.envClean, true);
  assert.equal(result.hardLimits, true);
  assert.equal(result.gatewayAllowed, true);
  assert.equal(result.denyBlocked, true);
  assert.equal(result.leftovers, 0);
  assert.equal(world.created?.resource.pids, undefined);
  assert.deepEqual(world.created?.resource, { cpu: "1", memory: "512Mi" });

  await assert.rejects(
    () => probeKataCluster(async () => ({})),
    /OPENSANDBOX_POC_KATA_RUNTIMECLASS_MISSING/,
  );
});

test("OpenSandbox Kata PoC fail-closes isolation, host escape, env leak, and missing hard limits", async () => {
  const image = "img@sha256:" + "a".repeat(64);
  const leaked = kataWorld(session({ isolated: false }));
  await assert.rejects(() => runOpenSandboxK8sPoc(leaked.client, leaked.kubectl, { image }), /OPENSANDBOX_POC_KATA_NETWORK_NOT_ISOLATED/);
  const gateway = kataWorld(session({ gatewayAllowed: false }));
  await assert.rejects(() => runOpenSandboxK8sPoc(gateway.client, gateway.kubectl, { image }), /OPENSANDBOX_POC_KATA_GATEWAY_BLOCKED/);
  const deny = kataWorld(session({ denyBlocked: false }));
  await assert.rejects(() => runOpenSandboxK8sPoc(deny.client, deny.kubectl, { image }), /OPENSANDBOX_POC_KATA_DENY_LEAK/);
  const escaped = kataWorld(session({ hostEscapeBlocked: false }));
  await assert.rejects(() => runOpenSandboxK8sPoc(escaped.client, escaped.kubectl, { image }), /OPENSANDBOX_POC_KATA_HOST_ESCAPE/);
  const envName = kataWorld(session({ envStdout: "OPENSANDBOX_SERVER_API_KEY=secret\n" }));
  await assert.rejects(() => runOpenSandboxK8sPoc(envName.client, envName.kubectl, { image }), /OPENSANDBOX_POC_KATA_ENV_LEAK/);
  const envValue = kataWorld(session({ envStdout: "OTHER=vendor-secret\n" }));
  await assert.rejects(
    () => runOpenSandboxK8sPoc(envValue.client, envValue.kubectl, { image, apiKey: "vendor-secret" }),
    /OPENSANDBOX_POC_KATA_ENV_LEAK/,
  );
  const limits = kataWorld(session({ limitsStdout: "CapPrm:\t00000000ffffffff\nCapEff:\t00000000ffffffff\nNoNewPrivs:\t0\n" }));
  await assert.rejects(() => runOpenSandboxK8sPoc(limits.client, limits.kubectl, { image }), /OPENSANDBOX_POC_KATA_HARD_LIMITS/);
});
