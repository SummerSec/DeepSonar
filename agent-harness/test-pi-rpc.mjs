import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const image = process.argv[2] ?? process.env.DEEPSONAR_PI_IMAGE ?? "deepsonar-base:ci";
const SESSION_ROOT = "/workspace/.deepsonar-home/.pi/agent";
const EXTENSION_PATH = `${SESSION_ROOT}/extensions/governed-lifecycle.mjs`;
const SMOKE_MODEL = "deepsonar-smoke/pi-rpc-smoke";
const REQUEST_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(`Pi RPC 冒烟失败：${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StrictJsonlReader {
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #queue = [];
  #waiters = [];
  #ended = false;
  #error;

  push(chunk) {
    if (this.#ended) return;
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
      while (true) {
        const index = this.#buffer.indexOf("\n");
        if (index < 0) break;
        const raw = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) throw new Error("收到空 JSONL 帧");
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
          throw new Error("收到无效 JSONL 记录");
        }
        this.#enqueue(value);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  finish() {
    if (this.#ended) return;
    try {
      this.#buffer += this.#decoder.decode();
      if (this.#buffer) throw new Error("Pi 输出以半帧结束");
      this.#ended = true;
      for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("Pi RPC 进程已结束"));
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error) {
    this.#ended = true;
    this.#error = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error);
  }

  #enqueue(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.#queue.push(value);
  }

  next(timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.#error) return Promise.reject(this.#error);
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#ended) return Promise.reject(new Error("Pi RPC 进程已结束"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("等待 Pi RPC 响应超时"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }
}

function dockerArgs(paths, sessionFile) {
  const args = [
    "run", "--rm", "--network", "none", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
    "-v", `${paths.agentDir}:${SESSION_ROOT}`,
    "-v", `${paths.governedDir}:${SESSION_ROOT}/extensions:ro`,
    "-v", `${paths.projectDir}:/workspace/.pi/extensions:ro`,
    "-v", `${paths.markerDir}:/tmp/pi-smoke`,
    "-e", "HOME=/workspace/.deepsonar-home",
    image,
    "pi", "--mode", "rpc", "--no-approve", "--offline", "--no-extensions", "--session-dir", SESSION_ROOT,
    "--model", SMOKE_MODEL, "-e", EXTENSION_PATH,
  ];
  if (sessionFile) args.push("--session", sessionFile);
  return args;
}

function startPi(paths, sessionFile) {
  const child = spawn("docker", dockerArgs(paths, sessionFile), { stdio: ["pipe", "pipe", "pipe"] });
  const reader = new StrictJsonlReader();
  const stderr = [];
  child.stdout.on("data", (chunk) => reader.push(chunk));
  child.stdout.on("end", () => reader.finish());
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("error", (error) => reader.fail(error));
  return { child, reader, stderr };
}

async function waitForResponse(runtime, command) {
  while (true) {
    const record = await runtime.reader.next();
    if (record.type === "response" && record.command === command) return record;
  }
}

async function stopPi(runtime) {
  if (runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => runtime.child.once("exit", resolve)),
    sleep(REQUEST_TIMEOUT_MS).then(() => {
      if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
    }),
  ]);
}

async function waitForMarker(marker, minimumLines) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(marker)) {
      const lines = readFileSync(marker, "utf8").split("\n").filter(Boolean);
      if (lines.length >= minimumLines) return lines;
    }
    await sleep(50);
  }
  return [];
}

async function main() {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  } catch {
    fail(`找不到镜像 ${image}；先构建并加载对应 runtime image`);
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "deepsonar-pi-rpc-"));
  const paths = {
    agentDir: path.join(root, "agent"),
    governedDir: path.join(root, "governed"),
    projectDir: path.join(root, "project"),
    markerDir: path.join(root, "markers"),
  };
  mkdirSync(paths.agentDir, { recursive: true });
  mkdirSync(paths.governedDir, { recursive: true });
  mkdirSync(paths.projectDir, { recursive: true });
  mkdirSync(paths.markerDir, { recursive: true });
  writeFileSync(path.join(paths.agentDir, "models.json"), `${JSON.stringify({
    providers: {
      "deepsonar-smoke": {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "offline-smoke-only",
        models: [{ id: "pi-rpc-smoke", name: "Pi RPC Smoke", contextWindow: 4096, maxTokens: 256 }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(paths.agentDir, "settings.json"), `${JSON.stringify({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  writeFileSync(path.join(paths.governedDir, "governed-lifecycle.mjs"), `import fs from "node:fs";
export default function (pi) {
  pi.on("session_start", () => fs.appendFileSync("/tmp/pi-smoke/governed-session-start", "started\\n"));
  pi.on("agent_end", () => fs.appendFileSync("/tmp/pi-smoke/governed-agent-end", "ended\\n"));
}
`);
  writeFileSync(path.join(paths.projectDir, "project-auto-load.mjs"), `import fs from "node:fs";
export default function (pi) {
  pi.on("session_start", () => fs.writeFileSync("/tmp/pi-smoke/project-auto-loaded", "unexpected"));
}
`);
  let runtime;
  try {
    runtime = startPi(paths);
    runtime.child.stdin.write(`${JSON.stringify({ type: "get_state", id: "first-state" })}\n`);
    const firstResponse = await waitForResponse(runtime, "get_state");
    assert(firstResponse.success === true, "首次 get_state 未成功");
    const firstState = firstResponse.data;
    assert(typeof firstState?.sessionId === "string" && firstState.sessionId.length > 0, "get_state 未返回 sessionId");
    assert(typeof firstState?.sessionFile === "string" && firstState.sessionFile.startsWith(`${SESSION_ROOT}/`), "get_state 未返回受治理 sessionFile");
    const sessionFile = firstState.sessionFile;
    const governedLines = await waitForMarker(path.join(paths.markerDir, "governed-session-start"), 1);
    assert(governedLines.length === 1, "显式受治理扩展未收到 session_start");
    assert(!existsSync(path.join(paths.markerDir, "project-auto-loaded")), "项目 .pi 扩展被自动加载");

    runtime.child.stdin.write(`${JSON.stringify({ type: "prompt", id: "offline-turn", message: "offline lifecycle smoke" })}\n`);
    let promptAccepted = false;
    let agentEnded = false;
    while (!promptAccepted || !agentEnded) {
      const record = await runtime.reader.next();
      if (record.type === "response" && record.command === "prompt") {
        assert(record.success === true, "离线失败回合未被 RPC 接受");
        promptAccepted = true;
      }
      if (record.type === "agent_end") agentEnded = true;
    }
    const agentEndLines = await waitForMarker(path.join(paths.markerDir, "governed-agent-end"), 1);
    assert(agentEndLines.length === 1, "受治理扩展未收到 agent_end");

    runtime.child.stdin.write(`${JSON.stringify({ type: "set_model", id: "invalid-model", provider: "invalid-provider", modelId: "invalid-model" })}\n`);
    const rejected = await waitForResponse(runtime, "set_model");
    assert(rejected.success === false, "无效模型请求未按 RPC 错误响应");
    runtime.child.stdin.write(`${JSON.stringify({ type: "get_state", id: "second-state" })}\n`);
    const secondResponse = await waitForResponse(runtime, "get_state");
    assert(secondResponse.success === true && secondResponse.data.sessionFile === sessionFile, "失败 RPC 后 sessionFile 发生漂移");
    runtime.child.kill("SIGKILL");
    await new Promise((resolve) => runtime.child.once("exit", resolve));
    runtime = undefined;

    runtime = startPi(paths, sessionFile);
    runtime.child.stdin.write(`${JSON.stringify({ type: "get_state", id: "resume-state" })}\n`);
    const resumed = await waitForResponse(runtime, "get_state");
    assert(resumed.success === true && resumed.data.sessionFile === sessionFile, "重启恢复未使用精确 sessionFile");
    const resumedLines = await waitForMarker(path.join(paths.markerDir, "governed-session-start"), 2);
    assert(resumedLines.length === 2, "恢复进程未再次加载受治理扩展生命周期");
    assert(!existsSync(path.join(paths.markerDir, "project-auto-loaded")), "恢复进程自动加载了项目 .pi 扩展");
    console.log(`Pi RPC real Docker smoke passed: image=${image}, sessionFile=${sessionFile}`);
  } finally {
    if (runtime) await stopPi(runtime);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
