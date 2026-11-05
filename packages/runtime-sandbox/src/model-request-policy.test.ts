import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { MODEL_REQUEST_POLICY_BASE_URL, MODEL_REQUEST_POLICY_SOURCE, modelRequestPolicyCommand } from "./model-request-policy.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";
import { shellQuote, type RuntimeHost } from "./runtime-host.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "request-policy-"));
  const script = path.join(dir, "policy.mjs");
  await writeFile(script, MODEL_REQUEST_POLICY_SOURCE);
  const api = await import(pathToFileURL(script).href);
  return { api, script, close: () => rm(dir, { recursive: true, force: true }) };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("three CLI model request shapes generate current limits while preserving models and extensions", { timeout: 20_000 }, async () => {
  const file = await fixture();
  let remaining = 20;
  let allowanceStatus = 200;
  let allowanceQueries = 0;
  let pendingReplies: string[] = [];
  let responseStatus = 200;
  const received: Array<{ url: string; headers: http.IncomingHttpHeaders; raw: string[]; body: Record<string, unknown> }> = [];
  const compressed = gzipSync(Buffer.from("synthetic error"));
  const remote = http.createServer(async (req, res) => {
    if (req.url === "/gateway/_allowance") {
      allowanceQueries++;
      assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
      const pending = pendingReplies.shift();
      if (pending) {
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: pending } }));
        return;
      }
      res.writeHead(allowanceStatus, { "content-type": "application/json" }).end(JSON.stringify(allowanceStatus === 200
        ? { remaining_tokens: remaining, policy_required: true } : { error: { type: "JOB_TOKEN_USAGE_UNKNOWN" } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ url: req.url!, headers: req.headers, raw: req.rawHeaders, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(responseStatus, ["Content-Type", "application/octet-stream", "Content-Encoding", "gzip", "Content-Length", String(compressed.length),
      "Retry-After", "9", "X-Request-Id", "fixture", "Location", "/do-not-follow"]).end(compressed);
  });
  const remoteUrl = await listen(remote);
  const policy = await file.api.startModelRequestPolicy({ upstream: `${remoteUrl}/gateway`, token: "synthetic-main-token", port: 0 });
  const local = `http://127.0.0.1:${(policy.server.address() as AddressInfo).port}`;
  const request = (route: string, payload: unknown, headers: string[] = []) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const req = http.request(`${local}/gateway/${route}`, { method: "POST", headers: ["Authorization", "Bearer synthetic-main-token", "Content-Type", "application/json",
      "Content-Length", String(bytes.length), ...headers] }, async (res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) });
    });
    req.on("error", reject); req.end(bytes);
  });
  try {
    const fixtures = [
      { route: "v1/messages", payload: { model: "claude-fixture", max_tokens: 100, messages: [], extension: { keep: true } }, field: "max_tokens" },
      { route: "v1/chat/completions", payload: { model: "pi-fixture", max_tokens: 100, stream: true, messages: [], extension: { keep: true } }, field: "max_tokens" },
      { route: "v1/responses", payload: { model: "dsh-fixture", max_output_tokens: 100, input: "fixture", extension: { keep: true } }, field: "max_output_tokens" },
    ];
    for (const fixture of fixtures) {
      const original = structuredClone(fixture.payload);
      const result = await request(fixture.route, fixture.payload, ["X-Repeated", "one", "X-Repeated", "two"]);
      assert.equal(result.status, 200); assert.deepEqual(result.bytes, compressed);
      const last = received.at(-1)!;
      assert.equal(last.body[fixture.field], remaining);
      assert.equal(last.body.model, original.model); assert.deepEqual(last.body.extension, original.extension);
      assert.deepEqual(fixture.payload, original);
      assert.equal(last.headers["x-repeated"], "one, two");
      if (fixture.route.includes("chat")) assert.deepEqual(last.body.stream_options, { include_usage: true });
      remaining -= 3;
    }
    await request("v1/chat/completions", { model: "pi-fixture", stream: true });
    assert.equal(received.at(-1)!.body.max_completion_tokens, 11, "each request reads the reduced allowance");
    for (const code of ["JOB_TOKEN_USAGE_PENDING", "REPAIR_USAGE_PENDING"]) {
      pendingReplies = [code];
      const callsBefore = received.length, queriesBefore = allowanceQueries;
      const admitted = await request("v1/messages", { model: "fixture", max_tokens: 3 });
      assert.equal(admitted.status, 200);
      assert.equal(allowanceQueries, queriesBefore + 2, "pending settlement repeats only the read-only allowance query");
      assert.equal(received.length, callsBefore + 1, "a settled allowance leads to exactly one model request");
    }
    const before = received.length;
    for (const code of [409, 429]) {
      allowanceStatus = code;
      const queriesBefore = allowanceQueries;
      const denied = await request("v1/messages", { model: "fixture", max_tokens: 3 });
      assert.equal(denied.status, code); assert.equal(received.length, before);
      assert.equal(allowanceQueries, queriesBefore + 1, "unknown usage and quota denial are returned without polling");
    }
    allowanceStatus = 200;
    for (const code of [307, 429, 503]) {
      responseStatus = code;
      const count = received.length;
      const result = await request("v1/messages", { model: "fixture", max_tokens: 3 });
      assert.equal(result.status, code); assert.equal(result.headers["retry-after"], "9");
      assert.deepEqual(result.bytes, compressed); assert.equal(received.length, count + 1);
    }
  } finally { await policy.close(); await close(remote); await file.close(); }
});

