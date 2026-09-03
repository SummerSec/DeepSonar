import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_HOSTS_ROOT_GID,
  GATEWAY_HOSTS_ROOT_UID,
  GatewayHostsBindError,
  OpenSandboxRunner,
  evaluateOpenSandboxAlive,
  gatewayHostsBindCommand,
  isGatewayHostsRootRun,
  mapOpenSandboxCreateInput,
  mapOpenSandboxNetworkPolicy,
  requireOpenSandboxLimits,
  type OpenSandboxClient,
  type OpenSandboxCreateInput,
  type OpenSandboxRunOptions,
  type OpenSandboxSession,
} from "./opensandbox.js";
import { RuntimeImageContractError } from "./runtime-shared.js";
import { isManagedRuntimeResource } from "./opensandbox-version.js";

function fakeSession(id = "sbx-1"): OpenSandboxSession & {
  commands: string[];
  runs: Array<{ command: string; options?: OpenSandboxRunOptions }>;
  files: Array<{ path: string; bytes: number }>;
} {
  const commands: string[] = [];
  const runs: Array<{ command: string; options?: OpenSandboxRunOptions }> = [];
  const files: Array<{ path: string; bytes: number }> = [];
  return {
    id,
    commands,
    runs,
    files,
    async run(command, options) {
      commands.push(command);
      runs.push({ command, options });
      if (command.includes(">>") && command.includes("/etc/hosts") && !isGatewayHostsRootRun(options)) {
        return { exitCode: 1, stdout: "", stderr: "Permission denied" };
      }
      if (command.includes("tool-manifest.json") && command.includes("cat ")) {
        return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime/v1" }), stderr: "" };
      }
      if (command.includes("sha256sum")) return { exitCode: 0, stdout: "aa".repeat(32), stderr: "" };
      if (command === "true") return { exitCode: 0, stdout: "", stderr: "" };
      if (command.includes("getent hosts") || (command.includes("grep -F") && command.includes("/etc/hosts") && !command.includes(">>"))) {
        return { exitCode: 0, stdout: "172.19.0.9\tdeepsonar-gateway-proxy\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async runAsync(command) {
      commands.push(command);
      return {
        async write() {},
        async closeStdin() {},
        async kill() {},
        async resize() {},
        async *[Symbol.asyncIterator]() {},
      };
    },
    async writeFile(destPath, content) {
      files.push({ path: destPath, bytes: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength });
    },
    async readFile() {
      return Buffer.from("ok");
    },
    async getState() {
      return "Running";
    },
    async kill() {},
    async close() {},
  };
}

function fakeClient(session = fakeSession()): OpenSandboxClient & { created: OpenSandboxCreateInput[]; listed: number; session: ReturnType<typeof fakeSession> } {
  const created: OpenSandboxCreateInput[] = [];
  return {
    session,
    created,
    listed: 0,
    async create(input) {
      created.push(input);
      return session;
    },
    async connect(id) {
      return id === session.id ? session : undefined;
    },
    async list() {
      this.listed += 1;
      return [{ resourceId: session.id, jobId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", state: "Running" }];
    },
  };
}

const limits = { cpu: 2, memoryMiB: 2048, pidsLimit: 512, capDropAll: true, noNewPrivileges: true };

test("OpenSandbox mapping fail-closes on missing or insecure limits", () => {
  assert.throws(() => requireOpenSandboxLimits(undefined), /SANDBOX_LIMITS_MISSING: cpu/);
  assert.throws(() => requireOpenSandboxLimits({ cpu: 2 }), /memoryMiB/);
  assert.throws(() => requireOpenSandboxLimits({ cpu: 2, memoryMiB: 1024, pidsLimit: 1, capDropAll: false }), /capDropAll/);
  assert.deepEqual(requireOpenSandboxLimits(limits), { cpu: 2, memoryMiB: 2048, pidsLimit: 512 });
});

test("OpenSandbox maps none/restricted/egress without host-network", () => {
  assert.deepEqual(mapOpenSandboxNetworkPolicy("none"), { defaultAction: "deny", egress: [] });
  assert.deepEqual(mapOpenSandboxNetworkPolicy("egress"), { defaultAction: "allow", egress: [] });
  assert.deepEqual(
    mapOpenSandboxNetworkPolicy("restricted", "http://host.docker.internal:3100/gateway"),
    { defaultAction: "deny", egress: [{ action: "allow", target: "deepsonar-gateway-proxy" }] },
  );
  assert.throws(() => mapOpenSandboxNetworkPolicy("restricted"), /Gateway/);
});

test("OpenSandbox create input freezes job/attempt identity and Scheduler TTL", () => {
  const input = mapOpenSandboxCreateInput({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "deepsonar-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    sharedAssetsMount: { volumeName: "deepsonar-assets-11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(input.timeoutSeconds, null);
  assert.equal(input.metadata["deepsonar.job"], "11111111-1111-4111-8111-111111111111");
  assert.equal(input.metadata["deepsonar.attempt"], "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(input.resource, { cpu: "2", memory: "2048Mi", pids: "512" });
  const k8s = mapOpenSandboxCreateInput({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "deepsonar-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    kubernetesResources: true,
    limits,
  });
  assert.deepEqual(k8s.resource, { cpu: "2", memory: "2048Mi" });
  const k8sFractional = mapOpenSandboxCreateInput({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "deepsonar-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    kubernetesResources: true,
    limits: { ...limits, cpu: 0.4 },
  });
  assert.deepEqual(k8sFractional.resource, { cpu: "400m", memory: "2048Mi" });
  assert.equal(requireOpenSandboxLimits(limits).pidsLimit, 512);
  assert.equal(input.volumes[0]?.readOnly, true);
  assert.equal(input.volumes[0]?.pvc.claimName, "deepsonar-assets-11111111-1111-4111-8111-111111111111");
  assert.equal(input.volumes[0]?.pvc.createIfNotExists, false);
  assert.ok(!Object.values(input.env).some((value) => /api[_-]?key/i.test(value)));
  assert.equal(input.platform, undefined);
});

test("OpenSandbox runner constructor omits pids when kubernetesResources is set", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client, undefined, { kubernetesResources: true });
  await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
  });
  assert.deepEqual(client.created[0]?.resource, { cpu: "2", memory: "2048Mi" });
  const docker = fakeClient();
  const dockerRunner = new OpenSandboxRunner(docker);
  await dockerRunner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
  });
  assert.deepEqual(docker.created[0]?.resource, { cpu: "2", memory: "2048Mi", pids: "512" });
});

test("OpenSandbox runner provisions, exposes host, and verifies contract", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client);
  const handle = await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    expectedContract: "deepsonar.runtime/v1",
    expectedToolsManifestSha256: "aa".repeat(32),
  });
  assert.equal(handle.sandboxId, "sbx-1");
  assert.equal(client.created[0]?.timeoutSeconds, null);
  const host = runner.hostOf(handle);
  assert.ok(host);
  await host.uploadFile("hello", "/workspace/note.txt");
  assert.deepEqual(client.session.files, [{ path: "/workspace/note.txt", bytes: 5 }]);
  assert.equal(await runner.isAlive(handle), true);
});

