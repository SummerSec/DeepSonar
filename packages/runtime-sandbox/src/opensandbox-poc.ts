/**
 * Optional live OpenSandbox server smoke (#162 Phase 2).
 * Default CI stays skip-safe; set OPEN_SANDBOX_POC=1 only when a server is up.
 */
import { randomUUID } from "node:crypto";
import { SHARED_ASSETS_MOUNT_PATH } from "./agentbox.js";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import type { ProvisionInput, SandboxRunner } from "./index.js";
import { AGENT_CLI_RUNTIME_ADAPTERS, type AgentCliId } from "./runtime-adapters.js";
import { shellQuote } from "./runtime-host.js";

export const OPENSANDBOX_POC_IMAGE =
  "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
export const OPENSANDBOX_POC_CONTRACT = "deepsonar.runtime.contract/v1";
export const OPENSANDBOX_POC_CLI_IDS = ["claude", "codex", "opencode", "pi", "dsh"] as const;
export const OPENSANDBOX_POC_ADAPTER_IDS = ["claude-code", "codex", "open-code", "pi", "dsh"] as const satisfies readonly AgentCliId[];

export function isOpenSandboxCliMissing(text: string): boolean {
  return /command not found|No such file or directory|(?:^|[\n\r])(?:\/bin\/)?(?:ba)?sh: [^\n]* not found/i.test(text);
}
const OPENSANDBOX_POC_CLI_PROBES: Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], string> = {
  claude: "command -v claude",
  codex: "command -v codex",
  opencode: "command -v opencode",
  pi: "command -v pi",
  dsh: "test -f /usr/local/lib/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js",
};

export function shouldRunOpenSandboxPoc(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_SANDBOX_POC === "1";
}

export async function runOpenSandboxInfrastructurePoc(
  client: OpenSandboxClient,
  input: { jobId: string; attemptId: string; image?: string },
): Promise<{ sandboxId: string; stdout: string; listed: boolean; createMs: number }> {
  const started = Date.now();
  const session = await client.create({
    image: input.image ?? OPENSANDBOX_POC_IMAGE,
    env: {},
    metadata: { "deepsonar.job": input.jobId, "deepsonar.attempt": input.attemptId },
    resource: { cpu: "1", memory: "256Mi", pids: "64" },
    timeoutSeconds: null,
    networkPolicy: { defaultAction: "deny", egress: [] },
    volumes: [],
  });
  const createMs = Date.now() - started;
  try {
    const probe = await session.run("echo poc", { timeoutMs: 15_000 });
    if (probe.exitCode !== 0) {
      throw new Error(`OPENSANDBOX_POC_EXEC_FAILED: ${probe.stderr || probe.stdout}`);
    }
    const listed = await client.list({ jobId: input.jobId, attemptId: input.attemptId });
    return {
      sandboxId: session.id,
      stdout: probe.stdout.trim(),
      listed: listed.some((item) => item.resourceId === session.id),
      createMs,
    };
  } finally {
    await session.kill().catch(() => {});
    await session.close().catch(() => {});
  }
}

export async function runOpenSandboxContractFailPoc(
  runner: { provision: (input: import("./index.js").ProvisionInput) => Promise<unknown>; listResources: (filter?: { jobId?: string; attemptId?: string }) => Promise<Array<{ resourceId: string }>> },
  input: { jobId: string; attemptId: string; image?: string },
): Promise<{ rejected: true; leftovers: number }> {
  await runner.provision({
    jobId: input.jobId,
    attemptId: input.attemptId,
    image: input.image ?? OPENSANDBOX_POC_IMAGE,
    network: "none",
    limits: { cpu: 1, memoryMiB: 256, pidsLimit: 64, capDropAll: true, noNewPrivileges: true },
    expectedContract: OPENSANDBOX_POC_CONTRACT,
  }).then(
    () => {
      throw new Error("OPENSANDBOX_POC_CONTRACT_SHOULD_FAIL");
    },
    (error) => {
      if (!(error instanceof Error) || !/contract|tool manifest|RUNTIME_IMAGE/i.test(error.message)) {
        throw error;
      }
    },
  );
  const leftovers = await runner.listResources({ jobId: input.jobId, attemptId: input.attemptId });
  return { rejected: true, leftovers: leftovers.length };
}

