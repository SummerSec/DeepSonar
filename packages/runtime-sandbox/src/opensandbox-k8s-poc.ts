/**
 * Live Kubernetes + Kata proof (#162 Phase 3). Skip-safe unless explicitly enabled.
 * Static overlay tests are not a substitute: this fails closed unless a sandbox
 * workload actually uses RuntimeClass=kata-qemu, network isolation and host-escape
 * probes succeed, OpenSandbox credentials stay out of the guest env, hard limits
 * are visible, and leftover pods are cleaned.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindGatewayProxyToKubernetesService } from "./kubernetes-gateway.js";
import { OpenSandboxRunner, type OpenSandboxClient } from "./opensandbox.js";
import { NETWORK_ISOLATION_SCRIPT, OPENSANDBOX_POC_CONTRACT, OPENSANDBOX_POC_IMAGE } from "./opensandbox-poc.js";
import { readAgentSandboxCrd } from "./opensandbox-gvisor-poc.js";
import { shellQuote } from "./runtime-host.js";

export { readServiceClusterIP } from "./kubernetes-gateway.js";

export const OPENSANDBOX_K8S_NAMESPACE = "deepsonar-opensandbox";
export const OPENSANDBOX_KATA_RUNTIME_CLASS = "kata-qemu";

const HOST_ESCAPE_PROBE = "test ! -e /var/run/docker.sock && test ! -e /run/containerd/containerd.sock && test ! -e /host/var/run/docker.sock";
const EGRESS_PROBE_POD = "deepsonar-egress-combo-probe";
const GATEWAY_PROBE_SERVICE = "deepsonar-gateway-proxy";
const DENY_PROBE_SERVICE = "deepsonar-egress-deny-probe";

/** Cluster Service the Kata sandbox must reach through the OpenSandbox egress sidecar. */
export const KATA_GATEWAY_ALLOW_SCRIPT = `
import urllib.request, sys
try:
    urllib.request.urlopen("http://${GATEWAY_PROBE_SERVICE}:3100/", timeout=8)
    sys.exit(0)
except Exception as error:
    sys.stderr.write(str(error))
    sys.exit(1)
`.trim();

/** Same-namespace Service that must stay blocked when not in the allow list. */
export const KATA_GATEWAY_DENY_SCRIPT = `
import urllib.request, sys
try:
    urllib.request.urlopen("http://${DENY_PROBE_SERVICE}/", timeout=5)
    sys.exit(0)
except Exception:
    sys.exit(1)
`.trim();

function egressProbeManifests(image: string): Record<"pod" | "allow" | "deny", string> {
  return {
    pod: `apiVersion: v1
kind: Pod
metadata:
  name: ${EGRESS_PROBE_POD}
  namespace: ${OPENSANDBOX_K8S_NAMESPACE}
  labels:
    app: ${EGRESS_PROBE_POD}
spec:
  restartPolicy: Always
  containers:
    - name: http
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0"]
      ports:
        - containerPort: 8080
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 128Mi
`,
    allow: `apiVersion: v1
kind: Service
metadata:
  name: ${GATEWAY_PROBE_SERVICE}
  namespace: ${OPENSANDBOX_K8S_NAMESPACE}
spec:
  selector:
    app: ${EGRESS_PROBE_POD}
  ports:
    - name: gateway
      port: 3100
      targetPort: 8080
`,
    deny: `apiVersion: v1
kind: Service
metadata:
  name: ${DENY_PROBE_SERVICE}
  namespace: ${OPENSANDBOX_K8S_NAMESPACE}
spec:
  selector:
    app: ${EGRESS_PROBE_POD}
  ports:
    - port: 80
      targetPort: 8080
`,
  };
}

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

async function waitForEgressProbe(kubectl: KubectlJson): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    const pod = await kubectl(["get", "pod", EGRESS_PROBE_POD, "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]) as {
      status?: { phase?: string };
    };
    if (pod.status?.phase === "Running") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("OPENSANDBOX_POC_KATA_EGRESS_PROBE_NOT_READY");
}

async function deleteNamedJson(kubectl: KubectlJson, args: string[]): Promise<void> {
  try {
    await kubectl(["get", ...args, "-o", "json"]);
  } catch {
    return;
  }
  await kubectl(["delete", ...args, "-o", "name"]);
}