function assertRootGatewayHostsBind(
  session: ReturnType<typeof fakeSession>,
  bind: { hostname: string; ip: string },
) {
  const write = session.runs.find((run) => run.command.includes(">>") && run.command.includes("/etc/hosts"));
  assert.ok(write);
  assert.equal(write.command, gatewayHostsBindCommand(bind));
  assert.equal(isGatewayHostsRootRun(write.options), true);
  assert.equal(write.options?.uid, GATEWAY_HOSTS_ROOT_UID);
  assert.equal(write.options?.gid, GATEWAY_HOSTS_ROOT_GID);
  assert.equal(session.runs.some((run) => (
    run.command.includes(">>") && run.command.includes("/etc/hosts") && !isGatewayHostsRootRun(run.options)
  )), false);
  assert.ok(session.commands.some((command) => (
    command.includes("getent hosts") && command.includes(bind.hostname)
  )));
}

test("OpenSandbox restricted provision binds the Gateway hostname into /etc/hosts as root", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client, {
    bind: async () => ({ hostname: "deepsonar-gateway-proxy", ip: "172.19.0.9" }),
  });
  await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "restricted",
    gatewayUpstreamUrl: "http://host.docker.internal:3100/gateway",
    limits,
    expectedContract: "deepsonar.runtime/v1",
  });
  assert.equal(
    client.created[0]?.networkPolicy.egress[0]?.target,
    "deepsonar-gateway-proxy",
  );
  assertRootGatewayHostsBind(client.session, { hostname: "deepsonar-gateway-proxy", ip: "172.19.0.9" });
});

