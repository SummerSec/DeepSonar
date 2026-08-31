import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OPENSANDBOX_POC_CONTRACT,
  OPENSANDBOX_POC_IMAGE,
  OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS,
  listOfficialOpenSandboxRuntimeImages,
  runOpenSandboxAssetsPoc,
  runOpenSandboxCancelPoc,
  runOpenSandboxCliLaunchPoc,
  runOpenSandboxImageContractPoc,
  runOpenSandboxOfficialImagesPoc,
  runOpenSandboxRestrictedPoc,
  runOpenSandboxContractFailPoc,
  runOpenSandboxHostPoc,
  runOpenSandboxArchPoc,
  runOpenSandboxInfrastructurePoc,
  runOpenSandboxRecoveryPoc,
  runOpenSandboxRetryPoc,
  shouldRunOpenSandboxPoc,
  isOpenSandboxCliMissing,
  assertVendorUpstreamPayload,
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

test("vendor model E2E fail-closes HTML or non-JSON upstream payloads", () => {
  assert.doesNotThrow(() => assertVendorUpstreamPayload("application/json", '{"type":"error"}'));
  assert.doesNotThrow(() => assertVendorUpstreamPayload("application/json; charset=utf-8", "\n{\"id\":\"ok\"}"));
  assert.throws(() => assertVendorUpstreamPayload("text/html", "<!doctype html>"), /VENDOR_UPSTREAM_NOT_JSON/);
  assert.throws(() => assertVendorUpstreamPayload("application/json", "<html><body>captcha</body></html>"), /VENDOR_UPSTREAM_NOT_JSON/);
  assert.throws(() => assertVendorUpstreamPayload("text/plain", "ok"), /VENDOR_UPSTREAM_NOT_JSON/);
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

test("OpenSandbox arch PoC pins linux/arm64 and fail-closes a mismatch", async () => {
  const created: OpenSandboxCreateInput[] = [];
  const session: OpenSandboxSession = {
    id: "arch-1",
    async run() {
      return { exitCode: 0, stdout: "aarch64\n", stderr: "" };
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
    async create(input) {
      created.push(input);
      return session;
    },
    async connect() {
      return session;
    },
    async list() {
      return [];
    },
  };
  const result = await runOpenSandboxArchPoc(client, { jobId: "job-1", attemptId: "att-1", arch: "arm64" });
  assert.equal(result.arch, "arm64");
  assert.deepEqual(created[0]?.platform, { os: "linux", arch: "arm64" });
  await assert.rejects(
    () => runOpenSandboxArchPoc(client, { jobId: "job-2", attemptId: "att-2", arch: "amd64" }),
    /OPENSANDBOX_POC_ARCH_MISMATCH/,
  );
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

function fakeSessionArtifact(cli: string, sessionId: string): string {
  if (cli === "claude-code") {
    return [
      JSON.stringify({ type: "user", message: { role: "user", content: "ping" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "pong" }] } }),
      "",
    ].join("\n");
  }
  if (cli === "codex") {
    return [
      JSON.stringify({ type: "thread.started", thread_id: sessionId }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "pong" } }),
      "",
    ].join("\n");
  }
  if (cli === "pi") {
    return [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "pong" }] } }),
      "",
    ].join("\n");
  }
  if (cli === "dsh") {
    return `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        sessionId,
        event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "pong" }] } } },
      },
    })}\n`;
  }
  return JSON.stringify({ id: sessionId, messages: [{ role: "user", content: "ping" }, { role: "assistant", content: "pong" }] });
}

function fakeCliStdout(command: string): string | undefined {
  if (/\bclaude\b/.test(command)) return `${JSON.stringify({ type: "system", subtype: "init", session_id: "poc-claude-session" })}\n`;
  if (/\bcodex\b/.test(command)) return `${JSON.stringify({ type: "thread.started", thread_id: "poc-codex-session" })}\n`;
  if (/\bopencode\b/.test(command)) return `${JSON.stringify({ type: "session.created", sessionID: "poc-opencode-session" })}\n`;
  if (command.includes("pi --mode rpc")) {
    return `${JSON.stringify({
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: "poc-pi-session",
        sessionFile: "/workspace/.deepsonar-home/.pi/agent/poc-pi-session.jsonl",
      },
    })}\n`;
  }
  if (command.includes("dsh-sdk-jsonrpc-demo") || command.includes("packaged-bin.js")) {
    return `${JSON.stringify({ jsonrpc: "2.0", method: "session.status", params: { status: "idle" } })}\n`;
  }
  return undefined;
}