export async function runOpenSandboxK8sPoc(
  client: OpenSandboxClient,
  kubectl: KubectlJson,
  input: { image?: string; expectedContract?: string; apiKey?: string },
): Promise<{
  kata: true;
  isolated: true;
  hostEscapeBlocked: true;
  envClean: true;
  hardLimits: true;
  gatewayAllowed: true;
  denyBlocked: true;
  leftovers: number;
  leftoverPods: number;
  agentSandbox: false;
}> {
  await probeKataCluster(kubectl);
  let agentSandbox = false;
  try {
    agentSandbox = readAgentSandboxCrd(await kubectl(["get", "crd", "sandboxes.agents.x-k8s.io", "-o", "json"]));
  } catch {
    agentSandbox = false;
  }
  if (agentSandbox) throw new Error("OPENSANDBOX_POC_AGENT_SANDBOX_PRESENT");
  const image = input.image ?? OPENSANDBOX_POC_IMAGE;
  const staging = await mkdtemp(path.join(os.tmpdir(), "os-kata-egress-"));
  const manifests = egressProbeManifests(image);
  for (const [name, body] of Object.entries(manifests)) {
    const manifestPath = path.join(staging, `${name}.yaml`);
    await writeFile(manifestPath, body);
    await kubectl(["apply", "-f", manifestPath, "-o", "json"]);
  }
  try {
    await waitForEgressProbe(kubectl);
    const runner = new OpenSandboxRunner(client, {
      bind: (bindInput) => bindGatewayProxyToKubernetesService({
        ...bindInput,
        namespace: OPENSANDBOX_K8S_NAMESPACE,
        kubectl: async (args) => {
          const value = await kubectl(args);
          if (value && typeof value === "object" && "raw" in value) return String((value as { raw?: unknown }).raw ?? "");
          return JSON.stringify(value ?? {});
        },
      }),
    });
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const handle = await runner.provision({
      jobId,
      attemptId,
      image,
      network: "restricted",
      gatewayUpstreamUrl: "http://gateway.invalid:3100/gateway",
      expectedContract: input.expectedContract ?? OPENSANDBOX_POC_CONTRACT,
      kubernetesResources: true,
      limits: { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
    });
    try {
      findKataWorkload(
        await kubectl(["get", "pods", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
        jobId,
      );
      const host = await runner.ensureHost(handle);
      const isolated = await host.run(`python3 -c ${shellQuote(NETWORK_ISOLATION_SCRIPT)}`, { timeoutMs: 10_000 });
      if (isolated.exitCode !== 1) throw new Error("OPENSANDBOX_POC_KATA_NETWORK_NOT_ISOLATED");
      const allowed = await host.run(`python3 -c ${shellQuote(KATA_GATEWAY_ALLOW_SCRIPT)}`, { timeoutMs: 15_000 });
      if (allowed.exitCode !== 0) {
        throw new Error(`OPENSANDBOX_POC_KATA_GATEWAY_BLOCKED: ${allowed.stderr.trim() || allowed.stdout.trim()}`);
      }
      const denied = await host.run(`python3 -c ${shellQuote(KATA_GATEWAY_DENY_SCRIPT)}`, { timeoutMs: 10_000 });
      if (denied.exitCode !== 1) throw new Error("OPENSANDBOX_POC_KATA_DENY_LEAK");
      const escape = await host.run(HOST_ESCAPE_PROBE, { timeoutMs: 10_000 });
      if (escape.exitCode !== 0) throw new Error("OPENSANDBOX_POC_KATA_HOST_ESCAPE");
      const env = await host.run("sh -c 'env'", { timeoutMs: 10_000 });
      const envClean = env.exitCode === 0
        && !/OPEN[_-]?SANDBOX[_-]?API[_-]?KEY|OPENSANDBOX_SERVER_API_KEY/i.test(env.stdout)
        && (!input.apiKey || !env.stdout.includes(input.apiKey));
      if (!envClean) throw new Error("OPENSANDBOX_POC_KATA_ENV_LEAK");
      const limitsProbe = await host.run("grep -E '^(CapPrm|CapEff|NoNewPrivs):' /proc/self/status", { timeoutMs: 5_000 });
      const hardLimits = limitsProbe.exitCode === 0
        && /CapPrm:\s*0+/.test(limitsProbe.stdout)
        && /CapEff:\s*0+/.test(limitsProbe.stdout)
        && /NoNewPrivs:\s*1/.test(limitsProbe.stdout);
      if (!hardLimits) throw new Error(`OPENSANDBOX_POC_KATA_HARD_LIMITS: ${limitsProbe.stdout.trim() || limitsProbe.stderr.trim()}`);
      return {
        kata: true,
        isolated: true,
        hostEscapeBlocked: true,
        envClean: true,
        hardLimits: true,
        gatewayAllowed: true,
        denyBlocked: true,
        leftovers: 0,
        leftoverPods: 0,
        agentSandbox: false,
      };
    } finally {
      await runner.destroy(handle).catch(() => {});
      const leftovers = await runner.listResources({ jobId, attemptId });
      if (leftovers.length > 0) {
        throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
      }
      const remaining = await waitForRemainingJobPods(kubectl, jobId);
      if (remaining > 0) throw new Error(`OPENSANDBOX_POC_KATA_POD_LEFTOVER: ${remaining}`);
    }
  } finally {
    await deleteNamedJson(kubectl, ["pod", EGRESS_PROBE_POD, "-n", OPENSANDBOX_K8S_NAMESPACE]).catch(() => {});
    await deleteNamedJson(kubectl, ["service", GATEWAY_PROBE_SERVICE, "-n", OPENSANDBOX_K8S_NAMESPACE]).catch(() => {});
    await deleteNamedJson(kubectl, ["service", DENY_PROBE_SERVICE, "-n", OPENSANDBOX_K8S_NAMESPACE]).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export function findRemainingJobPods(pods: unknown, jobId: string): number {
  const items = pods && typeof pods === "object" && Array.isArray((pods as { items?: unknown }).items)
    ? (pods as { items: unknown[] }).items
    : [];
  return items.filter((item) => JSON.stringify(item).includes(jobId)).length;
}

export async function waitForRemainingJobPods(
  kubectl: KubectlJson,
  jobId: string,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let remaining = Number.POSITIVE_INFINITY;
  while (Date.now() <= deadline) {
    remaining = findRemainingJobPods(
      await kubectl(["get", "pods", "-n", OPENSANDBOX_K8S_NAMESPACE, "-o", "json"]),
      jobId,
    );
    if (remaining === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return remaining;
}
