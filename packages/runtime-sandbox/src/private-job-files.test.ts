import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRIVATE_JOB_FILES_SCRIPT, materializePrivateJobFiles, privateCredentialEnvironment } from "./private-job-files.js";
import { CLAUDE_PRIVATE_KEY_HELPER_SOURCE, PRIVATE_CREDENTIAL_READER_SOURCE } from "./private-credential-reader.js";
import { privateJobFixture } from "./private-job-fixture.js";
import type { RuntimeHost, RuntimeProcess } from "./runtime-host.js";

const identity = "11111111-1111-4111-8111-111111111111";
const token = "ephemeral-fixture-token";
const linux = process.platform === "linux";

test("#1032 Claude success hook preserves response shape and only projects registered secret values", { skip: !linux }, async t => {
  const auth = privateJobFixture();
  t.after(() => auth.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-tool-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "helper.mjs");
  await writeFile(script, CLAUDE_PRIVATE_KEY_HELPER_SOURCE);
  const invoke = (input: unknown, args = ["--post-tool-use"]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...auth.environment } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.on("error", reject);
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const response = { stdout: "before synthetic-main-token after", stderr: "synthetic-control-token",
    interrupted: false, isImage: false, exitCode: 0, error: null,
    content: [{ type: "text", text: "synthetic-om-token" }], toolId: "retained-tool-id" };
  const event = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "retained-tool-id",
    tool_input: { command: "retained command" }, tool_response: response };
  const original = structuredClone(event);
  const projected = await invoke(event);
  assert.equal(projected.code, 0, projected.stderr);
  assert.deepEqual(JSON.parse(projected.stdout), { hookSpecificOutput: { hookEventName: "PostToolUse",
    updatedToolOutput: { ...response, stdout: "before [REDACTED] after", stderr: "[REDACTED]",
      content: [{ type: "text", text: "[REDACTED]" }] } } });
  assert.deepEqual(event, original);
  const withError = { stdout: "synthetic-main-token", is_error: true, exitCode: 7, error: "retained diagnostic" };
  assert.deepEqual(JSON.parse((await invoke({ ...event, tool_response: withError })).stdout).hookSpecificOutput.updatedToolOutput,
    { ...withError, stdout: "[REDACTED]" }, "output projection must retain error flags and diagnostics");
  for (const toolResponse of [null, false, 3, ["retained", true], { stdout: "retained", is_error: false }]) {
    assert.deepEqual(JSON.parse((await invoke({ ...event, tool_response: toolResponse })).stdout), {},
      "unchanged responses must not compete with another hook's rewrite");
  }
  for (const input of [{ ...event, hook_event_name: "PostToolUseFailure", error: "synthetic-main-token" },
    { hook_event_name: "PostToolUse" }]) {
    const failure = await invoke(input);
    assert.equal(failure.code, 78);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr, "CLAUDE_TOOL_OUTPUT_PROJECTION_FAILED\n");
  }
  const authentication = await invoke(undefined, []);
  assert.equal(authentication.code, 0);
  assert.equal(authentication.stdout, "synthetic-main-token");
  await chmod(auth.environment.DEEPSONAR_OM_GATEWAY_TOKEN_FILE, 0o644);
  const unsafe = await invoke(event);
  assert.equal(unsafe.code, 78);
  assert.equal(unsafe.stdout, "");
  assert.equal(unsafe.stderr, "CLAUDE_TOOL_OUTPUT_PROJECTION_FAILED\n");
});

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

