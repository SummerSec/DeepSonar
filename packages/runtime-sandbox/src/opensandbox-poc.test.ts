import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENSANDBOX_POC_IMAGE,
  runOpenSandboxContractFailPoc,
  runOpenSandboxInfrastructurePoc,
  shouldRunOpenSandboxPoc,
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