test("OpenSandbox Kubernetes restricted provision binds the Gateway Service ClusterIP as root", async () => {
  const client = fakeClient();
  let bound = 0;
  const runner = new OpenSandboxRunner(client, {
    bind: async () => {
      bound += 1;
      return { hostname: "deepsonar-gateway-proxy", ip: "10.43.0.10" };
    },
  }, { kubernetesResources: true });
  await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "restricted",
    gatewayUpstreamUrl: "http://host.docker.internal:3100/gateway",
    limits,
    expectedContract: "deepsonar.runtime/v1",
  });
  assert.equal(bound, 1);
  assertRootGatewayHostsBind(client.session, { hostname: "deepsonar-gateway-proxy", ip: "10.43.0.10" });
});

test("OpenSandbox provision completes gateway hosts bind for a non-root guest", async () => {
  const session = fakeSession();
  const client = fakeClient(session);
  const runner = new OpenSandboxRunner(client, {
    bind: async () => ({ hostname: "deepsonar-gateway-proxy", ip: "172.19.0.9" }),
  });
  for (const network of ["restricted", "egress"] as const) {
    session.commands.length = 0;
    session.runs.length = 0;
    client.created.length = 0;
    await runner.provision({
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      network,
      gatewayUpstreamUrl: "http://host.docker.internal:3100/gateway",
      limits,
      expectedContract: "deepsonar.runtime/v1",
    });
    assertRootGatewayHostsBind(session, { hostname: "deepsonar-gateway-proxy", ip: "172.19.0.9" });
  }
});

test("OpenSandbox gateway sidecar bind failure is reported as hosts/gateway bind, not chromium", async () => {
  const runner = new OpenSandboxRunner(fakeClient(), {
    bind: async () => {
      throw new Error("sidecar has no IPv4");
    },
  });
  await assert.rejects(runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "egress",
    gatewayUpstreamUrl: "http://host.docker.internal:3100/gateway",
    limits,
    expectedContract: "deepsonar.runtime/v1",
  }), (error: unknown) => {
    assert.ok(error instanceof GatewayHostsBindError);
    assert.match(error.message, /gateway sidecar before hosts injection/);
    assert.doesNotMatch(error.message, /chromium/i);
    return true;
  });
});

