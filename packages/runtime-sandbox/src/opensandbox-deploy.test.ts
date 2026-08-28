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

test("OpenSandbox Kubernetes overlay pins Kata BatchSandbox and official schema", () => {
  const toml = readFileSync(join(root, "deploy/opensandbox/config.k8s.toml"), "utf8");
  const template = readFileSync(join(root, "deploy/opensandbox/batchsandbox-template.yaml"), "utf8");
  const runtimeClass = readFileSync(join(root, "deploy/opensandbox/runtimeclass-kata.yaml"), "utf8");
  const namespace = readFileSync(join(root, "deploy/opensandbox/namespace.yaml"), "utf8");
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
  assert.doesNotMatch(template, /runtimeClassName/);
  assert.match(runtimeClass, /name: kata-qemu/);
  assert.match(runtimeClass, /handler: kata-qemu/);
  assert.match(namespace, /name: deepsonar-opensandbox/);
});
