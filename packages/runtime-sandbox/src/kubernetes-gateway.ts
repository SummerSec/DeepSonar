/**
 * Kubernetes Gateway bind (#162). Kata guests cannot use Docker ExtraHosts;
 * the Scheduler-owned Service ClusterIP is written into sandbox /etc/hosts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEEPSONAR_GATEWAY_PROXY_HOST } from "./runtime-shared.js";

const execFileP = promisify(execFile);

export type KubectlExec = (args: string[]) => Promise<string>;

function defaultKubectl(kubeconfig: string): KubectlExec {
  return async (args) => {
    const { stdout } = await execFileP("kubectl", args, {
      env: { ...process.env, KUBECONFIG: kubeconfig },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  };
}

function parseJson(text: string): unknown {
  if (!text) return {};
  return (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) as unknown : { raw: text };
}

export function readServiceClusterIP(service: unknown): string {
  const ip = service && typeof service === "object" && "spec" in service
    ? String((service as { spec?: { clusterIP?: unknown } }).spec?.clusterIP ?? "")
    : "";
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) || ip === "None") {
    throw new Error("OPENSANDBOX_POC_KATA_GATEWAY_SERVICE_IP");
  }
  return ip;
}

export function kubernetesGatewayNamespace(): string {
  return process.env.OPEN_SANDBOX_K8S_NAMESPACE?.trim() || "deepsonar-opensandbox";
}

export function kubernetesKubeconfig(): string {
  const value = process.env.OPEN_SANDBOX_KUBECONFIG?.trim() || process.env.KUBECONFIG?.trim();
  if (!value) throw new Error("OPEN_SANDBOX_KUBECONFIG 或 KUBECONFIG 在 OPEN_SANDBOX_KUBERNETES=1 时必填");
  return value;
}

/** Look up the Scheduler-owned Gateway Service. Missing/headless ClusterIP fail closed. */
export async function bindGatewayProxyToKubernetesService(input: {
  sandboxId: string;
  upstreamUrl: string;
  image: string;
  signal?: AbortSignal;
  namespace?: string;
  kubeconfig?: string;
  kubectl?: KubectlExec;
}): Promise<{ hostname: string; ip: string }> {
  if (input.signal?.aborted) throw new Error("provision 已取消");
  const namespace = input.namespace ?? kubernetesGatewayNamespace();
  const kubectl = input.kubectl ?? defaultKubectl(input.kubeconfig ?? kubernetesKubeconfig());
  const service = parseJson(await kubectl(["get", "service", DEEPSONAR_GATEWAY_PROXY_HOST, "-n", namespace, "-o", "json"]));
  return { hostname: DEEPSONAR_GATEWAY_PROXY_HOST, ip: readServiceClusterIP(service) };
}

export function gatewayServiceManifest(namespace = kubernetesGatewayNamespace()): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${DEEPSONAR_GATEWAY_PROXY_HOST}
  namespace: ${namespace}
spec:
  ports:
    - port: 80
      targetPort: 3100
`;
}
