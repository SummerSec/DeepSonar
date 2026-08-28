/**
 * Live Kubernetes + Kata proof (#162 Phase 3). Skip-safe unless explicitly enabled.
 * Static overlay tests are not a substitute: this fails closed unless a sandbox
 * workload actually uses RuntimeClass=kata-qemu and then cleans leftover pods.
 */
import { randomUUID } from "node:crypto";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import { NETWORK_ISOLATION_SCRIPT, OPENSANDBOX_POC_CONTRACT, OPENSANDBOX_POC_IMAGE } from "./opensandbox-poc.js";
import { shellQuote } from "./runtime-host.js";

export const OPENSANDBOX_K8S_NAMESPACE = "deepsonar-opensandbox";
export const OPENSANDBOX_KATA_RUNTIME_CLASS = "kata-qemu";

const HOST_ESCAPE_PROBE = "test ! -e /var/run/docker.sock && test ! -e /run/containerd/containerd.sock && test ! -e /host/var/run/docker.sock";

export function shouldRunOpenSandboxK8sPoc(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPEN_SANDBOX_POC === "1" && env.OPEN_SANDBOX_POC_K8S === "1";
}

export interface KataClusterProbe {
  runtimeClass: boolean;
  namespace: boolean;
  quota: boolean;
}

export function readKataClusterProbe(resources: {
  runtimeClass?: unknown;
  namespace?: unknown;
  quota?: unknown;
}): KataClusterProbe {
  const runtimeClass = Boolean(
    resources.runtimeClass && typeof resources.runtimeClass === "object"
    && (resources.runtimeClass as { metadata?: { name?: string }; handler?: string }).metadata?.name === OPENSANDBOX_KATA_RUNTIME_CLASS
    && (resources.runtimeClass as { handler?: string }).handler === OPENSANDBOX_KATA_RUNTIME_CLASS,
  );
  const namespace = Boolean(
    resources.namespace && typeof resources.namespace === "object"
    && (resources.namespace as { metadata?: { name?: string } }).metadata?.name === OPENSANDBOX_K8S_NAMESPACE,
  );
  const items = resources.quota && typeof resources.quota === "object" && Array.isArray((resources.quota as { items?: unknown }).items)
    ? (resources.quota as { items: Array<{ metadata?: { name?: string }; spec?: { hard?: Record<string, string> } }> }).items
    : [];
  const quota = items.some((item) => item.metadata?.name === OPENSANDBOX_K8S_NAMESPACE && item.spec?.hard?.pods === "32");
  return { runtimeClass, namespace, quota };
}

export function findKataWorkload(pods: unknown, jobId: string): { name: string; runtimeClassName: string } {
  const items = pods && typeof pods === "object" && Array.isArray((pods as { items?: unknown }).items)
    ? (pods as { items: Array<{ metadata?: { name?: string }; spec?: { runtimeClassName?: string } }> }).items
    : [];
  const match = items.find((item) => JSON.stringify(item).includes(jobId));
  const runtimeClassName = match?.spec?.runtimeClassName ?? "";
  const name = match?.metadata?.name ?? "";
  if (!name) throw new Error("OPENSANDBOX_POC_KATA_WORKLOAD_MISSING");
  if (runtimeClassName !== OPENSANDBOX_KATA_RUNTIME_CLASS) {
    throw new Error(`OPENSANDBOX_POC_KATA_RUNTIMECLASS_NOT_USED: ${runtimeClassName || "none"}`);
  }
  return { name, runtimeClassName };
}

export type KubectlJson = (args: string[]) => Promise<unknown>;

export async function probeKataCluster(kubectl: KubectlJson): Promise<KataClusterProbe> {
  const [runtimeClass, namespace, quota] = await Promise.all([
    kubectl(["get", "runtimeclass", OPENSANDBOX_KATA_RUNTIME_CLASS, "-o", "json"]),
    kubectl(["get", "namespace", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
    kubectl(["get", "resourcequota", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
  ]);
  const probe = readKataClusterProbe({ runtimeClass, namespace, quota });
  if (!probe.runtimeClass) throw new Error("OPENSANDBOX_POC_KATA_RUNTIMECLASS_MISSING");
  if (!probe.namespace || !probe.quota) throw new Error("OPENSANDBOX_POC_K8S_ISOLATION_MISSING");
  return probe;
}

export async function runOpenSandboxK8sPoc(
  client: OpenSandboxClient,
  kubectl: KubectlJson,
  input: { image?: string; expectedContract?: string },
): Promise<{
  kata: true;
  isolated: boolean;
  hostEscapeBlocked: boolean;
  leftovers: number;
  leftoverPods: number;
}> {
  await probeKataCluster(kubectl);
  const runner = new OpenSandboxRunner(client);
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const handle = await runner.provision({
    jobId,
    attemptId,
    image: input.image ?? OPENSANDBOX_POC_IMAGE,
    network: "restricted",
    gatewayUpstreamUrl: "http://gateway.invalid:3100/gateway",
    expectedContract: input.expectedContract ?? OPENSANDBOX_POC_CONTRACT,
    limits: { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
  });
  try {
    findKataWorkload(
      await kubectl(["get", "pods", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
      jobId,
    );
    const host = await runner.ensureHost(handle);
    const isolated = await host.run(`python3 -c ${shellQuote(NETWORK_ISOLATION_SCRIPT)}`, { timeoutMs: 10_000 });
    const escape = await host.run(HOST_ESCAPE_PROBE, { timeoutMs: 10_000 });
    return {
      kata: true,
      isolated: isolated.exitCode === 1,
      hostEscapeBlocked: escape.exitCode === 0,
      leftovers: 0,
      leftoverPods: 0,
    };
  } finally {
    await runner.destroy(handle).catch(() => {});
    const leftovers = await runner.listResources({ jobId, attemptId });
    if (leftovers.length > 0) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
    const remaining = findRemainingJobPods(
      await kubectl(["get", "pods", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
      jobId,
    );
    if (remaining > 0) throw new Error(`OPENSANDBOX_POC_KATA_POD_LEFTOVER: ${remaining}`);
  }
}

export function findRemainingJobPods(pods: unknown, jobId: string): number {
  const items = pods && typeof pods === "object" && Array.isArray((pods as { items?: unknown }).items)
    ? (pods as { items: unknown[] }).items
    : [];
  return items.filter((item) => JSON.stringify(item).includes(jobId)).length;
}
