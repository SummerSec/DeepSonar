/**
 * Gateway hostname bind (#346). OpenSandbox SDK 0.1.11 cannot inject ExtraHosts
 * at create time. `/etc/hosts` is root-owned, so images that end with
 * `USER deepsonar` cannot append it via execd. Host-side uid 0 writes the
 * mapping; the guest only verifies with a world-readable grep.
 */
import { docker } from "./runtime-docker.js";
import { shellQuote } from "./runtime-host.js";

export const GATEWAY_HOSTS_BIND_ERROR_PREFIX = "failed to bind deepsonar-gateway-proxy in sandbox hosts as root";

export function gatewayHostsBindError(detail: string): Error {
  return new Error(`${GATEWAY_HOSTS_BIND_ERROR_PREFIX}: ${detail}`);
}

export function sandboxGatewayHostsBindCommand(hostname: string, ip: string): string {
  return `grep -F ${shellQuote(hostname)} /etc/hosts >/dev/null || printf '%s %s\\n' ${shellQuote(ip)} ${shellQuote(hostname)} >> /etc/hosts`;
}

export function sandboxGatewayHostsVerifyCommand(hostname: string): string {
  return `grep -F ${shellQuote(hostname)} /etc/hosts >/dev/null`;
}

export async function applyDockerSandboxHostsBind(input: {
  sandboxId: string;
  hostname: string;
  ip: string;
  docker?: (...args: string[]) => Promise<string>;
}): Promise<void> {
  const run = input.docker ?? docker;
  const cmd = sandboxGatewayHostsBindCommand(input.hostname, input.ip);
  const names = [`sandbox-${input.sandboxId}`, input.sandboxId];
  let lastError: unknown;
  for (const name of names) {
    try {
      await run("exec", "-u", "0", name, "sh", "-c", cmd);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "sandbox container not found");
  throw gatewayHostsBindError(detail);
}
