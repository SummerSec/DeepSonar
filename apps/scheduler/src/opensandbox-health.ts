import {
  createSdkOpenSandboxClient,
  readOpenSandboxPin,
} from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";

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

async function defaultProbe(): Promise<void> {
  const pin = readOpenSandboxPin({
    sdk: config.runtime.openSandbox.sdkVersion || undefined,
    serverImage: config.runtime.openSandbox.serverImage || undefined,
    execdImage: config.runtime.openSandbox.execdImage || undefined,
    egressImage: config.runtime.openSandbox.egressImage || undefined,
  });
  const client = createSdkOpenSandboxClient({
    domain: config.runtime.openSandbox.domain,
    apiKey: config.runtime.openSandbox.apiKey,
    protocol: config.runtime.openSandbox.protocol,
    useServerProxy: config.runtime.openSandbox.useServerProxy,
    pin,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.list(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("opensandbox health timed out")), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function refreshOpenSandboxServerStatus(
  probe: () => Promise<void> = defaultProbe,
  runtime: OpenSandboxHealthRuntime = defaultRuntime(),
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
      await probe();
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
