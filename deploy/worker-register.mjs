#!/usr/bin/env node
/**
 * Worker-join heartbeat agent. Registers with the control-plane Scheduler
 * using DEEPSONAR_WORKER_BOOTSTRAP_TOKEN, persists the node token, then
 * heartbeats. Same node_id cannot silently take over an existing node.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

const controlPlane = required("DEEPSONAR_CONTROL_PLANE").replace(/\/+$/, "");
const bootstrap = required("DEEPSONAR_WORKER_BOOTSTRAP_TOKEN");
const nodeId = process.env.DEEPSONAR_WORKER_NODE_ID?.trim() || hostnameId();
const endpoint = required("DEEPSONAR_WORKER_ENDPOINT");
const apiKey = required("OPEN_SANDBOX_API_KEY");
const protocol = process.env.OPEN_SANDBOX_PROTOCOL === "https" ? "https" : "http";
const intervalSec = Math.max(5, Number(process.env.DEEPSONAR_WORKER_HEARTBEAT_SEC) || 15);
const tokenFile = process.env.DEEPSONAR_WORKER_TOKEN_FILE?.trim() || "/var/lib/deepsonar-worker/node.token";
const capacity = {
  max_sandboxes: intEnv("DEEPSONAR_WORKER_MAX_SANDBOXES", 8),
  memory_mib: intEnv("DEEPSONAR_WORKER_MEMORY_MIB", 16384),
  cpu: intEnv("DEEPSONAR_WORKER_CPU", 8),
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[worker-agent] missing ${name}`);
    process.exit(1);
  }
  return value;
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function hostnameId() {
  return String(hostname()).replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 64) || "worker";
}

function readPersistedToken() {
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    return token || "";
  } catch {
    return "";
  }
}

function persistToken(token) {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

async function post(path, token, body) {
  const response = await fetch(`${controlPlane}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!response.ok) {
    const error = new Error(`${path} ${response.status}: ${json.error_code || json.error || text}`);
    error.status = response.status;
    error.code = json.error_code;
    throw error;
  }
  return json;
}

async function heartbeat(token) {
  await post("/workers/heartbeat", token, {
    node_id: nodeId,
    opensandbox_api_key: apiKey,
    capacity,
  });
}

async function register() {
  const registered = await post("/workers/register", bootstrap, {
    node_id: nodeId,
    endpoint,
    protocol,
    opensandbox_api_key: apiKey,
    capacity,
    labels: { kind: "remote" },
  });
  const nodeToken = registered.node_token;
  if (!nodeToken) throw new Error("register did not return node_token");
  persistToken(nodeToken);
  return nodeToken;
}

async function resolveToken() {
  const persisted = readPersistedToken();
  if (persisted) {
    try {
      await heartbeat(persisted);
      return persisted;
    } catch (error) {
      if (error?.status !== 401 && error?.code !== "WORKER_NODE_TOKEN_INVALID") {
        throw error;
      }
    }
  }
  try {
    return await register();
  } catch (error) {
    if (error?.code === "WORKER_NODE_EXISTS" || error?.status === 409) {
      throw new Error(`${nodeId} already registered; reuse the persisted node token or admin DELETE /workers/${nodeId} before reclaiming`);
    }
    throw error;
  }
}

async function main() {
  const nodeToken = await resolveToken();
  console.log(`[worker-agent] online ${nodeId} -> ${controlPlane}`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
    try {
      await heartbeat(nodeToken);
    } catch (error) {
      console.error(`[worker-agent] heartbeat failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

main().catch((error) => {
  console.error(`[worker-agent] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
