import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OPENSANDBOX_EGRESS_IMAGE,
  OPENSANDBOX_EXECD_IMAGE,
  OPENSANDBOX_SERVER_IMAGE,
} from "./opensandbox-version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("OpenSandbox deploy pins official schema and immutable digests", () => {
  const toml = readFileSync(join(root, "deploy/opensandbox/config.toml"), "utf8");
  const compose = readFileSync(join(root, "deploy/docker-compose.opensandbox.yml"), "utf8");
  assert.match(toml, /network_mode = "bridge"/);
  assert.match(toml, /no_new_privileges = true/);
  assert.match(toml, /drop_capabilities = \["ALL"\]/);
  assert.match(toml, /type = "sqlite"/);
  assert.match(toml, /mode = "direct"/);
  assert.doesNotMatch(toml, /(?:^|\s)latest(?:\s|$)|network_mode = "host"|api_key_env|^\s*driver\s*=/m);
  assert.match(toml, new RegExp(OPENSANDBOX_EXECD_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(toml, new RegExp(OPENSANDBOX_EGRESS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, new RegExp(OPENSANDBOX_SERVER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, /OPENSANDBOX_SERVER_API_KEY/);
  assert.match(compose, /driver: bridge/);
  assert.doesNotMatch(compose, /:latest|network_mode:\s*host/);
});

test("OpenSandbox production overlay is opt-in and keeps default Agentbox", () => {
  const overlay = readFileSync(join(root, "deploy/docker-compose.opensandbox.prod.yml"), "utf8");
  const deploySh = readFileSync(join(root, "deploy/deploy.sh"), "utf8");
  const deployPs1 = readFileSync(join(root, "deploy/deploy.ps1"), "utf8");
  assert.match(overlay, new RegExp(OPENSANDBOX_SERVER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(overlay, /SANDBOX_PROVIDER: opensandbox/);
  assert.match(overlay, /OPEN_SANDBOX_DOMAIN: \$\{OPEN_SANDBOX_DOMAIN:-opensandbox:8080\}/);
  assert.match(overlay, /OPEN_SANDBOX_HOST_PORT:-18080/);
  assert.match(overlay, /condition: service_healthy/);
  assert.match(overlay, /127\.0\.0\.1:8080\/health/);
  assert.match(overlay, /OPENSANDBOX_SERVER_API_KEY/);
  assert.doesNotMatch(overlay, /:latest|network_mode:\s*host/);
  assert.doesNotMatch(overlay, /127\.0\.0\.1:8080:8080/);
  assert.match(deploySh, /\[ "\$\{SANDBOX_PROVIDER:-\}" = "opensandbox" \]/);
  assert.match(deploySh, /docker-compose.opensandbox.prod.yml/);
  assert.match(deployPs1, /\$env:SANDBOX_PROVIDER -eq "opensandbox"/);
  assert.match(deployPs1, /docker-compose.opensandbox.prod.yml/);
});

test("OpenSandbox Kubernetes overlay pins Kata BatchSandbox and official schema", () => {
  const toml = readFileSync(join(root, "deploy/opensandbox/config.k8s.toml"), "utf8");
  const template = readFileSync(join(root, "deploy/opensandbox/batchsandbox-template.yaml"), "utf8");
  const runtimeClass = readFileSync(join(root, "deploy/opensandbox/runtimeclass-kata.yaml"), "utf8");
  const namespace = readFileSync(join(root, "deploy/opensandbox/namespace.yaml"), "utf8");
  const quota = readFileSync(join(root, "deploy/opensandbox/resourcequota.yaml"), "utf8");
  const kustomization = readFileSync(join(root, "deploy/opensandbox/kustomization.yaml"), "utf8");
  assert.match(toml, /type = "kubernetes"/);
  assert.match(toml, /type = "kata"/);
  assert.match(toml, /k8s_runtime_class = "kata-qemu"/);
  assert.match(toml, /workload_provider = "batchsandbox"/);
  assert.match(toml, /namespace = "deepsonar-opensandbox"/);
  assert.match(toml, /mode = "direct"/);
  assert.doesNotMatch(toml, /(?:^|\s)latest(?:\s|$)|workload_provider = "agent-sandbox"|type = "gvisor"/m);
  assert.match(toml, new RegExp(OPENSANDBOX_EXECD_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(toml, new RegExp(OPENSANDBOX_EGRESS_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(template, /restartPolicy: Never/);
  assert.doesNotMatch(template, /^\s*runtimeClassName:/m);
  assert.match(runtimeClass, /name: kata-qemu/);
  assert.match(runtimeClass, /handler: kata-qemu/);
  assert.match(namespace, /name: deepsonar-opensandbox/);
  assert.match(quota, /kind: ResourceQuota/);
  assert.match(quota, /kind: LimitRange/);
  assert.match(quota, /namespace: deepsonar-opensandbox/);
  assert.match(quota, /pods: "32"/);
  assert.match(quota, /defaultRequest:/);
  assert.match(template, /requests:/);
  assert.match(template, /limits:/);
  assert.match(kustomization, /namespace\.yaml/);
  assert.match(kustomization, /runtimeclass-kata\.yaml/);
  assert.match(kustomization, /resourcequota\.yaml/);
  assert.doesNotMatch(kustomization, /batchsandbox-template\.yaml/);
});

test("OpenSandbox vendor CLI PoC routes models through Scheduler Gateway", () => {
  const poc = readFileSync(join(root, "apps/scheduler/src/opensandbox-cli-control.poc.ts"), "utf8");
  assert.match(poc, /registerGateway/);
  assert.match(poc, /mintJobToken/);
  assert.match(poc, /encryptSecret/);
  assert.match(poc, /DEEPSONAR_GATEWAY_TOKEN/);
  assert.match(poc, /vendor key leaked into OpenSandbox worker env/);
  assert.doesNotMatch(poc, /ANTHROPIC_API_KEY: vendorKey|ANTHROPIC_API_KEY: vendorSecret/);
  assert.doesNotMatch(poc, /OPENAI_API_KEY: vendorKey|DEEPSEEK_API_KEY: vendorKey/);
});

test("OpenSandbox live harness pins arch image separately from contract-fail busybox", () => {
  const harness = readFileSync(join(root, "agent-harness/test-opensandbox-poc.ts"), "utf8");
  assert.match(harness, /OPEN_SANDBOX_POC_ARCH_IMAGE/);
  assert.match(harness, /runOpenSandboxArchPoc/);
  assert.match(harness, /--case must be all, arch, images, prod-config, prod-up, or k8s/);
  assert.match(harness, /runOpenSandboxOfficialImagesPoc/);
  assert.match(harness, /listOfficialOpenSandboxRuntimeImages/);
  assert.match(harness, /prod-config/);
  assert.match(harness, /prod-up/);
  assert.match(harness, /runOpenSandboxK8sPoc/);
  assert.match(harness, /docker-compose.real.yml/);
  assert.match(harness, /--project-directory/);
});

test("OpenSandbox adapter does not import Agentbox SDK types", () => {
  const adapter = readFileSync(join(root, "packages/runtime-sandbox/src/opensandbox.ts"), "utf8");
  const shared = readFileSync(join(root, "packages/runtime-sandbox/src/runtime-shared.ts"), "utf8");
  const agent = readFileSync(join(root, "packages/runtime-sandbox/src/runtime-agent.ts"), "utf8");
  const gateway = readFileSync(join(root, "packages/runtime-sandbox/src/runtime-gateway.ts"), "utf8");
  const docker = readFileSync(join(root, "packages/runtime-sandbox/src/runtime-docker.ts"), "utf8");
  assert.doesNotMatch(adapter, /from ["']\.\/agentbox\.js["']/);
  assert.doesNotMatch(adapter, /from ["']agentbox-sdk["']/);
  assert.doesNotMatch(agent, /from ["']\.\/agentbox\.js["']/);
  assert.doesNotMatch(agent, /from ["']agentbox-sdk["']/);
  assert.doesNotMatch(gateway, /from ["']\.\/agentbox\.js["']/);
  assert.doesNotMatch(gateway, /from ["']agentbox-sdk["']/);
  assert.doesNotMatch(docker, /from ["']\.\/agentbox\.js["']/);
  assert.doesNotMatch(docker, /from ["']agentbox-sdk["']/);
  assert.match(adapter, /from ["']\.\/runtime-shared\.js["']/);
  assert.match(agent, /export async function runRealAgent/);
  assert.match(shared, /export const SHARED_ASSETS_MOUNT_PATH/);
  assert.match(shared, /export function parseToolManifest/);
});

test("main barrel keeps Agentbox on a lazy subpath so OpenSandbox does not load agentbox-sdk", () => {
  const barrel = readFileSync(join(root, "packages/runtime-sandbox/src/index.ts"), "utf8");
  const runtime = readFileSync(join(root, "apps/scheduler/src/runtime.ts"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "packages/runtime-sandbox/package.json"), "utf8")) as {
    exports?: Record<string, { types?: string; default?: string }>;
  };
  assert.doesNotMatch(barrel, /from ["']\.\/agentbox\.js["']/);
  assert.doesNotMatch(barrel, /AgentboxRunner|createAgentboxRuntimeHost|wrapAgentboxProcess/);
  assert.equal(pkg.exports?.["./agentbox"]?.types, "./src/agentbox.ts");
  assert.equal(pkg.exports?.["./agentbox"]?.default, "./dist/agentbox.js");
  assert.doesNotMatch(runtime, /import\s*\{[^}]*AgentboxRunner/);
  assert.match(runtime, /import\(["']@deepsonar\/runtime-sandbox\/agentbox["']\)/);
  assert.match(runtime, /config\.runtime\.provider === ["']opensandbox["']/);
});
