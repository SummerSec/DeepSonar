import assert from "node:assert/strict";
import test from "node:test";
import type { OpenSandboxClient, OpenSandboxCreateInput, OpenSandboxSession } from "./opensandbox.js";
import {
  findKataWorkload,
  findRemainingJobPods,
  probeKataCluster,
  readKataClusterProbe,
  runOpenSandboxK8sPoc,
  shouldRunOpenSandboxK8sPoc,
} from "./opensandbox-k8s-poc.js";

function session(): OpenSandboxSession {
  return {
    id: "kata-1",
    async run(command) {
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime.contract/v1" }), stderr: "" };
      }
      if (command.includes("192.0.2.1")) return { exitCode: 1, stdout: "", stderr: "" };
      if (command.includes("/var/run/docker.sock")) return { exitCode: 0, stdout: "", stderr: "" };
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

test("Kata workload discovery fail-closes docker-mode leftovers", () => {
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
});

test("OpenSandbox Kata PoC requires a kata-qemu workload and leftover-free destroy", async () => {
  let created: OpenSandboxCreateInput | undefined;
  let alive = true;
  const live = session();
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
    if (args[1] === "runtimeclass") return { metadata: { name: "kata-qemu" }, handler: "kata-qemu" };
    if (args[1] === "namespace") return { metadata: { name: "deepsonar-opensandbox" } };
    if (args[1] === "resourcequota") {
      return { items: [{ metadata: { name: "deepsonar-opensandbox" }, spec: { hard: { pods: "32" } } }] };
    }
    const jobId = created?.metadata["deepsonar.job"] ?? "";
    return {
      items: alive
        ? [{ metadata: { name: "kata-pod", labels: { job: jobId } }, spec: { runtimeClassName: "kata-qemu" } }]
        : [],
    };
  };
  const result = await runOpenSandboxK8sPoc(client, kubectl, { image: "img@sha256:" + "a".repeat(64) });
  assert.equal(result.kata, true);
  assert.equal(result.isolated, true);
  assert.equal(result.hostEscapeBlocked, true);
  assert.equal(result.leftovers, 0);

  await assert.rejects(
    () => probeKataCluster(async () => ({})),
    /OPENSANDBOX_POC_KATA_RUNTIMECLASS_MISSING/,
  );
});