const hostLimits = { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true };

function ids(): { jobId: string; attemptId: string } {
  return { jobId: randomUUID(), attemptId: randomUUID() };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function collectText(
  process: AsyncIterable<{ type: string; chunk?: string; exitCode?: number }>,
  timeoutMs: number,
  until?: RegExp,
): Promise<{ text: string; exitCode?: number }> {
  const chunks: string[] = [];
  let exitCode: number | undefined;
  const iterator = process[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timedOut = false;
    const next = await Promise.race([
      iterator.next(),
      waitMs(remaining).then(() => {
        timedOut = true;
        return { done: true as const, value: undefined };
      }),
    ]);
    if (timedOut) break;
    if (next.done) break;
    const event = next.value;
    if (!event) break;
    if (event.type === "stdout" || event.type === "stderr") chunks.push(event.chunk ?? "");
    if (event.type === "exit") exitCode = event.exitCode;
    if (until && until.test(chunks.join(""))) break;
  }
  const text = chunks.join("");
  if (until && !until.test(text) && exitCode === undefined && Date.now() >= deadline) {
    throw new Error("OPENSANDBOX_POC_STREAM_TIMEOUT");
  }
  return { text, exitCode };
}

const NETWORK_ISOLATION_SCRIPT = `
import socket, sys
def tcp(host, port, family=socket.AF_INET):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()
leaked = tcp("192.0.2.1", 80)
try:
    leaked = leaked or tcp("2001:db8::1", 80, socket.AF_INET6)
except OSError:
    pass
try:
    socket.getaddrinfo("this-name-should-not-resolve.invalid", 80)
    leaked = True
except socket.gaierror:
    pass
try:
    s = socket.create_connection(("192.0.2.1", 80), 2)
    s.sendall(b"CONNECT 192.0.2.1:443 HTTP/1.1\\r\\nHost: 192.0.2.1\\r\\n\\r\\n")
    leaked = True
except OSError:
    pass
sys.exit(0 if leaked else 1)
`.trim();

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("OPENSANDBOX_POC_STREAM_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function runOpenSandboxHostPoc(
  client: OpenSandboxClient,
  input: { image: string; apiKey?: string },
): Promise<{
  sandboxId: string;
  provisionMs: number;
  fileOk: boolean;
  reservedRejected: boolean;
  symlinkRejected: boolean;
  oversizedRejected: boolean;
  pathEscapeRejected: boolean;
  envClean: boolean;
  incrementalOk: boolean;
  ptyOk: boolean;
  terminalOk: boolean;
  tabOk: boolean;
  interruptOk: boolean;
  closedOnDestroy: boolean;
  networkIsolated: boolean;
  hardLimits: boolean;
  reconnected: boolean;
  leftovers: number;
  clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>>;
}> {
  const runner = new OpenSandboxRunner(client);
  const { jobId, attemptId } = ids();
  const started = Date.now();
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image,
    network: "none",
    limits: hostLimits,
    expectedContract: OPENSANDBOX_POC_CONTRACT,
  });
  const provisionMs = Date.now() - started;
  try {
    const host = await runner.ensureHost(handle);
    await host.uploadFile("note", "/workspace/poc-note.txt");
    const fileOk = (await host.readWorkspaceFile("/workspace/poc-note.txt", 32)).toString() === "note";
    let reservedRejected = false;
    await host.readWorkspaceFile("/workspace/.deepsonar/secret", 32).catch((error) => {
      reservedRejected = error instanceof Error && /forbidden/.test(error.message);
    });
    let pathEscapeRejected = false;
    await host.readWorkspaceFile("/etc/passwd", 32).catch((error) => {
      pathEscapeRejected = error instanceof Error && /forbidden/.test(error.message);
    });
    await host.run("ln -s /etc/passwd /workspace/poc-link", { timeoutMs: 5_000 });
    let symlinkRejected = false;
    await host.readWorkspaceFile("/workspace/poc-link", 32).catch((error) => {
      symlinkRejected = error instanceof Error && /not_regular|forbidden/.test(error.message);
    });
    await host.uploadFile("x".repeat(64), "/workspace/poc-big.txt");
    let oversizedRejected = false;
    await host.readWorkspaceFile("/workspace/poc-big.txt", 8).catch((error) => {
      oversizedRejected = error instanceof Error && /too_large/.test(error.message);
    });
    const env = await host.run("sh -c 'env'", { timeoutMs: 10_000 });
    const envClean = env.exitCode === 0
      && !/OPEN[_-]?SANDBOX[_-]?API[_-]?KEY|OPENSANDBOX_SERVER_API_KEY/i.test(env.stdout)
      && (!input.apiKey || !env.stdout.includes(input.apiKey));
    const incremental = await host.runAsync("python3 -c 'import sys; sys.stdout.write(sys.stdin.readline()); sys.stdout.flush()'", { cwd: "/workspace" });
    const incrementalCollect = collectText(incremental, 15_000, /steer/);
    await incremental.write("steer\n");
    const incrementalOut = await incrementalCollect;
    const incrementalOk = incrementalOut.text.includes("steer");
    const pty = await host.runAsync("python3 -c 'import sys; sys.stdout.write(sys.stdin.readline()); sys.stdout.flush()'", { cwd: "/workspace", pty: true });
    if (!pty.resize) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
    const ptyCollect = collectText(pty, 15_000, /term/);
    await pty.resize(80, 24);
    await pty.write("term\n");
    const ptyOut = await ptyCollect;
    await pty.kill().catch(() => {});
    const ptyOk = ptyOut.text.includes("term");
    await host.uploadFile("ok", "/workspace/hello-complete.txt");
    const term = await runner.openTerminal(handle, { cols: 80, rows: 24 });
    let terminalText = "";
    const terminalCollect = (async () => {
      for await (const chunk of term.output) terminalText += chunk;
    })();
    await term.resize(100, 30);
    await term.write("printf 'term-ok\\n'\n");
    await waitUntil(() => /term-ok/.test(terminalText), 10_000);
    const terminalOk = /term-ok/.test(terminalText);
    await term.write("cat hel\t");
    if (!/hello-complete/.test(terminalText)) {
      await waitUntil(() => /hello-complete/.test(terminalText), 8_000).catch(() => {});
    }
    const tabOk = /hello-complete/.test(terminalText);
    const interruptMark = terminalText.length;
    await term.write("\x03");
    await term.write("sleep 30\n");
    await term.write("\x03");
    if (!/\^C/.test(terminalText)) {
      await waitUntil(
        () => terminalText.length > interruptMark && /[$#>]/.test(terminalText.slice(interruptMark)),
        8_000,
      ).catch(() => {});
    }
    const interruptOk = /\^C/.test(terminalText) || terminalText.length > interruptMark;
    await term.close();
    await terminalCollect.catch(() => {});
    const isolated = await host.run(`python3 -c ${shellQuote(NETWORK_ISOLATION_SCRIPT)}`, { timeoutMs: 10_000 });
    const networkIsolated = isolated.exitCode === 1;
    const limitsProbe = await host.run("grep -E '^(CapPrm|CapEff|NoNewPrivs):' /proc/1/status", { timeoutMs: 5_000 });
    const hardLimits = limitsProbe.exitCode === 0
      && /CapPrm:\s*0+/.test(limitsProbe.stdout)
      && /CapEff:\s*0+/.test(limitsProbe.stdout)
      && /NoNewPrivs:\s*1/.test(limitsProbe.stdout);
    const reconnected = new OpenSandboxRunner(client);
    const remote = await reconnected.ensureHost(handle);
    const probe = await remote.run("true", { timeoutMs: 10_000 });
    const clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>> = {};
    for (const id of OPENSANDBOX_POC_CLI_IDS) {
      const found = await remote.run(OPENSANDBOX_POC_CLI_PROBES[id], { timeoutMs: 5_000 });
      clis[id] = found.exitCode === 0;
    }
    const dying = await runner.openTerminal(handle, { cols: 80, rows: 24 });
    await runner.destroy(handle);
    let closedOnDestroy = false;
    await dying.write("x").catch((error) => {
      closedOnDestroy = error instanceof Error && /CLOSED/.test(error.message);
    });
    return {
      sandboxId: handle.sandboxId,
      provisionMs,
      fileOk,
      reservedRejected,
      symlinkRejected,
      oversizedRejected,
      pathEscapeRejected,
      envClean,
      incrementalOk,
      ptyOk,
      terminalOk,
      tabOk,
      interruptOk,
      closedOnDestroy,
      networkIsolated,
      hardLimits,
      reconnected: probe.exitCode === 0,
      leftovers: 0,
      clis,
    };
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
  }
}

