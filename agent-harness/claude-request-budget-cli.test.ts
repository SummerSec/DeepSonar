/** Real pinned Claude CLI, synthetic provider only; not a Scheduler/launch acceptance. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const token = "synthetic-claude-budget-token";
const sentinel = "CLAUDE_BUDGET_SYNTHETIC_BASH_COMPLETED";
const refusal = "MODEL_REQUEST_POLICY_PREGENERATION_REQUIRED";
async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: http.Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function bytes(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    assert.ok(size <= 2 * 1024 * 1024, "bounded synthetic CLI request");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("Claude 2.1.312 native launch cap preserves bytes and refuses a later over-budget tool turn", { timeout: 180_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-native-budget-"));
  let stage = "image-version";
  let output = "";
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let cli: ChildProcess | undefined;
  let policy: any;
  let remaining = 4096;
  let allowanceQueries = 0;
  let auxiliaryCalls = 0;
  const errors: string[] = [];
  const captured: Buffer[] = [];
  const delivered: Buffer[] = [];
  const policyStatuses: number[] = [];
  const policyErrors: string[] = [];
  const remote = http.createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (req.method === "GET" && req.url === "/gateway/_allowance") {
        allowanceQueries++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ policy_required: true, remaining_tokens: remaining }));
        return;
      }
      const route = req.url?.split("?")[0];
      assert.equal(req.method, "POST");
      const raw = await bytes(req);
      const body = JSON.parse(raw.toString("utf8"));
      assert.equal(body.model, "claude-sonnet-4-5");
      // Explicitly support the SDK's read-only token-count helper, if used.
      // No arbitrary startup traffic receives a successful response.
      if (route === "/gateway/v1/messages/count_tokens") {
        auxiliaryCalls++;
        assert.ok(Array.isArray(body.messages));
        res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}');
        return;
      }
      assert.equal(route, "/gateway/v1/messages");
      delivered.push(raw);
      assert.equal(delivered.length, 1, "over-budget follow-up must never reach the provider");
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.stream, true);
      assert.ok(body.tools.some((tool: any) => tool.name === "Bash"));
      remaining = 2048;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events = [
        { type: "message_start", message: { id: "synthetic-message", type: "message", role: "assistant", model: body.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "synthetic-bash-tool", name: "Bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `printf '%s' '${sentinel}'`, description: "Print synthetic budget sentinel" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 32 } },
        { type: "message_stop" },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    })().catch(() => { errors.push("synthetic-provider-contract"); res.writeHead(500).end(); });
  });
  const capture = http.createServer((req, res) => {
    void (async () => {
      const route = req.url?.split("?")[0];
      assert.equal(req.method, "POST");
      assert.ok(route === "/gateway/v1/messages" || route === "/gateway/v1/messages/count_tokens", "unexpected CLI auxiliary route");
      const raw = await bytes(req);
      if (route === "/gateway/v1/messages") captured.push(raw);
      const local = `http://127.0.0.1:${(policy.server.address() as AddressInfo).port}`;
      const forwarded = http.request(local + req.url, { method: req.method, headers: req.rawHeaders }, reply => {
        if (route === "/gateway/v1/messages") policyStatuses.push(reply.statusCode!);
        const response: Buffer[] = [];
        res.writeHead(reply.statusCode!, reply.headers);
        reply.on("data", chunk => { response.push(Buffer.from(chunk)); res.write(chunk); });
        reply.on("end", () => {
          if (reply.statusCode === 409) {
            try { policyErrors.push(JSON.parse(Buffer.concat(response).toString("utf8")).error.message); }
            catch { errors.push("invalid-policy-refusal"); }
          }
          res.end();
        });
        reply.on("error", () => { errors.push("capture-response"); res.destroy(); });
      });
      forwarded.on("error", () => { errors.push("capture-forward"); res.destroy(); });
      forwarded.end(raw);
    })().catch(() => { errors.push("capture-contract"); res.writeHead(500).end(); });
  });
  try {
    const interfaces = Object.values(networkInterfaces()).flatMap(entries => entries ?? []);
    assert.ok(interfaces.length > 0 && interfaces.every(entry => entry.internal), "acceptance container must expose only loopback interfaces");
    const fixture = JSON.parse(await readFile("/acceptance/runtime-fixture.json", "utf8")) as { policySource: string; encodedInput: string };
    assert.equal(typeof fixture.policySource, "string"); assert.ok(fixture.policySource.length > 0);
    assert.equal(typeof fixture.encodedInput, "string"); assert.ok(fixture.encodedInput.endsWith("\n"));
    const version = await run("claude", ["--version"], { timeout: 30_000 });
    assert.match(version.stdout, /^2\.1\.312\b/u, "execute the production pinned CLI");
    stage = "prepare-native-launch";
    const script = path.join(dir, "policy.mjs");
    await writeFile(script, fixture.policySource);
    const api = await import(pathToFileURL(script).href);
    const upstream = await listen(remote);
    policy = await api.startModelRequestPolicy({ upstream: upstream + "/gateway", token, port: 0 });
    const captureUrl = await listen(capture);
    const prepared = await api.prepareClaudeLaunch(
      "claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions --model claude-sonnet-4-5 --tools Bash --no-session-persistence",
      { DEEPSONAR_REQUEST_POLICY_UPSTREAM: upstream + "/gateway", DEEPSONAR_GATEWAY_TOKEN: token,
        HOME: "/tmp/claude-budget", CLAUDE_CONFIG_DIR: "/tmp/claude-budget/config",
        ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: captureUrl + "/gateway",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
        MAX_THINKING_TOKENS: "0" });
    assert.equal(prepared.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "4096");
    stage = "native-cli-tool-loop";
    cli = spawn("/bin/bash", ["-c", `mkdir -p "$CLAUDE_CONFIG_DIR" && exec ${prepared.command}`], {
      cwd: "/tmp", env: { ...process.env, ...prepared.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutPending = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2 * 1024 * 1024) { errors.push("bounded-cli-output"); cli?.kill("SIGKILL"); }
    };
    cli.stdout!.on("data", (chunk: Buffer) => {
      collect(chunk); stdoutPending += chunk.toString("utf8");
      const lines = stdoutPending.split("\n"); stdoutPending = lines.pop()!;
      for (const line of lines) {
        try { if (JSON.parse(line).type === "result") cli?.stdin?.end(); } catch { /* Non-JSON diagnostics remain captured. */ }
      }
    });
    cli.stderr!.on("data", collect);
    const finished = new Promise<void>((resolve, reject) => {
      cli!.once("error", () => reject(new Error("Claude process failed to start")));
      cli!.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
    });
    cli.stdin!.on("error", () => { errors.push("cli-stdin"); });
    cli.stdin!.write(fixture.encodedInput);
    await Promise.race([finished, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Pinned Claude did not finish the offline budget-refusal turn")), 120_000);
      timer.unref(); finished.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
    stage = "assert-captured-native-requests";
    assert.deepEqual(errors, []);
    assert.ok(captured.length >= 2, "real CLI must form a follow-up tool turn");
    assert.equal(delivered.length, 1);
    assert.equal(createHash("sha256").update(captured[0]!).digest("hex"), createHash("sha256").update(delivered[0]!).digest("hex"), "formed request bytes preserved");
    for (const raw of captured.slice(1)) {
      const body = JSON.parse(raw.toString("utf8"));
      assert.equal(body.max_tokens, 4096, "running CLI retains its launch cap");
      const result = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .find((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic-bash-tool");
      assert.ok(result, "follow-up includes the real Bash execution result");
      assert.notEqual(result.is_error, true, "Bash must execute successfully, not merely echo a rejected command");
      const text = typeof result.content === "string" ? result.content
        : result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      assert.equal(text.trim(), sentinel, "Bash must return exactly the synthetic printf output");
    }
    assert.deepEqual(policyStatuses, [200, ...captured.slice(1).map(() => 409)]);
    assert.deepEqual(policyErrors, captured.slice(1).map(() => refusal));
    assert.ok(output.includes(refusal), "CLI must display the admission refusal code");
    assert.ok(output.includes("Configure supported CLI options before generating a new request")
      && output.includes("the formed request was not rewritten or sent"), "CLI must display the clear budget refusal hint");
    assert.ok(allowanceQueries >= 3, "launch and each model request query fresh allowance");
    t.diagnostic(JSON.stringify({ cli: "2.1.312", model_requests: captured.length, upstream_requests: delivered.length,
      auxiliary_calls: auxiliaryCalls, allowance_queries: allowanceQueries, refusal_visible: true, exit_code: exitCode,
      first_body_sha256: createHash("sha256").update(delivered[0]!).digest("hex") }));
  } catch (error) {
    const category = /unknown option|unrecognized option|invalid option/iu.test(output) ? "unknown-option"
      : /not logged in|invalid api key|authentication|login required/iu.test(output) ? "authentication"
      : /cannot be used with root|root privileges|permission denied/iu.test(output) ? "permission"
      : output.includes(refusal) ? "admission-refusal"
      : stage === "image-version" ? "image-version"
      : exitCode === null ? "timeout-or-startup" : "unclassified-cli-failure";
    t.diagnostic(JSON.stringify({ stage, category, exit_code: exitCode, exit_signal: exitSignal, error: error instanceof Error ? error.name : "UnknownError",
      model_requests: captured.length, upstream_requests: delivered.length, auxiliary_calls: auxiliaryCalls, policy_statuses: policyStatuses }));
    throw error;
  } finally {
    cli?.kill("SIGKILL");
    await close(capture); await policy?.close(); await close(remote);
    await rm(dir, { recursive: true, force: true });
  }
});
