#!/usr/bin/env node
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createRequire } from "node:module";

const port = Number(process.env.CHROME_SMOKE_PORT || "9222");
const launcher = process.env.CHROME_LAUNCHER || "/opt/deepsonar/bin/chrome-headless.sh";
const nodePath = process.env.NODE_PATH || "/usr/local/lib/node_modules";
const require = createRequire(`${nodePath}/playwright-core/package.json`);
const playwright = require("playwright-core");

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`CDP HTTP ${res.statusCode}`));
        else {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        }
      });
    });
    req.once("error", reject);
    req.end();
  });
}

const child = spawn(launcher, ["--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_PATH: nodePath },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
try {
  let version;
  const deadline = Date.now() + 20_000;
  while (!version && Date.now() < deadline) {
    try { version = await getJson("/json/version"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!version?.Browser) throw new Error(`Chromium CDP endpoint did not start${stderr ? `: ${stderr}` : ""}`);
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  await page.goto("data:text/html,<title>deepsonar-chrome-smoke</title><main id=ok>ok</main>");
  if (await page.title() !== "deepsonar-chrome-smoke" || await page.locator("#ok").textContent() !== "ok") {
    throw new Error("Chromium CDP page assertion failed");
  }
  await browser.close();
  console.log(`Chrome Test smoke passed: ${version.Browser}`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
}
