import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DSH_BIN, DSH_PROFILE, DSH_PROFILE_MANIFEST, DSH_SMOKE_MODEL, DSH_SMOKE_PROVIDER, buildDshCordisSmokeConfig } from "./dsh-cordis-smoke-config.mjs";

const bin = process.argv[2] ?? DSH_BIN;
const root = mkdtempSync(path.join(os.tmpdir(), "deepsonar-dsh-sdk-"));
const token = "offline-sdk-smoke";
const records = [];
const requests = [];
let phase = "standard";
let requestIndex = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push(data);
    assert.equal(data.model, DSH_SMOKE_MODEL);
    assert.equal(data.reasoning_effort, "high");
    const names = (data.tools ?? []).map((tool) => tool.function.name);
    assert.ok(!names.some((name) => /ask_user|web_|plugin|schedule/.test(name)), `unexpected tool: ${names}`);
    const child = phase === "subagent" && data.messages.some((message) => message.role === "user" && message.content === "child-smoke");
    const callTool = !child && phase !== "restore" && phase !== "followup" && requestIndex++ === 0;
    let delta;
    if (callTool) {
      const name = phase === "ptc" ? "run_code" : phase === "subagent" ? "subagent" : "bash";
      assert.ok(names.includes(name), `missing ${name}: ${names}`);
      if (phase === "ptc") assert.ok(!names.includes("bash"));
      const args = phase === "subagent" ? { description: "Check inherited gateway route", prompt: "child-smoke", run_in_background: false } : phase === "ptc"
        ? { code: "console.log('ptc-verified')", description: "Check the isolated PTC runtime" }
        : { command: "printf standard-verified", description: "Check the isolated SDK shell" };
      delta = { role: "assistant", tool_calls: [{ index: 0, id: "smoke-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    } else {
      if (phase === "followup") assert.ok(data.messages.some((message) => message.role === "assistant" && message.content?.includes("standard-final")), "restored request lost prior assistant output");
      delta = { role: "assistant", reasoning_content: "smoke reasoning", content: child ? "child-verified" : `${phase}-final` };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: DSH_SMOKE_MODEL, choices: [{ index: 0, delta, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }];
    chunk.usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});

async function run(taskMode, home, sessionId) {
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const profile = path.join(home, "profiles", DSH_PROFILE);
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "package.json"), DSH_PROFILE_MANIFEST);
  writeFileSync(path.join(profile, "cordis.patch.yml"), buildDshCordisSmokeConfig({ cwd, home, taskMode, baseURL: `http://127.0.0.1:${server.address().port}/v1` }));
  writeFileSync(path.join(home, "cordis.patch.yml"), "[]\n");
  const child = spawn(process.execPath, [bin, "--profile", DSH_PROFILE], {
    cwd, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", DEEPSONAR_GATEWAY_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let stderr = "", buffer = "", sequence = 0;
  let settled;
  let idle = new Promise((resolve, reject) => { settled = { resolve, reject }; });
  const timeout = setTimeout(() => { settled.reject(new Error(`SDK smoke timed out: ${stderr}`)); child.kill("SIGKILL"); }, 20_000);
  child.stderr.on("data", (value) => { stderr = (stderr + value).slice(-8192); });
  child.stdout.on("data", (value) => {
    buffer += value;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n"), line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const record = JSON.parse(line); records.push(record);
        if (record.id) {
          const waiter = pending.get(record.id);
          if (waiter) { pending.delete(record.id); record.error ? waiter.reject(new Error(JSON.stringify(record.error))) : waiter.resolve(record.result); }
        }
        if (record.method === "session.status" && record.params.sessionId === sessionId && record.params.status === "idle") settled.resolve();
      } catch (error) { settled.reject(error); }
    }
  });
  const exit = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => { if (code !== 0) reject(new Error(`SDK exited ${code}: ${stderr}`)); else resolve(); }); });
  exit.catch((error) => { settled.reject(error); for (const waiter of pending.values()) waiter.reject(error); });
  function request(method, params) {
    const id = `smoke-${++sequence}`;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  }
  try {
    const initialized = await request("initialize", { cwd, provider: DSH_SMOKE_PROVIDER, model: DSH_SMOKE_MODEL });
    assert.equal(initialized.serverInfo.name, "deepseek-harness-sdk-runtime");
    assert.equal(initialized.serverInfo.version, "0.0.1");
    if (phase === "restore") {
      await assert.rejects(request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: "resume must fail closed" }] }), /already exists/);
      await request("shutdown", {});
      await exit;
      return [];
    }
    const receipt = await request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: `${phase} smoke` }] });
    assert.equal(typeof receipt.messageId, "string");
    await idle;
    if (phase === "standard") {
      phase = "followup";
      idle = new Promise((resolve, reject) => { settled = { resolve, reject }; });
      await request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: "same-session followup" }] });
      await idle;
      phase = "standard";
    }
    await request("shutdown", {});
    await exit;
    assert.equal(buffer, "");
    assert.doesNotMatch(stderr, /did not activate|startup failed|ValidationError|pending \(waiting/);
    const events = records.filter((record) => record.method === "session.event" && record.params.sessionId === sessionId).map((record) => record.params.event);
    assert.ok(events.some((event) => event.type === "assistant/message" && event.data.message.content.some((block) => block.text === `${phase}-final`)));
    assert.ok(!events.some((event) => event.type === "turn/end" && !["completed", "max-tokens"].includes(event.data.reason.kind)));
    if (phase !== "restore") {
      const result = events.find((event) => event.type === "tool/result");
      assert.ok(result, "real tool result missing");
      assert.ok(!result.data.error, `tool failed: ${JSON.stringify(result.data)}`);
      if (phase === "subagent") {
        // 0.2.1-rc.2 起 governed `subagent` 是 continuable：tool/result 只回
        // "started subagent <id>"，子代理的最终文本随子会话事件到达，因此改查整条记录流。
        assert.match(JSON.stringify(records), /child-verified/, "subagent child result missing from the event stream");
      } else {
        assert.match(JSON.stringify(result), phase === "ptc" ? /ptc-verified/ : /standard-verified/);
      }
    }
    return events;
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); }
}
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = path.join(root, "standard-home");
  await run("standard", home, "session-smoke-standard");
  const archive = files(path.join(home, "sessions")).find((file) => file.endsWith("/session-smoke-standard/session.v4.jsonl"));
  assert.ok(archive, "format-v4 session archive missing");
  const before = readFileSync(archive, "utf8");
  phase = "restore"; requestIndex = 0;
  await run("standard", home, "session-smoke-standard");
  assert.equal(readFileSync(archive, "utf8"), before, "rejected resume rewrote history");
  phase = "ptc"; requestIndex = 0;
  await run("ptc", path.join(root, "ptc-home"), "session-smoke-ptc");
  phase = "subagent"; requestIndex = 0;
  await run("standard", path.join(root, "subagent-home"), "session-smoke-subagent");
  if (process.env.DEEPSONAR_DSH_CAPTURE) writeFileSync(process.env.DEEPSONAR_DSH_CAPTURE, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  console.log(`DSH SDK smoke passed: native bash, PTC run_code, native subagent gateway/model/reasoning inheritance, gateway token, in-process followup, v4 persistence, cross-process resume rejection, shutdown (${requests.length} requests)`);
} finally { server.close(); rmSync(root, { recursive: true, force: true }); }
