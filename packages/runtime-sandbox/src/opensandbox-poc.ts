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
): Promise<{ sandboxId: string; stdout: string; listed: boolean }> {
  const session = await client.create({
    image: input.image ?? OPENSANDBOX_POC_IMAGE,
    env: {},
    metadata: { "deepsonar.job": input.jobId, "deepsonar.attempt": input.attemptId },
    resource: { cpu: "1", memory: "256Mi", pids: "64" },
    timeoutSeconds: null,
    networkPolicy: { defaultAction: "deny", egress: [] },
    volumes: [],
  });
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
    };
  } finally {
    await session.kill().catch(() => {});
    await session.close().catch(() => {});
  }
}
