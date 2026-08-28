/**
 * Optional live OpenSandbox server smoke (#162 Phase 2).
 * Default CI stays skip-safe; set OPEN_SANDBOX_POC=1 only when a server is up.
 */
import { randomUUID } from "node:crypto";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import type { ProvisionInput, SandboxRunner } from "./index.js";
import { shellQuote } from "./runtime-host.js";

export const OPENSANDBOX_POC_IMAGE =
  "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
export const OPENSANDBOX_POC_CONTRACT = "deepsonar.runtime.contract/v1";
export const OPENSANDBOX_POC_CLI_IDS = ["claude", "codex", "opencode", "pi", "dsh"] as const;
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

async function collectText(
  process: AsyncIterable<{ type: string; chunk?: string; exitCode?: number }>,
  timeoutMs: number,
  until?: RegExp,
): Promise<{ text: string; exitCode?: number }> {
  const chunks: string[] = [];
  let exitCode: number | undefined;
  const deadline = Date.now() + timeoutMs;
  for await (const event of process) {
    if (Date.now() > deadline) throw new Error("OPENSANDBOX_POC_STREAM_TIMEOUT");
    if (event.type === "stdout" || event.type === "stderr") chunks.push(event.chunk ?? "");
    if (event.type === "exit") exitCode = event.exitCode;
    if (until && until.test(chunks.join(""))) break;
  }
  return { text: chunks.join(""), exitCode };
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
sys.exit(0 if leaked else 1)
`.trim();

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
    const incremental = await host.runAsync("sh -c 'read x; printf %s \"$x\"'", { cwd: "/workspace" });
    await incremental.write("steer\n");
    const incrementalOut = await collectText(incremental, 15_000);
    const incrementalOk = incrementalOut.text.includes("steer");
    const pty = await host.runAsync("sh -c 'read x; printf %s \"$x\"'", { cwd: "/workspace", pty: true });
    if (!pty.resize) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
    await pty.resize(80, 24);
    await pty.write("term\n");
    const ptyOut = await collectText(pty, 15_000);
    await pty.kill().catch(() => {});
    const ptyOk = ptyOut.text.includes("term");
    const term = await runner.openTerminal(handle, { cols: 80, rows: 24 });
    const terminalCollect = collectText(
      (async function* () {
        for await (const chunk of term.output) yield { type: "stdout" as const, chunk };
      })(),
      10_000,
      /term-ok/,
    );
    await term.resize(100, 30);
    await term.write("printf 'term-ok\\n'\n");
    const terminalOut = await terminalCollect;
    await term.close();
    const terminalOk = /term-ok/.test(terminalOut.text);
    const isolated = await host.run(`python3 -c ${shellQuote(NETWORK_ISOLATION_SCRIPT)}`, { timeoutMs: 10_000 });
    const networkIsolated = isolated.exitCode === 1;
    const limitsProbe = await host.run("grep -E '^(CapPrm|CapEff|NoNewPrivs):' /proc/1/status", { timeoutMs: 5_000 });
    const hardLimits = limitsProbe.exitCode === 0
      && /CapPrm:\s*0+\b/.test(limitsProbe.stdout)
      && /CapEff:\s*0+\b/.test(limitsProbe.stdout)
      && /NoNewPrivs:\s*1\b/.test(limitsProbe.stdout);
    const reconnected = new OpenSandboxRunner(client);
    const remote = await reconnected.ensureHost(handle);
    const probe = await remote.run("true", { timeoutMs: 10_000 });
    const clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>> = {};
    for (const id of OPENSANDBOX_POC_CLI_IDS) {
      const found = await remote.run(OPENSANDBOX_POC_CLI_PROBES[id], { timeoutMs: 5_000 });
      clis[id] = found.exitCode === 0;
    }
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