export async function runOpenSandboxCancelPoc(
  runner: SandboxRunner,
  input: { image?: string },
): Promise<{ cancelled: true; leftovers: number }> {
  const { jobId, attemptId } = ids();
  const abort = new AbortController();
  const provision = runner.provision({
    jobId,
    attemptId,
    image: input.image ?? OPENSANDBOX_POC_IMAGE,
    network: "none",
    limits: hostLimits,
    signal: abort.signal,
  } satisfies ProvisionInput);
  abort.abort();
  await provision.then(
    () => {
      throw new Error("OPENSANDBOX_POC_CANCEL_SHOULD_REJECT");
    },
    (error) => {
      if (!(error instanceof Error) || !/已取消/.test(error.message)) throw error;
    },
  );
  const leftovers = await runner.listResources({ jobId, attemptId });
  return { cancelled: true, leftovers: leftovers.length };
}

export async function runOpenSandboxRestrictedPoc(
  client: OpenSandboxClient,
  input: { image: string; gatewayUpstreamUrl?: string },
): Promise<{ isolated: boolean; leftovers: number }> {
  const runner = new OpenSandboxRunner(client);
  const { jobId, attemptId } = ids();
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image,
    network: "restricted",
    gatewayUpstreamUrl: input.gatewayUpstreamUrl ?? "http://gateway.invalid:3100/gateway",
    limits: hostLimits,
    expectedContract: OPENSANDBOX_POC_CONTRACT,
  });
  try {
    const host = await runner.ensureHost(handle);
    const isolated = await host.run(`python3 -c ${shellQuote(NETWORK_ISOLATION_SCRIPT)}`, { timeoutMs: 10_000 });
    return { isolated: isolated.exitCode === 1, leftovers: 0 };
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
  }
}

