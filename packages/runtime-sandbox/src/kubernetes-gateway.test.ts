import assert from "node:assert/strict";
import test from "node:test";
import {
  applyKubernetesSandboxHostsBind,
  bindGatewayProxyToKubernetesService,
  gatewayServiceManifest,
  readSandboxPodName,
  readServiceClusterIP,
} from "./kubernetes-gateway.js";
import { GATEWAY_HOSTS_BIND_ERROR_PREFIX } from "./sandbox-gateway-hosts.js";

test("Kubernetes Gateway bind requires a real ClusterIP", () => {
  assert.equal(readServiceClusterIP({ spec: { clusterIP: "10.43.0.10" } }), "10.43.0.10");
  assert.throws(() => readServiceClusterIP({ spec: { clusterIP: "None" } }), /OPENSANDBOX_POC_KATA_GATEWAY_SERVICE_IP/);
  assert.throws(() => readServiceClusterIP({}), /OPENSANDBOX_POC_KATA_GATEWAY_SERVICE_IP/);
  const manifest = gatewayServiceManifest("deepsonar-opensandbox");
  assert.match(manifest, /name: deepsonar-gateway-proxy/);
  assert.match(manifest, /port: 3100/);
  assert.match(manifest, /targetPort: 3100/);
  assert.doesNotMatch(manifest, /port: 80/);
});

test("Kubernetes Gateway bind fail-closes a missing or headless Service", async () => {
  await assert.rejects(
    () => bindGatewayProxyToKubernetesService({
      sandboxId: "sbx",
      upstreamUrl: "http://127.0.0.1:3100/gateway",
      image: "img@sha256:" + "a".repeat(64),
      kubectl: async () => { throw new Error("services \"deepsonar-gateway-proxy\" not found"); },
    }),
    /not found/,
  );
  await assert.rejects(
    () => bindGatewayProxyToKubernetesService({
      sandboxId: "sbx",
      upstreamUrl: "http://127.0.0.1:3100/gateway",
      image: "img@sha256:" + "a".repeat(64),
      kubectl: async () => JSON.stringify({ spec: { clusterIP: "None" } }),
    }),
    /OPENSANDBOX_POC_KATA_GATEWAY_SERVICE_IP/,
  );
});

test("Kubernetes Gateway bind returns the Service ClusterIP", async () => {
  const bind = await bindGatewayProxyToKubernetesService({
    sandboxId: "sbx",
    upstreamUrl: "http://127.0.0.1:3100/gateway",
    image: "img@sha256:" + "a".repeat(64),
    kubectl: async (args) => {
      assert.deepEqual(args.slice(0, 3), ["get", "service", "deepsonar-gateway-proxy"]);
      return JSON.stringify({ spec: { clusterIP: "10.43.0.10" } });
    },
  });
  assert.deepEqual(bind, { hostname: "deepsonar-gateway-proxy", ip: "10.43.0.10" });
});

test("Kubernetes Gateway hosts bind execs the sandbox pod as uid 0", async () => {
  assert.equal(readSandboxPodName({
    items: [{ metadata: { name: "kata-pod", labels: { sandbox: "sbx-9" } } }],
  }, "sbx-9"), "kata-pod");
  const argsLog: string[][] = [];
  await applyKubernetesSandboxHostsBind({
    sandboxId: "sbx-9",
    hostname: "deepsonar-gateway-proxy",
    ip: "10.43.0.10",
    kubectl: async (args) => {
      argsLog.push(args);
      if (args[0] === "get" && args[1] === "pod") {
        throw new Error("pods \"sandbox-sbx-9\" not found");
      }
      if (args[0] === "get" && args[1] === "pods") {
        return JSON.stringify({ items: [{ metadata: { name: "kata-pod", labels: { sandbox: "sbx-9" } } }] });
      }
      return "";
    },
  });
  assert.deepEqual(argsLog.at(-1)?.slice(0, 6), ["exec", "-n", "deepsonar-opensandbox", "-u", "0", "kata-pod"]);
});

test("Kubernetes Gateway hosts bind fail-closes when the sandbox pod is missing", async () => {
  await assert.rejects(
    () => applyKubernetesSandboxHostsBind({
      sandboxId: "missing",
      hostname: "deepsonar-gateway-proxy",
      ip: "10.43.0.10",
      kubectl: async (args) => {
        if (args[0] === "get") throw new Error("not found");
        throw new Error("unexpected");
      },
    }),
    new RegExp(GATEWAY_HOSTS_BIND_ERROR_PREFIX),
  );
});
