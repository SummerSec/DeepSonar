#!/usr/bin/env node
/**
 * Worker-join heartbeat agent. Registers with the control-plane Scheduler
 * using DEEPSONAR_WORKER_BOOTSTRAP_TOKEN, then heartbeats with the node token.
 */
import { hostname } from "node:os";

const controlPlane = required("DEEPSONAR_CONTROL_PLANE").replace(/\/+$/, "");
const bootstrap = required("DEEPSONAR_WORKER_BOOTSTRAP_TOKEN");
const nodeId = process.env.DEEPSONAR_WORKER_NODE_ID?.trim() || hostnameId();
const endpoint = required("DEEPSONAR_WORKER_ENDPOINT");
const apiKey = required("OPEN_SANDBOX_API_KEY");
const protocol = process.env.OPEN_SANDBOX_PROTOCOL === "https" ? "https" : "http";
const intervalSec = Math.max(5, Number(process.env.DEEPSONAR_WORKER_HEARTBEAT_SEC) || 15);
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
    throw new Error(`${path} ${response.status}: ${json.error_code || json.error || text}`);
  }
  return json;
}

async function main() {
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
  console.log(`[worker-agent] registered ${nodeId} -> ${controlPlane}`);
  for (;;) {
    try {
      await post("/workers/heartbeat", nodeToken, {
        node_id: nodeId,
        endpoint,
        protocol,
        opensandbox_api_key: apiKey,
        capacity,
      });
    } catch (error) {
      console.error(`[worker-agent] heartbeat failed: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch((error) => {
  console.error(`[worker-agent] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
