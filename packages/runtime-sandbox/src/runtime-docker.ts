/**
 * Host Docker CLI/API helpers shared by Agentbox and the Gateway sidecar.
 * This module must not import agentbox-sdk.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONTAINER_REMOVE_MAX_ATTEMPTS = 5;
export const CONTAINER_REMOVE_RETRY_BASE_DELAY_MS = 500;
export const CONTAINER_REMOVE_TIMEOUT_MS = 120_000;

/** docker CLI 兜底（进程重启后内存注册表丢失，按持久化 sandboxId 直查引擎） */
export async function docker(...args: string[]): Promise<string> {
  return dockerTimed(15_000, args);
}

type DockerCommand = (...args: string[]) => Promise<string>;
type Sleep = (delayMs: number) => Promise<void>;

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
function isNoSuchContainerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such container|no container with name or id .* found|container .* (?:not found|does not exist)/i.test(message);
}

export async function removeContainerWithRetry(
  containerId: string,
  executeDocker: DockerCommand = (...args) => dockerTimed(CONTAINER_REMOVE_TIMEOUT_MS, args),
  wait: Sleep = sleep,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTAINER_REMOVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await executeDocker("rm", "-f", containerId);
      return;
    } catch (error) {
      if (isNoSuchContainerError(error)) return;
      lastError = error;
      if (attempt < CONTAINER_REMOVE_MAX_ATTEMPTS) {
        await wait(CONTAINER_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

export async function dockerTimed(timeoutMs: number, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileP("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = [err.stderr, err.stdout, err.message]
      .map((part) => (typeof part === "string" ? part : part?.toString?.() ?? ""))
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(detail || `docker ${args.join(" ")} failed`);
  }
}

const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";
/** Same default dockerode / Docker Desktop use on Windows. */
const DEFAULT_WINDOWS_PIPE = "//./pipe/docker_engine";

/** Resolve the Engine socket used by the scheduler host (unix socket or Windows named pipe). */
export function dockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) return host.slice("unix://".length) || DEFAULT_UNIX_SOCKET;
  if (host?.startsWith("npipe://")) return host.slice("npipe://".length) || DEFAULT_WINDOWS_PIPE;
  if (!host || host.startsWith("tcp://") || host.startsWith("http://") || host.startsWith("https://")) {
    return platform === "win32" ? DEFAULT_WINDOWS_PIPE : DEFAULT_UNIX_SOCKET;
  }
  return host;
}

/**
 * Docker Engine / Podman compatibility API over the unix socket.
 *
 * Prefer this for network inspect/create: recent docker CLI fails on Podman
 * networks whose IPAM Gateway is the literal string "<nil>" with
 * `ParseAddr("<nil>"): unable to parse IP`. The HTTP API returns usable JSON.
 */
export async function dockerApiJson(
  pathname: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
  const timeoutMs = init?.timeoutMs ?? 15_000;
  const socketPath = dockerSocketPath();
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: pathname,
        method,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            reject(new Error(`docker API ${method} ${pathname} -> ${status}: ${text.slice(0, 400)}`));
            return;
          }
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`docker API ${method} ${pathname} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** True when a network inspect payload is our managed internal bridge. */
export function isDeepsonarRestrictedNetwork(net: Record<string, unknown> | null | undefined): boolean {
  if (!net || typeof net !== "object") return false;
  const internal = net.Internal ?? net.internal;
  const driver = String(net.Driver ?? net.driver ?? "");
  const labelsRaw = net.Labels ?? net.labels;
  const labels = labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
    ? labelsRaw as Record<string, unknown>
    : {};
  return internal === true && driver === "bridge" && String(labels["deepsonar.managed"] ?? "") === "true";
}

/** True when a network is the Scheduler-owned NAT bridge for real sandboxes. */
export function isDeepsonarGatewayNetwork(net: Record<string, unknown> | null | undefined): boolean {
  if (!net || typeof net !== "object") return false;
  const internal = net.Internal ?? net.internal;
  const driver = String(net.Driver ?? net.driver ?? "");
  const labelsRaw = net.Labels ?? net.labels;
  const labels = labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
    ? labelsRaw as Record<string, unknown>
    : {};
  return internal !== true && driver === "bridge" && String(labels["deepsonar.managed"] ?? "") === "true";
}
export interface DeepSonarContainer {
  containerId: string;
  jobId: string;
  attemptId: string;
  state: string;
}

export function parseDeepSonarContainerRows(out: string): DeepSonarContainer[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [containerId = "", labels = "", state = ""] = line.split("\t");
      const jobId = labels
        .split(",")
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith("deepsonar.job="))
        ?.slice("deepsonar.job=".length);
      const attemptId = labels
        .split(",")
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith("deepsonar.attempt="))
        ?.slice("deepsonar.attempt=".length);
      return {
        containerId,
        jobId: CANONICAL_UUID_RE.test(jobId ?? "") ? jobId!.toLowerCase() : "",
        attemptId: CANONICAL_UUID_RE.test(attemptId ?? "") ? attemptId!.toLowerCase() : "",
        state,
      };
    })
    .filter((container) => container.containerId && container.jobId && container.attemptId);
}

/** 只枚举同时带 canonical Job/Attempt 双标签的容器（含已退出）。 */
export async function listDeepSonarContainers(): Promise<DeepSonarContainer[]> {
  // 注意：docker ps 的 .Labels 是字符串（非 map），不能直接 index，取回后自行解析。
  const out = await docker(
    "ps", "-a",
    "--filter", "label=deepsonar.job",
    "--filter", "label=deepsonar.attempt",
    "--format", "{{.ID}}\t{{.Labels}}\t{{.State}}",
  );
  return parseDeepSonarContainerRows(out);
}

/** 强删容器（孤儿回收） */
export async function forceRemoveContainer(containerId: string): Promise<void> {
  await removeContainerWithRetry(containerId);
}
