/**
 * Live proof that gVisor + OpenSandbox egress sidecar is incompatible (#162 Phase 3).
 * Official docs mention iptables nat is missing; this fails closed unless a real
 * runsc sandbox reproduces that error. A working combo is also fail-closed:
 * we do not silently ship gVisor when the sidecar would start.
 */
export const OPENSANDBOX_GVISOR_RUNSC_VERSION = "release-20251006.0";
export const OPENSANDBOX_GVISOR_RUNSC_URL =
  "https://storage.googleapis.com/gvisor/releases/release/20251006/x86_64/runsc";
export const AGENT_SANDBOX_CRD = "sandboxes.agents.x-k8s.io";

const NAT_UNSUPPORTED_RE = /Failed to initialize nft|table ['"]nat['"]|Protocol not supported/i;

export function shouldRunOpenSandboxGvisorPoc(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_SANDBOX_POC === "1" && env.OPEN_SANDBOX_POC_GVISOR === "1";
}

export function readAgentSandboxCrd(resource: unknown): boolean {
  return Boolean(
    resource && typeof resource === "object"
    && (resource as { metadata?: { name?: string } }).metadata?.name === AGENT_SANDBOX_CRD,
  );
}

export function readGvisorNatProbe(output: string, exitCode: number): { natUnsupported: boolean } {
  return { natUnsupported: exitCode !== 0 && NAT_UNSUPPORTED_RE.test(output) };
}

export type GvisorExec = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export async function runOpenSandboxGvisorPoc(exec: GvisorExec): Promise<{
  compatible: false;
  natUnsupported: true;
  leftovers: 0;
  runscVersion: string;
}> {
  const version = await exec(["--version"]);
  const runscVersion = `${version.stdout}\n${version.stderr}`.trim();
  if (version.exitCode !== 0 || !/runsc version/i.test(runscVersion)) {
    throw new Error(`OPENSANDBOX_POC_GVISOR_RUNSC: ${runscVersion || version.stderr}`);
  }
  const nat = await exec(["--root", "/tmp/runsc-root", "--network", "none", "do", "iptables", "-t", "nat", "-L"]);
  const output = `${nat.stdout}\n${nat.stderr}`;
  if (nat.exitCode === 0) {
    throw new Error("OPENSANDBOX_POC_GVISOR_EGRESS_UNEXPECTED: iptables nat works under gVisor");
  }
  if (!readGvisorNatProbe(output, nat.exitCode).natUnsupported) {
    throw new Error(`OPENSANDBOX_POC_GVISOR_EGRESS_UNKNOWN: ${output.trim()}`);
  }
  return { compatible: false, natUnsupported: true, leftovers: 0, runscVersion };
}
