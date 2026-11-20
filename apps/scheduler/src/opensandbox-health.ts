import { config } from "./config.js";
import { workerIsDispatchable } from "./domains/worker-nodes/model.js";
import { listWorkerNodes, workerStaleAfterMs } from "./domains/worker-nodes/registry.js";

export type OpenSandboxServerLevel = "ok" | "error" | "unconfigured" | "skipped";

export interface OpenSandboxServerStatus {
  level: OpenSandboxServerLevel;
  domain: string;
  checkedAt: string | null;
  error: string | null;
}

export type OpenSandboxHealthRuntime = {
  agentMode: string;
  provider: string;
  domain: string;
  apiKey: string;
};

const CACHE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Extra attempts after the first failure; total tries = 1 + length. */
const DEFAULT_PROBE_RETRY_DELAYS_MS = [150, 150] as const;

let current: OpenSandboxServerStatus = {
  level: "skipped",
  domain: "",
  checkedAt: null,
  error: null,
};
let checkedAtMs = 0;
let refreshRunning: Promise<OpenSandboxServerStatus> | null = null;

export function openSandboxServerStatus(): OpenSandboxServerStatus {
  return { ...current };
}

export function openSandboxAllowsDispatch(status: OpenSandboxServerStatus = current): boolean {
  return status.level === "ok" || status.level === "skipped";
}

export function resetOpenSandboxServerStatusForTests(): void {
  current = { level: "skipped", domain: "", checkedAt: null, error: null };
  checkedAtMs = 0;
  refreshRunning = null;
}

export function sanitizeOpenSandboxHealthError(error: unknown, apiKey: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [apiKey, process.env.OPEN_SANDBOX_API_KEY ?? ""].filter((value) => value.length > 0);
  for (const secret of secrets) message = message.split(secret).join("<redacted>");
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function defaultRuntime(): OpenSandboxHealthRuntime {
  return {
    agentMode: config.runtime.agentMode,
    provider: config.runtime.provider,
    domain: config.runtime.openSandbox.domain,
    apiKey: config.runtime.openSandbox.apiKey,
  };
}

/** Same authenticated, read-only List contract as deploy/opensandbox/management-health.py.
 * A healthy management API does not prove sandbox creation or clear the create circuit. */
export async function probeOpenSandboxManagement(input: { domain: string; apiKey: string; protocol: string }): Promise<void> {
  if (!input.apiKey.trim()) throw new Error("OPENSANDBOX_MANAGEMENT_KEY_MISSING");
  try {
    const response = await fetch(`${input.protocol}://${input.domain}/v1/sandboxes?page=1&pageSize=1`, {
      method: "GET", headers: { "OPEN-SANDBOX-API-KEY": input.apiKey }, redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("management List failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing List response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65536) throw new Error("oversized List response");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items)) throw new Error("invalid List response");
  } catch {
    throw new Error("OPENSANDBOX_MANAGEMENT_UNAVAILABLE");
  }
}

async function defaultProbe(): Promise<void> {
  await probeOpenSandboxManagement(config.runtime.openSandbox);
}

export type OpenSandboxHealthRefreshOptions = {
  /** Delays between retries after a failed probe; empty = single attempt. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function probeWithBoundedRetries(
  probe: () => Promise<void>,
  options: OpenSandboxHealthRefreshOptions = {},
): Promise<void> {
  const delays = options.retryDelaysMs ?? DEFAULT_PROBE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepMs;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length) break;
      await sleep(delays[attempt]!);
    }
  }
  throw lastError;
}

export async function refreshOpenSandboxServerStatus(
  probe: () => Promise<void> = defaultProbe,
  runtime: OpenSandboxHealthRuntime = defaultRuntime(),
  options: OpenSandboxHealthRefreshOptions = {},
): Promise<OpenSandboxServerStatus> {
  if (runtime.agentMode !== "real" || runtime.provider !== "opensandbox") {
    current = { level: "skipped", domain: runtime.domain, checkedAt: null, error: null };
    return { ...current };
  }
  if (refreshRunning) return refreshRunning;
  if (
    current.level !== "skipped"
    && current.domain === runtime.domain
    && Date.now() - checkedAtMs < CACHE_MS
  ) {
    return { ...current };
  }
  refreshRunning = (async () => {
    const checkedAt = new Date().toISOString();
    if (probe === defaultProbe && runtime.provider === "opensandbox" && !config.runtime.openSandbox.kubernetes) {
      try {
        const now = Date.now();
        const staleAfterMs = workerStaleAfterMs();
        const ready = (await listWorkerNodes()).filter((node) => workerIsDispatchable(node, now, staleAfterMs));
        const remotes = ready.filter((node) => node.kind === "remote");
        if (remotes.length > 0) {
          current = {
            level: "ok",
            domain: remotes.length === 1 ? remotes[0]!.endpoint : "registry",
            checkedAt,
            error: null,
          };
          checkedAtMs = Date.now();
          return { ...current };
        }
      } catch {
        /* fall through to the single-endpoint probe */
      }
    }
    if (!runtime.apiKey.trim()) {
      current = {
        level: "unconfigured",
        domain: runtime.domain,
        checkedAt,
        error: "OPEN_SANDBOX_API_KEY missing",
      };
      checkedAtMs = Date.now();
      return { ...current };
    }
    try {
      await probeWithBoundedRetries(probe, options);
      current = { level: "ok", domain: runtime.domain, checkedAt, error: null };
    } catch (error) {
      current = {
        level: "error",
        domain: runtime.domain,
        checkedAt,
        error: sanitizeOpenSandboxHealthError(error, runtime.apiKey),
      };
    }
    checkedAtMs = Date.now();
    return { ...current };
  })();
  try {
    return await refreshRunning;
  } finally {
    refreshRunning = null;
  }
}
