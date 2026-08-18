import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DSH_SMOKE_MODEL,
  DSH_SMOKE_PROVIDER,
  buildDshCordisSmokeConfig,
} from "./dsh-cordis-smoke-config.mjs";

const image = process.argv[2] ?? process.env.DEEPSONAR_DSH_IMAGE ?? "deepsonar-base:ci";
const PACKAGED_BIN = "/usr/local/lib/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js";
const CONFIG_PATH = "/tmp/deepsonar-dsh-smoke/deepsonar.cordis.yml";
const DSH_HOME = "/workspace/.deepsonar-home/.dsh";
const REQUEST_TIMEOUT_MS = 20_000;
const STDERR_LIMIT_BYTES = 8 * 1024;

function fail(message, stderr = "") {
  const detail = stderr ? `\nstderr (last ${STDERR_LIMIT_BYTES} bytes max):\n${stderr}` : "";
  throw new Error(`DSH Cordis 冒烟失败：${message}${detail}`);
}

class ByteTail {
  #value = Buffer.alloc(0);

  push(chunk) {
    const next = Buffer.concat([this.#value, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.#value = next.subarray(Math.max(0, next.length - STDERR_LIMIT_BYTES));
  }

  text() {
    return this.#value.toString("utf8");
  }
}

class JsonRpcReader {
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #records = [];
  #waiters = [];
  #failure;

  push(chunk) {
    if (this.#failure) return;
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const raw = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) throw new Error("stdout 包含空 JSON-RPC 帧");
        const record = JSON.parse(line);
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("stdout JSON-RPC 帧不是对象");
        }
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.id === record.id);
        if (waiterIndex >= 0) {
          const [waiter] = this.#waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(record);
        } else {
          this.#records.push(record);
        }
      }
    } catch (error) {
      this.reject(error);
    }
  }

  finish() {
    if (this.#failure) return;
    try {
      this.#buffer += this.#decoder.decode();
      if (this.#buffer) throw new Error("stdout 以半截 JSON-RPC 帧结束");
    } catch (error) {
      this.reject(error);
    }
  }

  reject(error) {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#failure);
    }
  }

  waitForId(id) {
    if (this.#failure) return Promise.reject(this.#failure);
    const existingIndex = this.#records.findIndex((record) => record.id === id);
    if (existingIndex >= 0) return Promise.resolve(this.#records.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error(`等待 JSON-RPC 响应 ${id} 超时`));
        }, REQUEST_TIMEOUT_MS),
      };
      this.#waiters.push(waiter);
    });
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

function waitForExitWithin(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shutdown 后进程未在有界时间退出")), REQUEST_TIMEOUT_MS);
    waitForExit(child).then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function removeContainer(name) {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // --rm may already have removed a cleanly stopped container.
  }
}

async function main() {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  } catch {
    fail(`找不到镜像 ${image}`);
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "deepsonar-dsh-cordis-"));
  const configPath = path.join(root, "deepsonar.cordis.yml");
  const containerName = `deepsonar-dsh-cordis-${process.pid}`;
  writeFileSync(configPath, buildDshCordisSmokeConfig(), "utf8");
  const stderr = new ByteTail();
  const reader = new JsonRpcReader();
  let child;
  try {
    child = spawn("docker", [
      "run", "--rm", "--interactive", "--name", containerName,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--cpus", "1",
      "--memory", "1g",
      "--pids-limit", "256",
      "-v", `${configPath}:${CONFIG_PATH}:ro`,
      "-e", "HOME=/workspace/.deepsonar-home",
      "-e", `DSH_HOME=${DSH_HOME}`,
      "-e", `DSH_CORDIS_CONFIG=${CONFIG_PATH}`,
      "-e", `DSH_SESSION_ROOT=${DSH_HOME}/sessions`,
      "-e", "DSH_CWD=/workspace",
      "-e", `DSH_MODEL=${DSH_SMOKE_MODEL}`,
      "-e", "DSH_TASK_MODE=standard",
      "-e", "DSH_TELEMETRY_DISABLED=1",
      "-e", "DSH_PERMISSION_MODE=danger-full-access",
      "-e", "DSH_SYSTEM_PROMPT=DeepSonar Cordis boot smoke",
      "-e", "DEEPSONAR_GATEWAY_TOKEN=offline-boot-smoke",
      image,
      "node", PACKAGED_BIN, CONFIG_PATH,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => reader.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reader.reject(error));
    child.on("close", (code, signal) => {
      reader.finish();
      if (code !== 0) reader.reject(new Error(`packaged-bin 提前退出：exit=${code ?? "null"} signal=${signal ?? "none"}`));
    });

    const initializeId = "deepsonar-smoke-initialize";
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: { cwd: "/workspace", provider: DSH_SMOKE_PROVIDER, model: DSH_SMOKE_MODEL },
    })}\n`);
    const initialized = await reader.waitForId(initializeId);
    if (initialized.error) fail(`initialize 返回错误：${JSON.stringify(initialized.error).slice(0, 1000)}`, stderr.text());
    if (initialized.result?.serverInfo?.name !== "deepseek-harness-sdk-runtime") {
      fail(`initialize server identity 无效：${JSON.stringify(initialized.result).slice(0, 1000)}`, stderr.text());
    }

    const shutdownId = "deepsonar-smoke-shutdown";
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: shutdownId, method: "shutdown", params: {} })}\n`);
    const shutdown = await reader.waitForId(shutdownId);
    if (shutdown.error) fail(`shutdown 返回错误：${JSON.stringify(shutdown.error).slice(0, 1000)}`, stderr.text());
    child.stdin.end();
    const outcome = await waitForExitWithin(child);
    if (outcome.code !== 0) {
      fail(`shutdown 未干净退出：exit=${outcome.code ?? "null"} signal=${outcome.signal ?? "none"}`, stderr.text());
    }
    console.log(`DSH Cordis real Docker smoke passed: image=${image}, initialize=accepted, shutdown=clean`);
  } catch (error) {
    removeContainer(containerName);
    if (error instanceof Error && error.message.startsWith("DSH Cordis 冒烟失败：")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    fail(message, stderr.text());
  } finally {
    if (child && child.exitCode === null) removeContainer(containerName);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