test("#1032 first write already has private permissions and Pi auth copies use exclusive creation", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-window-"));
  const auth = JSON.stringify({ fixture: { type: "api_key", key: token } });
  const payload = { "gateway-token": token, "pi-auth.json": auth };
  const inspect = String.raw`
import os, stat
real_write = os.write
def inspect_write(fd, data):
    info = os.fstat(fd)
    assert stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_uid == os.geteuid() and info.st_nlink == 1
    return real_write(fd, data)
os.write = inspect_write
`;
  try {
    await protocol(root, "create", payload, inspect + PRIVATE_JOB_FILES_SCRIPT);
    await protocol(root, "pi-auth", payload, inspect + PRIVATE_JOB_FILES_SCRIPT);
    const copy = path.join(root, ".deepsonar-home/.pi/agent/auth.json");
    assert.equal(await readFile(copy, "utf8"), auth);
    assert.equal((await stat(copy)).mode & 0o777, 0o600);
    await assert.rejects(protocol(root, "pi-auth", payload), "an existing auth file must not be overwritten");
    assert.equal(await readFile(copy, "utf8"), auth);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#1032 Linux trusted reader rejects changed file permissions and links", { skip: !linux }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepsonar-private-reader-"));
  const reader = await import(`data:text/javascript;base64,${Buffer.from(PRIVATE_CREDENTIAL_READER_SOURCE).toString("base64")}`);
  try {
    await protocol(root, "create");
    const file = path.join(root, `.deepsonar-credentials-${identity}`, "gateway-token");
    assert.equal(reader.readPrivateCredential(file), token);
    await chmod(file, 0o644);
    assert.throws(() => reader.readPrivateCredential(file), /PRIVATE_CREDENTIAL_REJECTED/u);
    await chmod(file, 0o600);
    await link(file, path.join(root, "linked"));
    assert.throws(() => reader.readPrivateCredential(file), /PRIVATE_CREDENTIAL_REJECTED/u);
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
        async closeStdin() {},
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

/** #1311：私有文件协议的 5 种失败必须各自可辨识，且不泄漏文件名与凭据。 */
function fakeHost(chunks: Array<Record<string, unknown>>): RuntimeHost {
  const process = {
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
    write: async () => {},
    kill: async () => {},
  };
  // SAFETY: 只用到 runAsync 一个方法，测试替身无需实现 RuntimeHost 的其余能力。
  return { runAsync: async () => process } as unknown as RuntimeHost;
}

test("#1311 五类失败只暴露代码定义的 reason/operation 与数字或布尔量", async () => {
  const secret = "synthetic-control-token";
  const cases: Array<[Array<Record<string, unknown>>, RegExp, string]> = [
    [[{ type: "stderr", chunk: `Traceback ValueError: ${secret}` }, { type: "exit", exitCode: 3 }],
      /^PRIVATE_JOB_FILES_REJECTED reason=exit_nonzero operation=create detail=exit=3,stderr_present=true$/u, "exit_nonzero"],
    [[{ type: "stderr", chunk: `${secret} 不可写` }, { type: "stdout", chunk: "nope\n" }, { type: "exit", exitCode: 0 }],
      /^PRIVATE_JOB_FILES_REJECTED reason=protocol_unexpected operation=create detail=exited=true,stderr_present=true$/u, "protocol_unexpected"],
  ];
  for (const [chunks, shape, label] of cases) {
    await assert.rejects(materializePrivateJobFiles(fakeHost(chunks), { "control-token": secret }),
      (error: Error) => {
        assert.match(error.message, shape, label);
        assert.ok(!error.message.includes(secret), `${label} 不得带出凭据原文`);
        assert.ok(!/Traceback|不可写/u.test(error.message), `${label} 不得带出自由文本`);
        return true;
      });
  }
});

test("#1311 三个后续阶段同样不带自由文本", async () => {
  const secret = "synthetic-control-token";
  const created = await materializePrivateJobFiles(
    fakeHost([{ type: "stdout", chunk: "ok\n" }, { type: "exit", exitCode: 0 }]), { "control-token": secret });
  for (const [label, invoke] of [
    ["check", () => created.check()],
    ["cleanup", () => created.cleanup()],
  ] as const) {
    await assert.rejects(invoke,
      (error: Error) => {
        assert.match(error.message, /^PRIVATE_JOB_FILES_REJECTED reason=/u);
        assert.ok(!error.message.includes(secret), `${label} 不得带出凭据原文`);
        return true;
      });
  }
});

test("#1311 非法文件名只报个数，不把名字写进错误", async () => {
  await assert.rejects(materializePrivateJobFiles(fakeHost([]), { "secret-name-xyz": "value" }),
    (error: Error) => /reason=invalid_names operation=create detail=count=1$/u.test(error.message)
      && !error.message.includes("secret-name-xyz"));
});
