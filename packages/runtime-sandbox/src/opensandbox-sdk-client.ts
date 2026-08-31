/**
 * Live @alibaba-group/opensandbox binding. Provider types stay in this module.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ConnectionConfig,
  DEFAULT_EXECD_PORT,
  Sandbox,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import { WebSocket as UndiciWebSocket } from "undici";
import type { OpenSandboxClient, OpenSandboxConnection, OpenSandboxCreateInput, OpenSandboxSession } from "./opensandbox.js";
import { OPENSANDBOX_ATTEMPT_META, OPENSANDBOX_JOB_META, OPENSANDBOX_SDK_VERSION, assertOpenSandboxSdkVersion } from "./opensandbox-version.js";
import { openOpenSandboxPty } from "./opensandbox-pty.js";
import { shellQuote } from "./runtime-host.js";

export function installedOpenSandboxSdkVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@alibaba-group/opensandbox")));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@alibaba-group/opensandbox" && pkg.version) return pkg.version;
    } catch {
      /* walk up from dist/ */
    }
    dir = dirname(dir);
  }
  throw new Error("OPENSANDBOX_SDK_VERSION_UNREADABLE");
}

export function assertOpenSandboxSdkPin(sdk: string): string {
  const pinned = assertOpenSandboxSdkVersion(sdk);
  const installed = installedOpenSandboxSdkVersion();
  if (pinned !== installed) {
    throw new Error(`OPENSANDBOX_SDK_PIN_MISMATCH: pinned ${pinned}, installed ${installed}`);
  }
  return pinned;
}

function connectionConfig(connection: OpenSandboxConnection): ConnectionConfig {
  return new ConnectionConfig({
    domain: connection.domain,
    apiKey: connection.apiKey || undefined,
    protocol: connection.protocol ?? "http",
    useServerProxy: connection.useServerProxy ?? true,
    disableMetrics: true,
    requestTimeoutSeconds: 180,
  });
}

function ptyHeaders(connection: OpenSandboxConnection, extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  if (connection.apiKey && !headers["OPEN-SANDBOX-API-KEY"]) {
    headers["OPEN-SANDBOX-API-KEY"] = connection.apiKey;
  }
  return headers;
}

export function isOpenSandboxGoneError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : 0;
  const nested = "error" in error && error.error && typeof error.error === "object"
    ? String((error.error as { code?: string; message?: string }).code ?? (error.error as { message?: string }).message ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${nested} ${message}`;
  return status === 404 || status === 409
    || /SANDBOX_NOT_FOUND|already in progress/i.test(text);
}

export function joinCommandLogText(items?: Array<{ text?: string }>): string {
  const parts = (items ?? []).map((item) => item.text ?? "");
  if (parts.length === 0) return "";
  // execd /command 把每一行做成独立 log item，且 text 不含换行。
  if (parts.every((part) => !part.includes("\n"))) return parts.join("\n");
  return parts.join("");
}

export function commandWithEnv(command: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return command;
  const assigns = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  return `env ${assigns} sh -c ${shellQuote(command)}`;
}

function wrapSandbox(sandbox: Sandbox, connection: OpenSandboxConnection): OpenSandboxSession {
  return {
    id: sandbox.id,
    async run(command, options) {
      let cmd = command;
      if (options?.stdin) {
        const tmp = `/tmp/deepsonar-stdin-${randomUUID()}`;
        await sandbox.files.writeFiles([{ path: tmp, data: options.stdin }]);
        cmd = `sh -c ${shellQuote(command)} < ${shellQuote(tmp)}`;
      }
      const execution = await sandbox.commands.run(cmd, {
        workingDirectory: options?.cwd,
        timeoutSeconds: options?.timeoutMs != null ? Math.max(1, Math.ceil(options.timeoutMs / 1000)) : undefined,
        envs: options?.env,
      });
      return {
        exitCode: execution.exitCode ?? (execution.error ? 1 : 0),
        stdout: joinCommandLogText(execution.logs.stdout),
        stderr: joinCommandLogText(execution.logs.stderr),
      };
    },
    async runAsync(command, options) {
      const endpoint = await sandbox.getEndpoint(DEFAULT_EXECD_PORT);
      const headers = ptyHeaders(connection, endpoint.headers);
      return openOpenSandboxPty({
        httpUrl: `${sandbox.connectionConfig.protocol}://${endpoint.endpoint}`,
        headers,
      }, {
        cwd: options?.cwd ?? "/workspace",
        command: commandWithEnv(command, options?.env),
        pty: Boolean(options?.pty),
      }, {
        openWebSocket: (url, wsHeaders) => new UndiciWebSocket(url, { headers: wsHeaders }) as unknown as import("./opensandbox-pty.js").WebSocketLike,
      });
    },
    async writeFile(destPath, content) {
      await sandbox.files.writeFiles([{ path: destPath, data: content }]);
    },
    async readFile(filePath) {
      return Buffer.from(await sandbox.files.readBytes(filePath));
    },
    async getState() {
      return (await sandbox.getInfo()).status.state;
    },
    kill: () => sandbox.kill(),
    close: () => sandbox.close(),
  };
}

export function createSdkOpenSandboxClient(connection: OpenSandboxConnection): OpenSandboxClient {
  const pin = assertOpenSandboxSdkPin(connection.pin?.sdk ?? OPENSANDBOX_SDK_VERSION);
  void pin;
  const config = connectionConfig(connection);
  return {
    async create(input: OpenSandboxCreateInput) {
      const sandbox = await Sandbox.create({
        connectionConfig: config,
        image: input.image,
        env: input.env,
        metadata: input.metadata,
        resource: input.resource,
        timeoutSeconds: null,
        networkPolicy: input.networkPolicy,
        volumes: input.volumes,
        ...(input.platform ? { platform: input.platform } : {}),
        skipHealthCheck: false,
      });
      if (input.signal?.aborted) {
        await sandbox.kill().catch(() => undefined);
        await sandbox.close().catch(() => undefined);
        throw new Error("provision 已取消");
      }
      return wrapSandbox(sandbox, connection);
    },
    async connect(id) {
      try {
        return wrapSandbox(await Sandbox.connect({ connectionConfig: config, sandboxId: id }), connection);
      } catch {
        return undefined;
      }
    },
    async destroy(id) {
      const manager = SandboxManager.create({ connectionConfig: config });
      try {
        await manager.killSandbox(id);
      } catch (error) {
        if (!isOpenSandboxGoneError(error)) throw error;
      } finally {
        await manager.close().catch(() => undefined);
      }
    },
    async list(filter) {
      const manager = SandboxManager.create({ connectionConfig: config });
      try {
        const items = [];
        let page = 1;
        for (;;) {
          const result = await manager.listSandboxInfos({
            metadata: {
              ...(filter?.jobId ? { [OPENSANDBOX_JOB_META]: filter.jobId } : {}),
              ...(filter?.attemptId ? { [OPENSANDBOX_ATTEMPT_META]: filter.attemptId } : {}),
            },
            page,
            pageSize: 100,
          });
          items.push(...result.items);
          if (!result.pagination?.hasNextPage) break;
          page += 1;
        }
        return items.map((item) => ({
          resourceId: item.id,
          jobId: item.metadata?.[OPENSANDBOX_JOB_META] ?? "",
          attemptId: item.metadata?.[OPENSANDBOX_ATTEMPT_META] ?? "",
          state: item.status.state,
        }));
      } finally {
        await manager.close().catch(() => undefined);
      }
    },
  };
}
