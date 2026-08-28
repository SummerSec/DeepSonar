import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENSANDBOX_POC_CONTRACT,
  OPENSANDBOX_POC_IMAGE,
  runOpenSandboxAssetsPoc,
  runOpenSandboxCancelPoc,
  runOpenSandboxCliLaunchPoc,
  runOpenSandboxImageContractPoc,
  runOpenSandboxRestrictedPoc,
  runOpenSandboxContractFailPoc,
  runOpenSandboxHostPoc,
  runOpenSandboxInfrastructurePoc,
  runOpenSandboxRecoveryPoc,
  shouldRunOpenSandboxPoc,
  isOpenSandboxCliMissing,
} from "./opensandbox-poc.js";
import { OpenSandboxRunner } from "./opensandbox.js";
import type { OpenSandboxClient, OpenSandboxCreateInput, OpenSandboxSession } from "./opensandbox.js";

function fakePocClient(): OpenSandboxClient & { created: OpenSandboxCreateInput[]; killed: number } {
  const created: OpenSandboxCreateInput[] = [];
  const session: OpenSandboxSession = {
    id: "poc-1",
    async run() {
      return { exitCode: 0, stdout: "poc\n", stderr: "" };
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
    async kill() {
      client.killed += 1;
    },
    async close() {},
  };
  const client = {
    created,
    killed: 0,
    async create(input: OpenSandboxCreateInput) {
      created.push(input);
      return session;
    },
    async connect() {
      return session;
    },
    async list() {
      return [{ resourceId: "poc-1", jobId: "job-1", attemptId: "att-1", state: "Running" }];
    },
  };
  return client;
}

test("OpenSandbox PoC stays skip-safe unless explicitly enabled", () => {
  assert.equal(shouldRunOpenSandboxPoc({}), false);
  assert.equal(shouldRunOpenSandboxPoc({ OPEN_SANDBOX_POC: "0" }), false);
  assert.equal(shouldRunOpenSandboxPoc({ OPEN_SANDBOX_POC: "1" }), true);
  assert.match(OPENSANDBOX_POC_IMAGE, /busybox@sha256:[0-9a-f]{64}/);
  assert.equal(OPENSANDBOX_POC_CONTRACT, "deepsonar.runtime.contract/v1");
});

test("OpenSandbox infrastructure PoC creates, probes, lists, and destroys", async () => {
  const client = fakePocClient();
  const result = await runOpenSandboxInfrastructurePoc(client, {
    jobId: "job-1",
    attemptId: "att-1",
  });
  assert.equal(result.sandboxId, "poc-1");
  assert.equal(result.stdout, "poc");
  assert.equal(result.listed, true);
  assert.ok(result.createMs >= 0);
  assert.equal(client.created[0]?.timeoutSeconds, null);
  assert.equal(client.created[0]?.networkPolicy.defaultAction, "deny");
  assert.equal(client.killed, 1);
});

test("OpenSandbox runner PoC fail-closes missing runtime contract and cleans leftovers", async () => {
  const session = {
    id: "poc-1",
    async run() {
      return { exitCode: 1, stdout: "", stderr: "no manifest" };
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
  const client: OpenSandboxClient = {
    async create() {
      return session;
    },
    async connect() {
      return undefined;
    },
    async list() {
      return [];
    },
  };
  const result = await runOpenSandboxContractFailPoc(new OpenSandboxRunner(client), {
    jobId: "job-1",
    attemptId: "att-1",
  });
  assert.deepEqual(result, { rejected: true, leftovers: 0 });
});

function hostSession(): OpenSandboxSession {
  const files = new Map<string, string>([["/workspace/poc-note.txt", "note"]]);
  return {
    id: "host-1",
    async run(command) {
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime.contract/v1" }), stderr: "" };
      }
      if (command.includes("poc-seed.txt")) return { exitCode: 0, stdout: "seed\n", stderr: "" };
      if (command.includes("poc-write")) return { exitCode: 1, stdout: "", stderr: "Read-only file system" };
      if (command.includes("shared") && command.includes("mounted")) return { exitCode: 0, stdout: "mounted\n", stderr: "" };
      if (command.includes("env")) return { exitCode: 0, stdout: "PATH=/bin\nHOME=/workspace\n", stderr: "" };
      if (command.includes("192.0.2.1")) return { exitCode: 1, stdout: "", stderr: "" };
      if (command.includes("CapPrm")) {
        return { exitCode: 0, stdout: "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n", stderr: "" };
      }
      if (command.includes("poc-link") && command.includes("test ! -L")) return { exitCode: 44, stdout: "", stderr: "" };
      if (command.startsWith("command -v ") || command.startsWith("test -f ")) return { exitCode: 1, stdout: "", stderr: "" };
      if (command.includes("readlink") || command.includes("test ! -L")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async runAsync() {
      return {
        async write() {},
        async closeStdin() {},
        async kill() {},
        async resize() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "stdout" as const, chunk: "steerterm-ok hello-complete.txt ^C" };
          yield { type: "exit" as const, exitCode: 0 };
        },
      };
    },
    async writeFile(destPath, content) {
      files.set(destPath, typeof content === "string" ? content : content.toString());
    },
    async readFile(filePath) {
      return Buffer.from(files.get(filePath) ?? "");
    },
    async getState() {
      return "Running";
    },
    async kill() {},
    async close() {},
  };
}

test("OpenSandbox host PoC covers files, incremental stdin, PTY, and reconnect", async () => {
  const session = hostSession();
  const client: OpenSandboxClient = {
    async create() {
      return session;
    },
    async connect(id) {
      return id === session.id ? session : undefined;
    },
    async list() {
      return [];
    },
  };
  const result = await runOpenSandboxHostPoc(client, { image: "img@sha256:" + "a".repeat(64), apiKey: "secret-key" });
  assert.equal(result.fileOk, true);
  assert.equal(result.reservedRejected, true);
  assert.equal(result.symlinkRejected, true);
  assert.equal(result.oversizedRejected, true);
  assert.equal(result.pathEscapeRejected, true);
  assert.equal(result.envClean, true);
  assert.equal(result.incrementalOk, true);
  assert.equal(result.ptyOk, true);
  assert.equal(result.terminalOk, true);
  assert.equal(result.tabOk, true);
  assert.equal(result.interruptOk, true);
  assert.equal(result.closedOnDestroy, true);
  assert.equal(result.networkIsolated, true);
  assert.equal(result.hardLimits, true);
  assert.equal(result.reconnected, true);
  assert.equal(result.leftovers, 0);
});

test("OpenSandbox restricted PoC fail-closes non-gateway egress", async () => {
  const session = hostSession();
  const created: OpenSandboxCreateInput[] = [];
  const client: OpenSandboxClient = {
    async create(input) {
      created.push(input);
      return session;
    },
    async connect(id) {
      return id === session.id ? session : undefined;
    },
    async list() {
      return [];
    },
  };
  const result = await runOpenSandboxRestrictedPoc(client, { image: "img@sha256:" + "a".repeat(64) });
  assert.deepEqual(result, { isolated: true, leftovers: 0 });
  assert.deepEqual(created[0]?.networkPolicy, {
    defaultAction: "deny",
    egress: [{ action: "allow", target: "deepsonar-gateway-proxy" }],
  });
});

test("OpenSandbox image contract PoC reprovisions and reports leftovers", async () => {
  const result = await runOpenSandboxImageContractPoc({
    async create() {
      return hostSession();
    },
    async connect() {
      return hostSession();
    },
    async list() {
      return [];
    },
  }, { image: "img@sha256:" + "a".repeat(64) });
  assert.equal(result.leftovers, 0);
  assert.ok(result.provisionMs >= 0);
});

test("CLI missing-binary detector ignores model-not-found text", () => {
  assert.equal(isOpenSandboxCliMissing("Model dummy not found\n"), false);
  assert.equal(isOpenSandboxCliMissing("sh: pi: not found\n"), true);
  assert.equal(isOpenSandboxCliMissing("bash: claude: command not found\n"), true);
  assert.equal(isOpenSandboxCliMissing("node: No such file or directory\n"), true);
});

test("OpenSandbox CLI launch PoC starts all adapters and closes stdin", async () => {
  const result = await runOpenSandboxCliLaunchPoc({
    async create() {
      return hostSession();
    },
    async connect() {
      return hostSession();
    },
    async list() {
      return [];
    },
  }, { image: "img@sha256:" + "a".repeat(64) });
  for (const id of ["claude-code", "codex", "open-code", "pi", "dsh"] as const) {
    assert.equal(result[id].started, true);
    assert.equal(result[id].notFound, false);
    assert.equal(result[id].stdinClosed, true);
    assert.equal(result[id].inputWritten, true);
    assert.equal(result[id].steered, true);
  }
});

test("OpenSandbox assets PoC mounts Scheduler volume read-only and reads the seed", async () => {
  const session = hostSession();
  const created: OpenSandboxCreateInput[] = [];
  const client: OpenSandboxClient = {
    async create(input) {
      created.push(input);
      return session;
    },
    async connect(id) {
      return id === session.id ? session : undefined;
    },
    async list() {
      return [];
    },
  };
  const result = await runOpenSandboxAssetsPoc(client, {
    image: "img@sha256:" + "a".repeat(64),
    volumeName: "deepsonar-assets-11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(result, { mounted: true, readonly: true, seedOk: true, leftovers: 0 });
  assert.equal(created[0]?.volumes[0]?.readOnly, true);
  assert.equal(created[0]?.volumes[0]?.pvc.createIfNotExists, false);
});

test("OpenSandbox recovery PoC reconnects a new runner then destroys leftovers", async () => {
  const session = hostSession();
  let present = true;
  session.getState = async () => (present ? "Running" : "Stopped");
  const result = await runOpenSandboxRecoveryPoc({
    async create() {
      return session;
    },
    async connect(id) {
      return id === session.id ? session : undefined;
    },
    async list() {
      return present
        ? [{ resourceId: session.id, jobId: "job", attemptId: "att", state: "Running" }]
        : [];
    },
    async destroy() {
      present = false;
    },
  }, { image: "img@sha256:" + "a".repeat(64) });
  assert.deepEqual(result, {
    alive: true,
    reconnected: true,
    aliveAfterReconnect: true,
    deadAfterDestroy: true,
    leftovers: 0,
  });
});

test("OpenSandbox cancel PoC rejects in-flight provision and reports leftovers", async () => {
  let release: ((session: OpenSandboxSession) => void) | undefined;
  const session = hostSession();
  const client: OpenSandboxClient = {
    create: () => new Promise((resolve) => {
      release = resolve;
    }),
    async connect() {
      return session;
    },
    async list() {
      return [];
    },
  };
  const pending = runOpenSandboxCancelPoc(new OpenSandboxRunner(client), {});
  await Promise.resolve();
  release?.(session);
  const result = await pending;
  assert.deepEqual(result, { cancelled: true, leftovers: 0 });
});
