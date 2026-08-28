/**
 * Optional live OpenSandbox server smoke (#162 Phase 2).
 * Default CI stays skip-safe; set OPEN_SANDBOX_POC=1 only when a server is up.
 */
import type { OpenSandboxClient } from "./opensandbox.js";

export const OPENSANDBOX_POC_IMAGE =
  "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";

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
    expectedContract: "deepsonar.runtime/v1",
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