test("OpenSandbox gateway hosts bind failure is not a missing-chromium contract error", async () => {
  const session = fakeSession();
  session.run = async (command, options) => {
    session.commands.push(command);
    session.runs.push({ command, options });
    if (command.includes("tool-manifest.json") && command.includes("cat ")) {
      return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime/v1" }), stderr: "" };
    }
    if (command.includes(">>") && command.includes("/etc/hosts")) {
      return { exitCode: 1, stdout: "", stderr: "Permission denied" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new OpenSandboxRunner(fakeClient(session), {
    bind: async () => ({ hostname: "deepsonar-gateway-proxy", ip: "172.19.0.9" }),
  });
  await assert.rejects(runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "restricted",
    gatewayUpstreamUrl: "http://host.docker.internal:3100/gateway",
    limits,
    expectedContract: "deepsonar.runtime/v1",
  }), (error: unknown) => {
    assert.ok(error instanceof GatewayHostsBindError);
    assert.equal(error instanceof RuntimeImageContractError, false);
    assert.match(error.message, /gateway hostname in sandbox hosts/);
    assert.doesNotMatch(error.message, /chromium/i);
    return true;
  });
});

test("OpenSandbox isAlive retries a transient exec probe while lifecycle stays Running", async () => {
  let probes = 0;
  assert.equal(await evaluateOpenSandboxAlive({
    getState: async () => "Running",
    probe: async () => {
      probes += 1;
      if (probes < 2) throw new Error("execd blip");
      return { exitCode: 0 };
    },
  }), true);
  assert.equal(probes, 2);
  assert.equal(await evaluateOpenSandboxAlive({
    getState: async () => "Paused",
    probe: async () => {
      throw new Error("must not probe a non-running sandbox");
    },
  }), false);
  assert.equal(await evaluateOpenSandboxAlive({
    getState: async () => { throw new Error("api down"); },
    probe: async () => ({ exitCode: 0 }),
  }), false);
});

test("OpenSandbox listResources keeps only dual canonical-UUID labels", async () => {
  const client = fakeClient();
  client.list = async () => [
    { resourceId: "foreign", jobId: "", attemptId: "", state: "Running" },
    { resourceId: "partial", jobId: "11111111-1111-4111-8111-111111111111", attemptId: "not-a-uuid", state: "Running" },
    { resourceId: "managed", jobId: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222", state: "Running" },
  ];
  const runner = new OpenSandboxRunner(client);
  const listed = await runner.listResources();
  assert.deepEqual(listed.map((item) => item.resourceId), ["managed"]);
  assert.equal(isManagedRuntimeResource({ jobId: "", attemptId: "" }), false);
  assert.equal(isManagedRuntimeResource({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
  }), true);
});

test("OpenSandbox provision fail-closes when the shared assets volume is not Scheduler-owned", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client, undefined, {
    inspectSharedAssetsVolume: async () => {
      throw new Error("shared assets volume is not a local Scheduler-managed volume for this Job");
    },
  });
  await assert.rejects(runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    sharedAssetsMount: { volumeName: "deepsonar-assets-11111111-1111-4111-8111-111111111111" },
  }), /Scheduler-managed volume/);
  assert.equal(client.created.length, 0);
});

test("OpenSandbox Kubernetes provision skips Docker volume inspect", async () => {
  const session = fakeSession();
  session.run = async (command) => {
    if (command.includes("tool-manifest.json") && command.includes("cat ")) {
      return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime/v1" }), stderr: "" };
    }
    if (command === "cat /proc/mounts") {
      return { exitCode: 0, stdout: "/dev/sda /workspace/.deepsonar/shared ext4 ro 0 0\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let inspected = 0;
  const client = fakeClient(session);
  const runner = new OpenSandboxRunner(client, undefined, {
    kubernetesResources: true,
    inspectSharedAssetsVolume: async () => {
      inspected += 1;
      throw new Error("docker inspect must not run on Kubernetes");
    },
  });
  await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    sharedAssetsMount: { volumeName: "deepsonar-assets-11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(inspected, 0);
  assert.equal(client.created.length, 1);
});

test("OpenSandbox provision fail-closes when the shared assets volume is not mounted", async () => {
  const session = fakeSession();
  session.run = async (command) => {
    if (command.includes("tool-manifest.json") && command.includes("cat ")) {
      return { exitCode: 0, stdout: JSON.stringify({ contract: "deepsonar.runtime/v1" }), stderr: "" };
    }
    if (command === "cat /proc/mounts") return { exitCode: 0, stdout: "overlay / overlay rw 0 0\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new OpenSandboxRunner(fakeClient(session), undefined, {
    inspectSharedAssetsVolume: async () => {},
  });
  await assert.rejects(runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    sharedAssetsMount: { volumeName: "deepsonar-assets-11111111-1111-4111-8111-111111111111" },
  }), /shared assets volume was not mounted/);
});

test("OpenSandbox isAlive requires lifecycle Running and a healthy exec probe", async () => {
  const session = fakeSession();
  session.getState = async () => "Paused";
  const runner = new OpenSandboxRunner(fakeClient(session));
  await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
  });
  assert.equal(await runner.isAlive({ sandboxId: "sbx-1" }), false);
});

