import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertDockerIngressIsDirect,
  assertKubernetesGatewayTomlHasRequiredFields,
  assertOpenSandboxConfigSchemaFails,
  assertOpenSandboxConfigSchemaPasses,
  opensandboxConfigFixturePath,
  pinnedOpenSandboxServerImage,
  probeOpenSandboxSchemaGateDocker,
  redactOpenSandboxSchemaError,
  repoRootFromHere,
  schemaGateRequiredInThisEnvironment,
} from "./opensandbox-config-schema-gate.js";
import { OPENSANDBOX_SERVER_IMAGE } from "./opensandbox-version.js";

const root = repoRootFromHere();
const dockerProbe = probeOpenSandboxSchemaGateDocker();
const runDockerSchemaGate = dockerProbe.available;
const skipDockerReason = dockerProbe.available
  ? undefined
  : schemaGateRequiredInThisEnvironment()
    ? undefined
    : `OpenSandbox schema gate skipped: ${dockerProbe.skipReason ?? "docker_unavailable"} (${dockerProbe.detail ?? "no detail"})`;

if (!dockerProbe.available && schemaGateRequiredInThisEnvironment()) {
  test("OpenSandbox schema gate requires Docker in CI", () => {
    assert.fail(
      `OPENSANDBOX_CONFIG_SCHEMA_GATE_REQUIRED but Docker unavailable: ${dockerProbe.skipReason} ${dockerProbe.detail ?? ""}`.trim(),
    );
  });
}

test("OpenSandbox schema gate reads server digest from version facts only", () => {
  const image = pinnedOpenSandboxServerImage();
  assert.equal(image, OPENSANDBOX_SERVER_IMAGE);
  assert.match(image, /@sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(image, /:latest(?:$|@)/);
});

test("OpenSandbox schema error redaction strips secret-like tokens", () => {
  const redacted = redactOpenSandboxSchemaError(
    'api_key=super-secret token: abc123 Bearer eyJhbGciOiJIUzI1NiJ9.xx /home/runner/.kube/config ValidationError gateway block',
  );
  assert.match(redacted, /api_key=<redacted>/i);
  assert.match(redacted, /token:<redacted>|token=<redacted>/i);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /<redacted-home-path>/);
  assert.match(redacted, /gateway block/);
  assert.doesNotMatch(redacted, /super-secret|eyJhbGciOiJIUzI1NiJ9/);
});

test("Docker deploy config keeps direct ingress (matrix: Docker!=gateway)", () => {
  const toml = readFileSync(join(root, "deploy/opensandbox/config.toml"), "utf8");
  assertDockerIngressIsDirect(toml, "deploy/opensandbox/config.toml");
  assert.doesNotMatch(toml, /\[ingress\.gateway\]/);
});

test("Illegal Docker gateway-without-block fixture is present for the schema gate", () => {
  const path = opensandboxConfigFixturePath("docker-gateway-missing-block.toml");
  const toml = readFileSync(path, "utf8");
  assert.match(toml, /\[ingress\][\s\S]*?mode\s*=\s*"gateway"/);
  assert.doesNotMatch(toml, /^\[ingress\.gateway\]/m);
  assert.match(toml, /type\s*=\s*"docker"/);
});

test("K8s gateway fixture declares required address and route.mode", () => {
  const path = opensandboxConfigFixturePath("k8s-gateway-valid.toml");
  const toml = readFileSync(path, "utf8");
  assertKubernetesGatewayTomlHasRequiredFields(toml, path);
  assert.match(toml, /type\s*=\s*"kubernetes"/);
});

test("K8s gateway missing-field fixtures omit address or route.mode", () => {
  const missingAddress = readFileSync(
    opensandboxConfigFixturePath("k8s-gateway-missing-address.toml"),
    "utf8",
  );
  const missingRoute = readFileSync(
    opensandboxConfigFixturePath("k8s-gateway-missing-route-mode.toml"),
    "utf8",
  );
  assert.match(missingAddress, /mode\s*=\s*"gateway"/);
  assert.match(missingAddress, /\[ingress\.gateway\]/);
  assert.doesNotMatch(missingAddress, /^\s*address\s*=/m);
  assert.match(missingAddress, /\[ingress\.gateway\.route\]/);

  assert.match(missingRoute, /mode\s*=\s*"gateway"/);
  assert.match(missingRoute, /^\s*address\s*=/m);
  assert.doesNotMatch(missingRoute, /\[ingress\.gateway\.route\]/);

  assert.throws(
    () => assertKubernetesGatewayTomlHasRequiredFields(missingAddress, "missing-address"),
    /address is required/,
  );
  assert.throws(
    () => assertKubernetesGatewayTomlHasRequiredFields(missingRoute, "missing-route"),
    /route\.mode is required|requires \[ingress\.gateway\.route\]/,
  );
});

test("Deployed K8s configs stay on direct ingress (gateway covered by fixtures)", () => {
  for (const rel of ["deploy/opensandbox/config.k8s.toml", "deploy/opensandbox/config.k8s.external.toml"]) {
    const toml = readFileSync(join(root, rel), "utf8");
    assert.match(toml, /\[ingress\][\s\S]*?mode\s*=\s*"direct"/);
    assert.doesNotMatch(toml, /\[ingress\.gateway\]/);
    assert.match(toml, /type\s*=\s*"kubernetes"/);
  }
});

test(
  "Pinned OpenSandbox image parses Docker direct default config.toml",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    const result = assertOpenSandboxConfigSchemaPasses(join(root, "deploy/opensandbox/config.toml"));
    assert.equal(result.image, OPENSANDBOX_SERVER_IMAGE);
    assert.match(result.stdout, /OPENSANDBOX_CONFIG_SCHEMA_OK/);
  },
);

test(
  "Pinned OpenSandbox image rejects Docker gateway without gateway block",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    const result = assertOpenSandboxConfigSchemaFails(
      opensandboxConfigFixturePath("docker-gateway-missing-block.toml"),
      /gateway block must be provided when ingress\.mode = 'gateway'/,
    );
    assert.equal(result.image, OPENSANDBOX_SERVER_IMAGE);
    assert.match(result.redactedError, /gateway block must be provided/);
  },
);

test(
  "Pinned OpenSandbox image parses K8s gateway fixture with address and route.mode",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    assertOpenSandboxConfigSchemaPasses(opensandboxConfigFixturePath("k8s-gateway-valid.toml"));
  },
);

test(
  "Pinned OpenSandbox image rejects K8s gateway missing address",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    assertOpenSandboxConfigSchemaFails(
      opensandboxConfigFixturePath("k8s-gateway-missing-address.toml"),
      /ingress\.gateway\.address[\s\S]*Field required|Field required[\s\S]*ingress\.gateway\.address/,
    );
  },
);

test(
  "Pinned OpenSandbox image rejects K8s gateway missing route.mode",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    assertOpenSandboxConfigSchemaFails(
      opensandboxConfigFixturePath("k8s-gateway-missing-route-mode.toml"),
      /ingress\.gateway\.route[\s\S]*Field required|Field required[\s\S]*ingress\.gateway\.route/,
    );
  },
);

test(
  "Pinned OpenSandbox image still parses deployed K8s direct configs",
  { skip: skipDockerReason },
  () => {
    assert.ok(runDockerSchemaGate);
    assertOpenSandboxConfigSchemaPasses(join(root, "deploy/opensandbox/config.k8s.toml"));
    assertOpenSandboxConfigSchemaPasses(join(root, "deploy/opensandbox/config.k8s.external.toml"));
  },
);
