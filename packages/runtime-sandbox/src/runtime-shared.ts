/**
 * Provider-neutral runtime primitives for OpenSandbox and host Docker helpers.
 */

import path from "node:path";

export const DEEPSONAR_GATEWAY_PROXY_HOST = "deepsonar-gateway-proxy";
export const SHARED_ASSETS_MOUNT_PATH = "/workspace/.deepsonar/shared";
export const SHARED_ASSETS_VOLUME_LABEL = "deepsonar.shared_assets.managed";
export const SHARED_ASSETS_JOB_LABEL = "deepsonar.shared_assets.job";
const SHARED_ASSETS_VOLUME_RE = /^deepsonar-assets-[a-z0-9][a-z0-9_.-]{0,62}$/;
export const WORKSPACE_RESERVED_ROOTS = [
  "/workspace/.deepsonar",
  "/workspace/.deepsonar-home",
  SHARED_ASSETS_MOUNT_PATH,
  "/workspace/.claude",
  "/workspace/.codex",
  "/workspace/.opencode",
] as const;

export function assertReadableWorkspacePath(filePath: string): void {
  if (
    !filePath.startsWith("/workspace/") ||
    WORKSPACE_RESERVED_ROOTS.some((root) => filePath === root || filePath.startsWith(`${root}/`))
  ) {
    throw new Error("shared_asset_source_path_forbidden");
  }
}

export class RuntimeImageContractError extends Error {
  readonly code = "RUNTIME_IMAGE_CONTRACT";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeImageContractError";
  }
}

/**
 * 解析运行时 tool-manifest。部分已发布 OH 镜像在合法 JSON 后多了字面量 `\n`
 *（Dockerfile 单引号里写了 +"\\n"），严格 parse 会报
 * "Unexpected non-whitespace character after JSON"。
 */
export function parseToolManifest(raw: string): { contract?: string } {
  const text = raw.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(text) as { contract?: string };
  } catch (first) {
    const stripped = text.replace(/(?:\\n)+\s*$/g, "").trim();
    if (stripped !== text) {
      try {
        return JSON.parse(stripped) as { contract?: string };
      } catch {
        /* fall through */
      }
    }
    const start = text.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i]!;
        if (inString) {
          if (escape) escape = false;
          else if (ch === "\\") escape = true;
          else if (ch === "\"") inString = false;
          continue;
        }
        if (ch === "\"") {
          inString = true;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return JSON.parse(text.slice(start, i + 1)) as { contract?: string };
          }
        }
      }
    }
    throw first instanceof Error ? first : new Error(String(first));
  }
}

interface SharedAssetsVolumeInspection {
  Name?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Labels?: unknown;
}

/** Validate daemon-owned metadata before Docker can auto-create a typoed volume. */
export function assertSharedAssetsVolumeOwnership(
  inspected: SharedAssetsVolumeInspection,
  volumeName: string,
  jobId: string,
): void {
  const labels = inspected.Labels && typeof inspected.Labels === "object"
    ? inspected.Labels as Record<string, unknown>
    : {};
  if (
    inspected.Name !== volumeName ||
    inspected.Driver !== "local" ||
    inspected.Scope !== "local" ||
    labels[SHARED_ASSETS_VOLUME_LABEL] !== "true" ||
    labels[SHARED_ASSETS_JOB_LABEL] !== jobId
  ) {
    throw new Error("shared assets volume is not a local Scheduler-managed volume for this Job");
  }
}

const HUMAN_INBOX_PATH =
  /^\/workspace\/\.deepsonar\/inbox\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]{1,240})$/iu;

/** Scheduler-owned inbox path: exact `/workspace/.deepsonar/inbox/<uuid>/<filename>`. */
export function parseHumanInboxWorkspacePath(filePath: string): { messageId: string; filename: string } {
  const normalized = path.posix.normalize(filePath);
  const match = HUMAN_INBOX_PATH.exec(filePath);
  if (normalized !== filePath || !match) throw new Error("human_message_workspace_path_forbidden");
  return { messageId: match[1]!, filename: match[2]! };
}

export const HUMAN_INBOX_WRITER_SCRIPT = String.raw`
import os
import sys

workspace, message_id, filename = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = []
try:
    current = os.open(workspace, flags)
    fds.append(current)
    for component in (".deepsonar", "inbox", message_id):
        try:
            os.mkdir(component, 0o700, dir_fd=current)
        except FileExistsError:
            pass
        child = os.open(component, flags, dir_fd=current)
        fds.append(child)
        current = child
    output = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=current)
    try:
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(output, view)
                view = view[written:]
        os.fsync(output)
    finally:
        os.close(output)
finally:
    for descriptor in reversed(fds):
        os.close(descriptor)
`;

export function terminalShellCommand(shell: "bash" | "sh"): string {
  return shell === "bash" ? "exec bash -il" : "exec /bin/sh -i";
}

export function buildTerminalShellCommand(): string {
  return [
    "if command -v bash >/dev/null 2>&1; then",
    `${terminalShellCommand("bash")};`,
    "else",
    `${terminalShellCommand("sh")};`,
    "fi",
  ].join(" ");
}

export async function writeTerminalInput(
  process: { write?: (input: string) => Promise<void> },
  data: string,
): Promise<void> {
  if (!process.write) throw new Error("TERMINAL_SESSION_CLOSED");
  await process.write(data);
}

export function sharedAssetsVolumeBinds(mount?: { volumeName: string }): string[] {
  if (!mount) return [];
  if (!SHARED_ASSETS_VOLUME_RE.test(mount.volumeName)) {
    throw new Error("shared assets volume must be a Scheduler-owned deepsonar-assets-* named volume");
  }
  return [`${mount.volumeName}:${SHARED_ASSETS_MOUNT_PATH}:ro`];
}

/** Guest /proc/mounts must contain the frozen shared-assets path; an empty host dir is not enough. */
export function assertSharedAssetsGuestMount(procMounts: string, mountPath = SHARED_ASSETS_MOUNT_PATH): void {
  const found = procMounts.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === mountPath;
  });
  if (!found) throw new RuntimeImageContractError("shared assets volume was not mounted");
}

export function assertSharedAssetsContainerMount(
  inspected: { Mounts?: unknown },
  volumeName: string,
): void {
  const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts : [];
  const targetMounts = mounts.filter((entry) => (
    entry && typeof entry === "object"
    && (entry as Record<string, unknown>).Destination === SHARED_ASSETS_MOUNT_PATH
  ));
  const mount = targetMounts[0] as Record<string, unknown> | undefined;
  if (
    targetMounts.length !== 1
    || mount?.Type !== "volume"
    || mount?.Name !== volumeName
    || mount?.RW !== false
  ) {
    throw new Error("sandbox shared assets mount does not match the frozen read-only volume");
  }
}

export function bindProvisionAbortSignal(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => {};
  let handled = false;
  const abort = () => {
    if (handled) return;
    handled = true;
    onAbort();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}