export async function runOpenSandboxImageContractPoc(
  client: OpenSandboxClient,
  input: { image: string },
): Promise<{ provisionMs: number; clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>>; leftovers: number }> {
  const runner = new OpenSandboxRunner(client);
  const { jobId, attemptId } = ids();
  const started = Date.now();
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image,
    network: "none",
    limits: hostLimits,
    expectedContract: OPENSANDBOX_POC_CONTRACT,
  });
  const provisionMs = Date.now() - started;
  try {
    const host = await runner.ensureHost(handle);
    const clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>> = {};
    for (const id of OPENSANDBOX_POC_CLI_IDS) {
      const found = await host.run(OPENSANDBOX_POC_CLI_PROBES[id], { timeoutMs: 5_000 });
      clis[id] = found.exitCode === 0;
    }
    return { provisionMs, clis, leftovers: 0 };
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
  }
}

export async function runOpenSandboxCliLaunchPoc(
  client: OpenSandboxClient,
  input: { image: string },
): Promise<Record<(typeof OPENSANDBOX_POC_ADAPTER_IDS)[number], { started: boolean; notFound: boolean; stdinClosed: boolean }>> {
  const runner = new OpenSandboxRunner(client);
  const { jobId, attemptId } = ids();
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image,
    network: "none",
    limits: hostLimits,
    expectedContract: OPENSANDBOX_POC_CONTRACT,
  });
  try {
    const host = await runner.ensureHost(handle);
    await host.run(
      "mkdir -p /workspace/.deepsonar /workspace/.deepsonar-home/.pi/agent /workspace/.opencode && printf '%s\\n' '{\"mcpServers\":{}}' > /workspace/.deepsonar/mcp.json",
      { timeoutMs: 5_000 },
    );
    const alive = await runner.isAlive(handle);
    if (!alive) throw new Error("OPENSANDBOX_POC_NOT_ALIVE");
    const launched = {} as Record<(typeof OPENSANDBOX_POC_ADAPTER_IDS)[number], { started: boolean; notFound: boolean; stdinClosed: boolean }>;
    for (const id of OPENSANDBOX_POC_ADAPTER_IDS) {
      const adapter = AGENT_CLI_RUNTIME_ADAPTERS[id];
      const context = {
        host,
        env: {},
        cwd: "/workspace",
        model: "dummy",
        input: "ping",
        mcpConfigPath: "/workspace/.deepsonar/mcp.json",
        dshProvider: { provider: "dummy", model: "dummy", config: { providers: { dummy: { type: "dummy" } } } },
      };
      await adapter.materialize?.(context);
      const process = await adapter.start(context);
      const state = {
        model: "dummy",
        modelProvider: "dummy",
        cwd: "/workspace",
        contextIdentity: {
          context_id: "poc162",
          context_revision: 0,
          adapter_id: id,
          adapter_version: adapter.version,
          runtime_identity: "poc",
          transform_chain_digest: "0",
        },
      };
      let stdinClosed = true;
      const payload = adapter.encodeInput("ping", state);
      if (payload) await process.write(payload).catch(() => { stdinClosed = false; });
      await process.closeStdin().catch(() => { stdinClosed = false; });
      const out = await collectText(process, 4_000);
      await process.kill().catch(() => {});
      launched[id] = {
        started: true,
        notFound: isOpenSandboxCliMissing(out.text),
        stdinClosed,
      };
    }
    return launched;
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
  }
}

