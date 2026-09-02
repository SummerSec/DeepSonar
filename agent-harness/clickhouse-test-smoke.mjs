#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const launcher = process.env.CLICKHOUSE_LAUNCHER || "/opt/deepsonar/bin/clickhouse-server.sh";
const httpPort = Number(process.env.CLICKHOUSE_SMOKE_HTTP_PORT || "8123");
const dataDir = mkdtempSync(join(process.env.CLICKHOUSE_SMOKE_PATH || "/workspace", ".clickhouse-smoke-"));

function getText(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: httpPort, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`ClickHouse HTTP ${res.statusCode}: ${body}`));
        else resolve(body.trim());
      });
    });
    req.once("error", reject);
    req.end();
  });
}

const child = spawn(launcher, ["--path", dataDir, "--http-port", String(httpPort), "--tcp-port", "9000"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
try {
  let ping;
  const deadline = Date.now() + 20_000;
  while (!ping && Date.now() < deadline) {
    try { ping = await getText("/ping"); } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (ping !== "Ok.") throw new Error(`ClickHouse HTTP endpoint did not start${stderr ? `: ${stderr}` : ""}`);
  const value = await getText("/?query=SELECT%2040%20%2B%202");
  if (value !== "42") throw new Error(`ClickHouse HTTP query returned ${value}, expected 42`);
  console.log("ClickHouse Test HTTP smoke passed: SELECT 40 + 2 = 42");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