function hostSession(): OpenSandboxSession {
  const files = new Map<string, string>([["/workspace/poc-note.txt", "note"]]);
  return {
    id: "host-1",
    async run(command) {
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime.contract/v1" }), stderr: "" };
      }
      if (command === "cat /proc/mounts") {
        return { exitCode: 0, stdout: "/dev/sda /workspace/.deepsonar/shared ext4 ro 0 0\n", stderr: "" };
      }
      if (command.includes("poc-seed.txt")) return { exitCode: 0, stdout: "seed\n", stderr: "" };
      if (command.includes("poc-write")) return { exitCode: 1, stdout: "", stderr: "Read-only file system" };
      if (command.includes("shared") && command.includes("mounted")) return { exitCode: 0, stdout: "mounted\n", stderr: "" };
      if (command.includes(".claude/projects")) {
        const match = command.match(/-name '([^']+)\.jsonl'/);
        const sessionId = match?.[1] ?? "poc-claude-session";
        return { exitCode: 0, stdout: `/root/.claude/projects/poc/${sessionId}.jsonl\n`, stderr: "" };
      }
      if (command.includes(".codex") && command.includes("sessions")) {
        const match = command.match(/grep -l -m1 -- '([^']+)'/);
        const sessionId = match?.[1] ?? "poc-codex-session";
        return { exitCode: 0, stdout: `/root/.codex/sessions/${sessionId}.jsonl\n`, stderr: "" };
      }
      if (command.includes("opencode export")) {
        const match = command.match(/opencode export '([^']+)'/);
        const sessionId = match?.[1] ?? "poc-opencode-session";
        return { exitCode: 0, stdout: fakeSessionArtifact("open-code", sessionId), stderr: "" };
      }
      if (command.includes(".dsh/sessions")) {
        const match = command.match(/-path '\*\/([^']+)\/session\.jsonl'/);
        const sessionId = match?.[1] ?? "session-poc162";
        return { exitCode: 0, stdout: `/workspace/.deepsonar-home/.dsh/sessions/proj/${sessionId}/session.jsonl\n`, stderr: "" };
      }
      const cat = command.match(/cat -- ("(?:\\.|[^"])+")/);
      if (cat) {
        const filePath = JSON.parse(cat[1]!) as string;
        if (filePath.includes("/.claude/")) return { exitCode: 0, stdout: fakeSessionArtifact("claude-code", filePath), stderr: "" };
        if (filePath.includes("/.codex/")) return { exitCode: 0, stdout: fakeSessionArtifact("codex", filePath), stderr: "" };
        if (filePath.includes("/.pi/")) return { exitCode: 0, stdout: fakeSessionArtifact("pi", filePath), stderr: "" };
        if (filePath.includes("/.dsh/")) return { exitCode: 0, stdout: fakeSessionArtifact("dsh", "session-poc162"), stderr: "" };
      }
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
    async runAsync(command) {
      const cliOut = fakeCliStdout(command);
      return {
        async write() {},
        async closeStdin() {},
        async kill() {},
        async resize() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "stdout" as const, chunk: cliOut ?? "steerterm-ok hello-complete.txt ^C" };
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

test("official OpenSandbox image list requires pinned registry keys", () => {
  const digest = "a".repeat(64);
  const images = OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS.map((key) => ({
    image_key: key,
    versions: [{ registry_refs: { dockerhub: `docker.io/sumsec/deepsonar@sha256:${digest}` } }],
  }));
  const listed = listOfficialOpenSandboxRuntimeImages({ images });
  assert.equal(listed.length, OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS.length);
  assert.equal(listed[0]?.image, `docker.io/sumsec/deepsonar@sha256:${digest}`);
  assert.throws(
    () => listOfficialOpenSandboxRuntimeImages({ images: images.slice(1) }),
    /OPENSANDBOX_POC_REGISTRY_MISSING/,
  );
  assert.throws(
    () => listOfficialOpenSandboxRuntimeImages({ images: [{ image_key: "deepsonar-base", versions: [{ image_ref: "latest" }] }] }),
    /OPENSANDBOX_POC_REGISTRY_UNPINNED/,
  );
});

test("deploy registry lists required OpenSandbox images and extra official keys", () => {
  const registry = JSON.parse(readFileSync(new URL("../../../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
  const listed = listOfficialOpenSandboxRuntimeImages(registry);
  for (const key of OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS) {
    assert.ok(listed.some((item) => item.key === key), key);
  }
  assert.ok(listed.some((item) => item.key === "deepsonar-mobile"), "deepsonar-mobile");
  assert.ok(listed.length >= OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS.length + 1);
});

test("official OpenSandbox image PoC requires all five CLIs", async () => {
  const present = hostSession();
  const originalRun = present.run.bind(present);
  present.run = async (command, options) => {
    if (command.startsWith("command -v ") || command.startsWith("test -f ")) {
      return { exitCode: 0, stdout: "/usr/bin/cli\n", stderr: "" };
    }
    return originalRun(command, options);
  };
  const ok = await runOpenSandboxOfficialImagesPoc({
    async create() {
      return present;
    },
    async connect() {
      return present;
    },
    async list() {
      return [];
    },
  }, [{ key: "deepsonar-base", image: "img@sha256:" + "a".repeat(64) }]);
  assert.equal(ok[0]?.leftovers, 0);
  assert.equal(ok[0]?.clis.claude, true);

  await assert.rejects(
    () => runOpenSandboxOfficialImagesPoc({
      async create() {
        return hostSession();
      },
      async connect() {
        return hostSession();
      },
      async list() {
        return [];
      },
    }, [{ key: "deepsonar-base", image: "img@sha256:" + "a".repeat(64) }]),
    /OPENSANDBOX_POC_IMAGE_CLI_MISSING/,
  );
});

test("OpenSandbox image contract PoC retries proxy exec flakes", () => {
  const source = readFileSync(new URL("./opensandbox-poc.ts", import.meta.url), "utf8");
  assert.match(source, /IMAGE_CONTRACT_TRANSIENT/);
  assert.match(source, /SANDBOX_NOT_FOUND\|Sandbox \[\\w-\]\+ not found/);
  assert.match(source, /runOpenSandboxImageContractOnce/);
  assert.match(source, /timeoutMs: 15_000/);
  assert.match(source, /attempt < 5/);
  assert.match(source, /2_000 \* \(attempt \+ 1\)/);
  assert.match(source, /attempt < 3/);
});

test("OpenSandbox image contract PoC re-provisions after SANDBOX_NOT_FOUND", async () => {
  let creates = 0;
  const dead = hostSession();
  const deadRun = dead.run.bind(dead);
  dead.run = async (command, options) => {
    if (command.startsWith("command -v ")) throw new Error("Sandbox ce7ab2bd-c539-4d5a-9762-5610f7e67807 not found.");
    return deadRun(command, options);
  };
  const live = hostSession();
  const liveRun = live.run.bind(live);
  live.run = async (command, options) => {
    if (command.startsWith("command -v ")) return { exitCode: 0, stdout: "/usr/bin/cli\n", stderr: "" };
    return liveRun(command, options);
  };
  const result = await runOpenSandboxImageContractPoc({
    async create() {
      creates += 1;
      return creates === 1 ? dead : live;
    },
    async connect() {
      return creates === 1 ? dead : live;
    },
    async list() {
      return [];
    },
  }, { image: "img@sha256:" + "a".repeat(64) });
  assert.equal(creates, 2);
  assert.equal(result.leftovers, 0);
  assert.equal(result.clis.claude, true);
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

test("OpenSandbox CLI launch PoC materializes governed provider files under runtime HOME", () => {
  const source = readFileSync(new URL("./opensandbox-poc.ts", import.meta.url), "utf8");
  assert.match(source, /runtimeCliEnv/);
  assert.match(source, /\.codex\/config\.toml/);
  assert.match(source, /\.pi\/agent\/models\.json/);
  assert.match(source, /openai-responses/);
  assert.match(source, /wire_api = "responses"/);
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
    assert.ok(result[id].sessionId, `${id} should capture session_id`);
    assert.equal(result[id].archived, true);
    assert.ok(result[id].archiveCount > 0);
    assert.equal(result[id].resumed, true);
    assert.ok(result[id].artifacts[0]?.content);
    if (id === "pi") assert.match(result[id].sessionFile ?? "", /\/workspace\/\.deepsonar-home\/\.pi\/agent\//);
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
    inspectSharedAssetsVolume: async () => {},
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
    async list(filter) {
      return present
        ? [{
            resourceId: session.id,
            jobId: filter?.jobId ?? "11111111-1111-4111-8111-111111111111",
            attemptId: filter?.attemptId ?? "22222222-2222-4222-8222-222222222222",
            state: "Running",
          }]
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

function retryCliOf(command: string): "claude-code" | "codex" | "open-code" | "pi" | "dsh" | undefined {
  if (/\bclaude\b/.test(command)) return "claude-code";
  if (/\bcodex\b/.test(command)) return "codex";
  if (/\bopencode\b/.test(command)) return "open-code";
  if (command.includes("pi --mode rpc")) return "pi";
  if (command.includes("dsh-sdk-jsonrpc-demo") || command.includes("packaged-bin.js")) return "dsh";
  return undefined;
}

function retryLines(
  cli: NonNullable<ReturnType<typeof retryCliOf>>,
  phase: "fail" | "ok",
  status: 503 | 401,
): Record<string, unknown>[] {
  const sessionId = `retry-${cli}`;
  const err = status === 503 ? "upstream status: 503" : "HTTP 401 unauthorized";
  if (cli === "claude-code") {
    const init = { type: "system", subtype: "init", session_id: sessionId };
    return phase === "ok"
      ? [init, { type: "result", subtype: "success", result: "ok" }]
      : [init, { type: "result", subtype: "error", is_error: true, result: err }];
  }
  if (cli === "codex") {
    const init = { type: "thread.started", thread_id: sessionId };
    return phase === "ok"
      ? [init, { type: "turn.completed", result: "ok" }]
      : [init, { type: "error", message: err }];
  }
  if (cli === "open-code") {
    const init = { type: "session.created", sessionID: sessionId };
    return phase === "ok"
      ? [init, { type: "run.completed", result: "ok" }]
      : [init, { type: "run.failed", error: err }];
  }
  if (cli === "pi") {
    const state = {
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId, sessionFile: `/workspace/.deepsonar-home/.pi/agent/${sessionId}.jsonl` },
    };
    return phase === "ok"
      ? [state, { type: "message_end", message: { content: [{ type: "text", text: "ok" }] } }, { type: "agent_settled" }]
      : [state, { type: "error", message: err }];
  }
  return phase === "ok"
    ? [{ jsonrpc: "2.0", method: "session.status", params: { status: "idle", sessionId: "session-poc162" } }]
    : [{ jsonrpc: "2.0", id: "deepsonar-initialize-1", error: { message: err } }];
}

function retrySession(status: 503 | 401): OpenSandboxSession & { commands: string[] } {
  const base = hostSession();
  const commands: string[] = [];
  const starts = new Map<string, number>();
  return {
    ...base,
    commands,
    async runAsync(command) {
      commands.push(command);
      const cli = retryCliOf(command);
      if (!cli) return base.runAsync(command);
      const count = (starts.get(cli) ?? 0) + 1;
      starts.set(cli, count);
      const resume = count > 1;
      const lines = retryLines(cli, resume && status === 503 ? "ok" : "fail", status);
      return {
        async write() {},
        async closeStdin() {},
        async kill() {},
        async resize() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "stdout" as const, chunk: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` };
          yield { type: "exit" as const, exitCode: resume && status === 503 ? 0 : 1 };
        },
      };
    },
  };
}

function retryClient(session: OpenSandboxSession): OpenSandboxClient {
  return {
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
}

test("OpenSandbox runRealAgent retries a transient 503 on the same session for every CLI", async () => {
  const image = "img@sha256:" + "a".repeat(64);
  for (const provider of ["claude-code", "codex", "open-code", "pi", "dsh"] as const) {
    const session = retrySession(503);
    const result = await runOpenSandboxRetryPoc(retryClient(session), { image, provider });
    assert.equal(result.retrying, true, provider);
    assert.equal(result.reason, "http", provider);
    assert.equal(result.skipped, false, provider);
    assert.equal(result.leftovers, 0, provider);
    assert.equal(result.terminalOutcome, "success", provider);
    if (provider === "claude-code") {
      assert.ok(session.commands.some((command) => command.includes("--resume 'retry-claude-code'")), provider);
    } else if (provider === "codex") {
      assert.ok(session.commands.some((command) => /exec resume 'retry-codex'/.test(command)), provider);
    } else if (provider === "open-code") {
      assert.ok(session.commands.some((command) => command.includes("--session 'retry-open-code'")), provider);
    } else if (provider === "pi") {
      assert.ok(session.commands.some((command) => command.includes("--session '/workspace/.deepsonar-home/.pi/agent/retry-pi.jsonl'")), provider);
    } else {
      assert.ok(session.commands.filter((command) => command.includes("packaged-bin.js")).length >= 2, provider);
    }
  }
});

test("runRealAgent captures CLI session identity through applyRuntimeOutput", () => {
  const source = readFileSync(new URL("./runtime-agent.ts", import.meta.url), "utf8");
  assert.match(source, /applyRuntimeOutput\(adapter, rawParsed, adapterState\)/);
  assert.doesNotMatch(source, /const decodedEvents = adapter\.decodeOutput\(rawParsed, adapterState\)/);
});

test("OpenSandbox runRealAgent does not resume a permanent 401 for any CLI", async () => {
  const image = "img@sha256:" + "a".repeat(64);
  for (const provider of ["claude-code", "codex", "open-code", "pi", "dsh"] as const) {
    const session = retrySession(401);
    const result = await runOpenSandboxRetryPoc(retryClient(session), { image, provider });
    assert.equal(result.retrying, false, provider);
    assert.equal(result.skipped, false, provider);
    assert.equal(result.leftovers, 0, provider);
    assert.equal(result.terminalOutcome, "failure", provider);
    assert.equal(
      session.commands.some((command) => /--resume|exec resume |--session /.test(command)),
      false,
      provider,
    );
  }
});
