import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRIVATE_JOB_FILES_SCRIPT, materializePrivateJobFiles, privateCredentialEnvironment } from "./private-job-files.js";
import { PRIVATE_CREDENTIAL_READER_SOURCE } from "./private-credential-reader.js";
import type { RuntimeHost, RuntimeProcess } from "./runtime-host.js";

const identity = "11111111-1111-4111-8111-111111111111";
const token = "ephemeral-fixture-token";
const linux = process.platform === "linux";

test("#1032 CLI environment carries paths and removes gateway, control, provider and telemetry values", () => {
  const base = `/workspace/.deepsonar-credentials-${identity}`;
  const environment = privateCredentialEnvironment({
    DEEPSONAR_API_TOKEN: token, DEEPSONAR_GATEWAY_TOKEN: token, DEEPSONAR_OM_GATEWAY_TOKEN: token,
    ANTHROPIC_AUTH_TOKEN: token, OPENAI_API_KEY: token, DEEPSEEK_API_KEY: token,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`, HOME: "home", MODEL: "model",
  }, { paths: { "control-token": `${base}/control-token`, "gateway-token": `${base}/gateway-token` } });
  assert.deepEqual(environment, { HOME: "home", MODEL: "model",
    DEEPSONAR_CONTROL_TOKEN_FILE: `${base}/control-token`, DEEPSONAR_GATEWAY_TOKEN_FILE: `${base}/gateway-token` });
  assert.ok(!JSON.stringify(environment).includes(token));
});

function protocol(root: string, operation: string, files: Record<string, string> = { "gateway-token": token }, source = PRIVATE_JOB_FILES_SCRIPT): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", source, root, operation, identity], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin!.on("error", reject);
    child.stdin!.end(`${JSON.stringify(files)}\n`);
  });
}

test("#1032 failure writing the second credential rolls back the first secret through held descriptors", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-partial-"));
  const inject = String.raw`
import os
real_write = os.write
writes = 0
def fail_second(fd, data):
    global writes
    writes += 1
    if writes == 2: raise OSError("synthetic second write failure")
    return real_write(fd, data)
os.write = fail_second
`;
  try {
    await assert.rejects(protocol(root, "create", { "control-token": "first-secret", "gateway-token": "second-secret" }, inject + PRIVATE_JOB_FILES_SCRIPT));
    assert.deepEqual(await readdir(root), [], "both partial and completed credential files must be removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 failed creation never removes a replaced private directory", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-replaced-"));
  const inject = String.raw`
import os, sys
real_write = os.write
writes = 0
def replace_second(fd, data):
    global writes
    writes += 1
    if writes == 2:
        leaf = sys.argv[1] + "/.deepsonar-credentials-" + sys.argv[3]
        os.rename(leaf, leaf + "-moved")
        os.mkdir(leaf, 0o700)
        with open(leaf + "/unrelated", "w") as replacement: replacement.write("keep")
        raise OSError("synthetic replacement")
    return real_write(fd, data)
os.write = replace_second
`;
  try {
    await assert.rejects(protocol(root, "create", { "control-token": "first-secret", "gateway-token": "second-secret" }, inject + PRIVATE_JOB_FILES_SCRIPT));
    const leaf = path.join(root, `.deepsonar-credentials-${identity}`);
    assert.equal(await readFile(path.join(leaf, "unrelated"), "utf8"), "keep");
    assert.deepEqual(await readdir(leaf + "-moved"), [], "held directory loses its created secrets even after a rename");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 private credentials are created 0600 inside a fresh 0700 directory and cleaned exactly", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-"));
  const directory = path.join(root, `.deepsonar-credentials-${identity}`);
  try {
    assert.equal(await protocol(root, "create"), "ok\n");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const file = path.join(directory, "gateway-token");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(file)).nlink, 1);
    assert.equal(await readFile(file, "utf8"), token);
    await assert.rejects(protocol(root, "create"), "existing private directories must never be reused");
    assert.equal(await readFile(file, "utf8"), token);
    assert.equal(await protocol(root, "check"), "ok\n");
    assert.equal(await protocol(root, "cleanup"), "ok\n");
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 private writes reject symlink parents and preexisting private directories", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-links-"));
  try {
    const real = path.join(root, "real");
    await mkdir(real, { mode: 0o700 });
    const alias = path.join(root, "alias");
    await symlink(real, alias);
    await assert.rejects(protocol(alias, "create"));
    await assert.rejects(protocol(path.join(alias, "nested"), "create"));
    const directory = path.join(real, `.deepsonar-credentials-${identity}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "gateway-token"), "unchanged", { mode: 0o600 });
    await assert.rejects(protocol(real, "create"));
    assert.equal(await readFile(path.join(directory, "gateway-token"), "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 reads and cleanup reject hardlinks, symlinks, permissive modes and unexpected entries", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-tamper-"));
  try {
    await protocol(root, "create");
    const directory = path.join(root, `.deepsonar-credentials-${identity}`);
    const file = path.join(directory, "gateway-token");
    const outside = path.join(root, "outside");
    await link(file, outside);
    await assert.rejects(protocol(root, "check"));
    await assert.rejects(protocol(root, "cleanup"));
    assert.equal(await readFile(outside, "utf8"), token);
    await rm(outside);
    await chmod(file, 0o644);
    await assert.rejects(protocol(root, "check"));
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await assert.rejects(protocol(root, "check"));
    await chmod(directory, 0o700);
    await writeFile(outside, "outside");
    await rm(file);
    await symlink(outside, file);
    await assert.rejects(protocol(root, "check"));
    await assert.rejects(protocol(root, "cleanup"));
    assert.equal(await readFile(outside, "utf8"), "outside");
    await rm(file);
    await writeFile(file, token, { mode: 0o600 });
    await writeFile(path.join(directory, "unexpected"), "keep");
    await assert.rejects(protocol(root, "cleanup"));
    assert.equal(await readFile(file, "utf8"), token, "validate the entire directory before deleting any file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 credential payload travels only through live stdin and writer failure blocks startup", async () => {
  const commands: string[] = [];
  const inputs: string[] = [];
  let exitCode = 0;
  const host = {
    async runAsync(command: string, options: unknown) {
      commands.push(command, JSON.stringify((options as { env?: unknown }).env) ?? "");
      return {
        stdinClosed: false,
        async write(value: string) { inputs.push(value); },
        async kill() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "stdout", chunk: "ok\n" };
          yield { type: "exit", exitCode };
        },
      } as RuntimeProcess;
    },
    async uploadFile() { assert.fail("credential writes must not use uploadFile or its temporary files"); },
  } as unknown as RuntimeHost;
  const result = await materializePrivateJobFiles(host, { "gateway-token": token });
  assert.match(result.directory, /^\/workspace\/\.deepsonar-credentials-[a-f0-9-]+$/u);
  assert.equal(inputs[0], `${JSON.stringify({ "gateway-token": token })}\n`);
  assert.ok(commands.every(command => !command.includes(token)));
  exitCode = 1;
  await assert.rejects(materializePrivateJobFiles(host, { "gateway-token": token }), /PRIVATE_JOB_FILES_REJECTED/u);
});

test("#1032 trusted readers reject arbitrary paths and missing file sources", async () => {
  const reader = await import(`data:text/javascript;base64,${Buffer.from(PRIVATE_CREDENTIAL_READER_SOURCE).toString("base64")}`);
  for (const file of [undefined, "/tmp/token", "/workspace/.deepsonar/gateway-token",
    "/workspace/.deepsonar-credentials-11111111-1111-4111-8111-111111111111/../gateway-token"]) {
    assert.throws(() => reader.readPrivateCredential(file), /PRIVATE_CREDENTIAL_REJECTED/u);
  }
  assert.equal(reader.readPrivateCredential(undefined, true), undefined);
  assert.throws(() => reader.readPrivateCredential("", true), /PRIVATE_CREDENTIAL_REJECTED/u);
});