test("OpenSandbox cancelProvision destroys labeled leftovers", async () => {
  const client = fakeClient();
  let killed = 0;
  client.session.kill = async () => {
    killed += 1;
  };
  const runner = new OpenSandboxRunner(client);
  await runner.cancelProvision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(client.listed, 1);
  assert.equal(killed, 1);
});

test("OpenSandbox ensureHost reconnects after process-local cache miss", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client);
  assert.equal(runner.hostOf({ sandboxId: "sbx-1" }), undefined);
  const host = await runner.ensureHost({ sandboxId: "sbx-1" });
  assert.ok(host);
  assert.ok(runner.hostOf({ sandboxId: "sbx-1" }));
  await assert.rejects(runner.ensureHost({ sandboxId: "missing" }), /不在注册表/);
});

test("OpenSandbox openTerminal reconnects through ensureHost", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client);
  const terminal = await runner.openTerminal({ sandboxId: "sbx-1" }, { cols: 80, rows: 24 });
  assert.ok(terminal.id);
  assert.match(client.session.commands.join("\n"), /sh -c .*bash -il/);
  await terminal.close();
});

test("OpenSandbox provision abort rejects in-flight create and kills late sessions", async () => {
  const session = fakeSession();
  let killed = 0;
  session.kill = async () => {
    killed += 1;
  };
  let release: ((value: OpenSandboxSession) => void) | undefined;
  const client = fakeClient(session);
  client.create = () => new Promise((resolve) => {
    release = resolve;
  });
  const abort = new AbortController();
  const runner = new OpenSandboxRunner(client);
  const pending = runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(pending, /已取消/);
  release?.(session);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(killed >= 1);
});

test("OpenSandbox contract mismatch destroys the created session", async () => {
  const session = fakeSession();
  let killed = 0;
  session.kill = async () => {
    killed += 1;
  };
  session.run = async (command) => {
    if (command.includes("tool-manifest.json") && command.includes("cat ")) {
      return { exitCode: 0, stdout: JSON.stringify({ contract: "wrong" }), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new OpenSandboxRunner(fakeClient(session));
  await assert.rejects(runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
    expectedContract: "deepsonar.runtime/v1",
  }), /contract mismatch/);
  assert.equal(killed >= 1, true);
});

test("OpenSandbox host rejects reserved workspace reads and inbox path traversal", async () => {
  const client = fakeClient();
  const runner = new OpenSandboxRunner(client);
  const handle = await runner.provision({
    jobId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    image: "img@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    network: "none",
    limits,
  });
  const host = runner.hostOf(handle)!;
  await assert.rejects(host.readWorkspaceFile("/workspace/.deepsonar/secret", 100), /forbidden/);
  await assert.rejects(
    host.writeHumanInboxFile("/workspace/.deepsonar/inbox/not-a-uuid/file.bin", Buffer.from("x")),
    /path_forbidden/,
  );
});

test("OpenSandbox destroy waits until the sandbox disappears from list", async () => {
  const client = fakeClient();
  let present = 2;
  client.destroy = async () => {
    present -= 1;
  };
  client.list = async () => (present > 0
    ? [{
        resourceId: "sbx-1",
        jobId: "11111111-1111-4111-8111-111111111111",
        attemptId: "22222222-2222-4222-8222-222222222222",
        state: "Running",
      }]
    : []);
  const runner = new OpenSandboxRunner(client);
  await runner.destroy({ sandboxId: "sbx-1" });
  assert.equal(present, 0);
});
