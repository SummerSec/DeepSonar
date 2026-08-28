/**
 * Provider-neutral runtime primitives shared by Agentbox and OpenSandbox.
 * Phase 4 deletes Agentbox; these stay as the adapter-independent surface.
 */

export const DEEPSONAR_GATEWAY_PROXY_HOST = "deepsonar-gateway-proxy";
export const SHARED_ASSETS_MOUNT_PATH = "/workspace/.deepsonar/shared";
export const SHARED_ASSETS_VOLUME_LABEL = "deepsonar.shared_assets.managed";
export const SHARED_ASSETS_JOB_LABEL = "deepsonar.shared_assets.job";

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