export async function runOpenSandboxAssetsPoc(
  client: OpenSandboxClient,
  input: { image: string; volumeName: string; jobId?: string; attemptId?: string },
): Promise<{ mounted: boolean; readonly: boolean; seedOk: boolean; leftovers: number }> {
  const runner = new OpenSandboxRunner(client);
  const jobId = input.jobId ?? ids().jobId;
  const attemptId = input.attemptId ?? ids().attemptId;
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image,
    network: "none",
    limits: hostLimits,
    expectedContract: OPENSANDBOX_POC_CONTRACT,
    sharedAssetsMount: { volumeName: input.volumeName },
  });
  try {
    const host = await runner.ensureHost(handle);
    const mounted = await host.run(`test -d ${SHARED_ASSETS_MOUNT_PATH} && echo mounted`, { timeoutMs: 5_000 });
    const seed = await host.run(`cat ${SHARED_ASSETS_MOUNT_PATH}/poc-seed.txt`, { timeoutMs: 5_000 });
    const write = await host.run(`touch ${SHARED_ASSETS_MOUNT_PATH}/poc-write`, { timeoutMs: 5_000 });
    return {
      mounted: mounted.exitCode === 0 && mounted.stdout.includes("mounted"),
      readonly: write.exitCode !== 0,
      seedOk: seed.exitCode === 0 && seed.stdout.includes("seed"),
      leftovers: 0,
    };
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
  }
}