test("generation policy keeps unlimited bytes and refuses unsupported or amplifying finite requests", async () => {
  const file = await fixture();
  try {
    const raw = { model: "fixture", unknown: true };
    assert.equal(file.api.prepareModelRequest(raw, "/v1/messages", { remaining_tokens: null, policy_required: false }), raw);
    assert.deepEqual(file.api.prepareModelRequest(raw, "/v1/messages", { remaining_tokens: null, policy_required: true }), raw);
    assert.deepEqual(file.api.prepareModelRequest({ max_tokens: 9, max_completion_tokens: 3 }, "/v1/chat/completions",
      { remaining_tokens: 10, policy_required: true }), { max_tokens: 3 });
    for (const body of [null, [], Buffer.from("opaque"), { n: 3 }, { best_of: 2 }, { max_tokens: -1 }]) {
      assert.throws(() => file.api.prepareModelRequest(body, "/v1/messages", { remaining_tokens: 10, policy_required: true }));
    }
    assert.throws(() => file.api.prepareModelRequest(raw, "/v1/messages", { remaining_tokens: 0, policy_required: true }));
  } finally { await file.close(); }
});

test("all three CLI starts and supported resumes use the explicit wrapper without changing their stdin protocol", async () => {
  const commands: string[] = [];
  const host = {
    runAsync: async (command: string) => { commands.push(command); return {} as never; },
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), uploadFile: async () => {},
  } as unknown as RuntimeHost;
  const context = { host, cwd: "/workspace", input: "fixture", mcpConfigPath: "/workspace/mcp.json",
    env: { DEEPSONAR_REQUEST_POLICY_UPSTREAM: "http://gateway.invalid/gateway", DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" },
    dshProvider: { provider: "fixture", model: "fixture", config: { providers: {} } } };
  for (const id of ["pi", "dsh", "claude-code"] as const) await AGENT_CLI_RUNTIME_ADAPTERS[id].start(context);
  for (const id of ["pi", "claude-code"] as const) await AGENT_CLI_RUNTIME_ADAPTERS[id].resume({ ...context, sessionId: "fixture", sessionFile: "/workspace/session.jsonl" });
  assert.equal(commands.length, 5);
  for (const command of commands) assert.match(command, /^node '\/workspace\/\.deepsonar\/model-request-policy\.mjs' -- /u);
  assert.equal(modelRequestPolicyCommand("pi --mode rpc", {}), "pi --mode rpc");
  assert.throws(() => modelRequestPolicyCommand("pi", { DEEPSONAR_REQUEST_POLICY_UPSTREAM: "http://gateway.invalid/gateway" }));
});

test("wrapper preserves child stdin/exit, owns the fixed port and cleans up on signals", { timeout: 20_000 }, async () => {
  const file = await fixture();
  const remote = http.createServer((_req, res) => res.end("unused"));
  const upstream = `${await listen(remote)}/gateway`;
  const start = (program: string): ChildProcess => spawn(process.execPath, [file.script, "--", `${shellQuote(process.execPath)} -e ${shellQuote(program)}`],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DEEPSONAR_REQUEST_POLICY_UPSTREAM: upstream, DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" } });
  let active: ChildProcess | undefined;
  try {
    active = start("process.stdout.write('ready:'+process.pid+'\\n');process.stdin.on('data',chunk=>process.stdout.write(chunk));setInterval(()=>{},1000)");
    const exit = once(active, "exit");
    const [ready] = await once(active.stdout!, "data");
    const childPid = Number(String(ready).trim().split(":")[1]);
    assert.ok(Number.isSafeInteger(childPid));
    active.stdin!.write("input-frame\n");
    const [echo] = await once(active.stdout!, "data");
    assert.equal(String(echo), "input-frame\n");
    const duplicate = start("process.stdout.write('MUST_NOT_LAUNCH')");
    let output = ""; duplicate.stdout!.on("data", chunk => { output += chunk; });
    assert.equal((await once(duplicate, "exit"))[0], 78, "a second CLI cannot reuse the first CLI's policy listener");
    assert.equal(output, "");
    active.kill("SIGTERM"); await exit;
    let gone = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(childPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { gone = true; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(gone, true, "signal teardown removes the CLI process group");
    active = start("process.exit(7)");
    assert.equal((await once(active, "exit"))[0], 7, "child exit status survives the policy wrapper");
    const url = new URL(MODEL_REQUEST_POLICY_BASE_URL);
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(Number(url.port), url.hostname, resolve); });
    await close(probe);
  } finally { if (active && active.exitCode === null && active.signalCode === null) active.kill("SIGKILL"); await close(remote); await file.close(); }
});
