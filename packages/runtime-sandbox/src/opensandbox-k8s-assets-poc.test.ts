import assert from "node:assert/strict";
import test from "node:test";
import type { OpenSandboxClient, OpenSandboxCreateInput, OpenSandboxSession } from "./opensandbox.js";
import {
  findRemainingJobClaims,
  readDefaultStorageClass,
  readPvcPhase,
  readSeederSucceeded,
  runOpenSandboxK8sAssetsPoc,
  sharedAssetsClaimName,
  shouldRunOpenSandboxK8sAssetsPoc,
} from "./opensandbox-k8s-assets-poc.js";

const HARD_LIMITS = "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n";
const JOB = "11111111-1111-4111-8111-111111111111";

function session(overrides?: { mounted?: boolean; seed?: string; writable?: boolean }): OpenSandboxSession {
  return {
    id: "kata-assets-1",
    async run(command) {
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime.contract/v1" }), stderr: "" };
      }
      if (command.includes("test -d") && command.includes("mounted")) {
        return { exitCode: overrides?.mounted === false ? 1 : 0, stdout: overrides?.mounted === false ? "" : "mounted\n", stderr: "" };
      }
      if (command.includes("poc-seed.txt")) {
        return { exitCode: overrides?.seed === "" ? 1 : 0, stdout: overrides?.seed ?? "seed\n", stderr: "" };
      }
      if (command.includes("poc-write")) {
        return { exitCode: overrides?.writable ? 0 : 1, stdout: "", stderr: "" };
      }
      if (command.includes("CapPrm")) {
        return { exitCode: 0, stdout: HARD_LIMITS, stderr: "" };
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

function assetsWorld(live: OpenSandboxSession) {
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
    if (args[1] === "storageclass") {
      return { items: [{ metadata: { name: "local-path" } }] };
    }
    if (args[1] === "pvc") {
      return args.includes("-n") && args.includes("-o") && !args.includes("get")
        ? { items: [] }
        : { metadata: { name: args[2] }, status: { phase: "Bound" }, items: [] };
    }
    if (args[1] === "pod" && String(args[2] ?? "").startsWith("deepsonar-assets-seeder-")) {
      return { metadata: { name: args[2] }, status: { phase: "Succeeded" } };
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

test("Kata shared-assets PoC is skip-safe until explicitly enabled", () => {
  assert.equal(shouldRunOpenSandboxK8sAssetsPoc({}), false);
  assert.equal(shouldRunOpenSandboxK8sAssetsPoc({ OPEN_SANDBOX_POC: "1", OPEN_SANDBOX_POC_K8S: "1" }), false);
  assert.equal(shouldRunOpenSandboxK8sAssetsPoc({
    OPEN_SANDBOX_POC: "1",
    OPEN_SANDBOX_POC_K8S: "1",
    OPEN_SANDBOX_POC_K8S_ASSETS: "1",
  }), true);
});

test("shared-assets PVC name stays Scheduler-owned deepsonar-assets-*", () => {
  assert.equal(sharedAssetsClaimName(JOB), `deepsonar-assets-${JOB}`);
  assert.throws(() => sharedAssetsClaimName("not-a-job"), /OPENSANDBOX_POC_K8S_ASSETS_JOB/);
  assert.equal(readPvcPhase({ status: { phase: "Bound" } }), "Bound");
  assert.equal(readSeederSucceeded({ status: { phase: "Succeeded" } }), true);
  assert.equal(findRemainingJobClaims({ items: [{ job: JOB }, { job: "other" }] }, JOB), 1);
});

test("Kata shared-assets PoC requires a default StorageClass", () => {
  assert.equal(readDefaultStorageClass({ items: [{ metadata: { name: "local-path" } }] }), "local-path");
  assert.equal(readDefaultStorageClass({ items: [{ metadata: { name: "standard" } }] }), "standard");
  assert.throws(() => readDefaultStorageClass({ items: [] }), /OPENSANDBOX_POC_K8S_STORAGECLASS_MISSING/);
});

test("OpenSandbox Kata assets PoC mounts a Scheduler PVC read-only", async () => {
  const world = assetsWorld(session());
  const result = await runOpenSandboxK8sAssetsPoc(world.client, world.kubectl, {
    image: "img@sha256:" + "a".repeat(64),
    timeoutMs: 2_000,
  });
  assert.deepEqual(result, {
    kata: true,
    mounted: true,
    seedOk: true,
    readonly: true,
    leftovers: 0,
    leftoverPods: 0,
    leftoverPvcs: 0,
  });
  assert.equal(world.created?.volumes[0]?.readOnly, true);
  assert.equal(world.created?.volumes[0]?.pvc.createIfNotExists, false);
  assert.match(world.created?.volumes[0]?.pvc.claimName ?? "", /^deepsonar-assets-/);
  assert.equal(world.created?.resource.pids, undefined);
});

test("OpenSandbox Kata assets PoC fail-closes missing mount, seed, or writable volume", async () => {
  const image = "img@sha256:" + "a".repeat(64);
  const unmounted = assetsWorld(session({ mounted: false }));
  await assert.rejects(
    () => runOpenSandboxK8sAssetsPoc(unmounted.client, unmounted.kubectl, { image, timeoutMs: 2_000 }),
    /OPENSANDBOX_POC_K8S_ASSETS_UNMOUNTED/,
  );
  const empty = assetsWorld(session({ seed: "" }));
  await assert.rejects(
    () => runOpenSandboxK8sAssetsPoc(empty.client, empty.kubectl, { image, timeoutMs: 2_000 }),
    /OPENSANDBOX_POC_K8S_ASSETS_SEED/,
  );
  const writable = assetsWorld(session({ writable: true }));
  await assert.rejects(
    () => runOpenSandboxK8sAssetsPoc(writable.client, writable.kubectl, { image, timeoutMs: 2_000 }),
    /OPENSANDBOX_POC_K8S_ASSETS_WRITABLE/,
  );
});
